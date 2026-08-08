import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type {
  ConversationTurnMessage,
  CoreSkillClient,
} from "../skill/core-client.js";
import type { TdaiClient } from "../tdai/client.js";
import type {
  TdaiConversationReceipt,
  TdaiMessage,
} from "../tdai/types.js";

export type OutboxState = "pending" | "inflight" | "committed" | "dead";

export interface CompletedRoundIdentity {
  serviceId: string;
  teamId: string;
  userId: string;
  agentId: string;
  taskId?: string;
  agentSource: string;
  sessionId: string;
  turnId: string;
}

export interface CompletedRound {
  sourceEventId: string;
  identity: CompletedRoundIdentity;
  l0: { messages: TdaiMessage[] };
  skill: { messages: ConversationTurnMessage[] };
  /** Omitted by legacy callers, which means both delivery channels are enabled. */
  channels?: { l0: boolean; skill: boolean };
}

export interface L0RoundDelivery {
  sourceEventId: string;
  contentHash: string;
  identity: CompletedRoundIdentity;
  messages: TdaiMessage[];
}

export interface SkillRoundDelivery {
  sourceEventId: string;
  contentHash: string;
  identity: CompletedRoundIdentity;
  messages: ConversationTurnMessage[];
}

export interface RoundDeliveryPort {
  deliverL0(input: L0RoundDelivery): Promise<DeliveryReceipt>;
  deliverSkill(input: SkillRoundDelivery): Promise<DeliveryReceipt>;
}

export interface DeliveryReceipt {
  sourceEventId: string;
  contentHash: string;
  receiptId: string;
  status: "committed" | "duplicate";
}

export interface OutboxRecord {
  sourceEventId: string;
  contentHash: string;
  state: OutboxState;
  attemptCount: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface OutboxHealth {
  pendingCount: number;
  inflightCount: number;
  retryingCount: number;
  deadCount: number;
  oldestPendingAgeMs: number;
  nextRetryAt?: number;
  workerErrorKind?: string;
}

export interface OpenDurableRoundOutboxOptions {
  dbPath: string;
  delivery: RoundDeliveryPort;
  now?: () => number;
  random?: () => number;
  retry?: {
    baseMs?: number;
    capMs?: number;
    jitterMs?: number;
    maxAttempts?: number;
  };
}

interface OutboxRow {
  sequence: number;
  source_event_id: string;
  round_key: string;
  content_hash: string;
  isolation_key: string;
  ordering_key: string;
  turn_id: string;
  payload_json: string;
  l0_source_event_id: string;
  l0_content_hash: string;
  skill_source_event_id: string;
  skill_content_hash: string;
  state: OutboxState;
  attempt_count: number;
  next_attempt_at: number;
  l0_receipt_json: string | null;
  skill_receipt_json: string | null;
  created_at: number;
  updated_at: number;
}

const OUTBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS completed_round_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  source_event_id TEXT NOT NULL UNIQUE,
  round_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  isolation_key TEXT NOT NULL,
  ordering_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  l0_source_event_id TEXT NOT NULL UNIQUE,
  l0_content_hash TEXT NOT NULL,
  skill_source_event_id TEXT NOT NULL UNIQUE,
  skill_content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'committed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  l0_receipt_json TEXT,
  skill_receipt_json TEXT,
  last_error_kind TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS completed_round_outbox_ready
  ON completed_round_outbox(state, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS completed_round_outbox_session
  ON completed_round_outbox(ordering_key, sequence);
`;

export class OutboxConflictError extends Error {
  constructor(readonly sourceEventId: string) {
    super(`Outbox event ${sourceEventId} was already persisted with different content`);
    this.name = "OutboxConflictError";
  }
}

export class MemoryCoreRoundDelivery implements RoundDeliveryPort {
  constructor(
    private readonly l0Client: Pick<TdaiClient, "addConversation">,
    private readonly skillClient: Pick<CoreSkillClient, "addConversation">,
    private readonly l0ServiceId: string,
  ) {}

  async deliverL0(input: L0RoundDelivery): Promise<DeliveryReceipt> {
    if (input.identity.serviceId !== this.l0ServiceId) {
      throw new OutboxConfigurationError("l0_service_mismatch");
    }
    const result = await this.l0Client.addConversation(
      {
        teamId: input.identity.teamId,
        userId: input.identity.userId,
        agentId: input.identity.agentId,
        taskId: input.identity.taskId,
        sessionId: input.identity.sessionId,
      },
      input.messages,
      { sourceEventId: input.sourceEventId, contentHash: input.contentHash },
    );
    validateL0Receipts(result.receipts, input.sourceEventId);
    return {
      sourceEventId: input.sourceEventId,
      contentHash: input.contentHash,
      receiptId: sha256(canonicalJson(result.receipts)),
      status: result.receipts.every((receipt) => receipt.status === "duplicate")
        ? "duplicate"
        : "committed",
    };
  }

  async deliverSkill(input: SkillRoundDelivery): Promise<DeliveryReceipt> {
    const result = await this.skillClient.addConversation(
      {
        session_id: input.identity.sessionId,
        space_id: input.identity.serviceId,
        user_id: input.identity.userId,
        team_id: input.identity.teamId,
        agent_id: input.identity.agentId,
        task_id: input.identity.taskId,
        source_event_id: input.sourceEventId,
        content_hash: input.contentHash,
        messages: input.messages,
      },
      { serviceId: input.identity.serviceId },
    );
    if (
      result.receipt.source_event_id !== input.sourceEventId ||
      result.receipt.content_hash !== input.contentHash
    ) {
      throw new RetryableOutboxDeliveryError("skill_receipt_mismatch");
    }
    return {
      sourceEventId: input.sourceEventId,
      contentHash: input.contentHash,
      receiptId: result.receipt.receipt_id,
      status: "committed",
    };
  }
}

export class DurableRoundOutbox {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private readonly retryJitterMs: number;
  private readonly maxAttempts: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private activeDrain: Promise<{ committed: number; retried: number; dead: number }> | null = null;
  private workerErrorKind: string | undefined;
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly delivery: RoundDeliveryPort,
    options: Pick<OpenDurableRoundOutboxOptions, "now" | "random" | "retry"> = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.retryBaseMs = Math.max(1, options.retry?.baseMs ?? 500);
    this.retryCapMs = Math.max(this.retryBaseMs, options.retry?.capMs ?? 30_000);
    this.retryJitterMs = Math.max(0, options.retry?.jitterMs ?? 200);
    this.maxAttempts = Math.max(1, Math.floor(options.retry?.maxAttempts ?? 8));

    const now = this.now();
    this.db.prepare(`
      UPDATE completed_round_outbox
      SET state = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE state = 'inflight'
    `).run(now, now);
  }

  async enqueue(round: CompletedRound): Promise<OutboxRecord> {
    this.assertOpen();
    const normalizedRound = parseCompletedRound(round);
    const payloadJson = canonicalJson(normalizedRound);
    const contentHash = sha256(canonicalJson({
      identity: normalizedRound.identity,
      l0: normalizedRound.l0,
      skill: normalizedRound.skill,
      channels: normalizedRound.channels,
    }));
    const logicalRoundKey = roundKey(normalizedRound.identity);
    const l0 = l0Delivery(normalizedRound);
    const skill = skillDelivery(normalizedRound);

    const existingBySource = this.select(normalizedRound.sourceEventId);
    if (existingBySource) {
      if (existingBySource.round_key !== logicalRoundKey || existingBySource.content_hash !== contentHash) {
        throw new OutboxConflictError(normalizedRound.sourceEventId);
      }
      return toRecord(existingBySource);
    }
    const existingByRound = this.selectByRoundKey(logicalRoundKey);
    if (existingByRound) {
      if (existingByRound.content_hash !== contentHash) {
        throw new OutboxConflictError(existingByRound.source_event_id);
      }
      return toRecord(existingByRound);
    }

    const now = this.now();
    const insert = this.db.transaction(() => {
      const concurrent = this.select(normalizedRound.sourceEventId)
        ?? this.selectByRoundKey(logicalRoundKey);
      if (concurrent) {
        if (concurrent.round_key !== logicalRoundKey || concurrent.content_hash !== contentHash) {
          throw new OutboxConflictError(normalizedRound.sourceEventId);
        }
        return concurrent;
      }
      this.db.prepare(`
        INSERT INTO completed_round_outbox (
          source_event_id, round_key, content_hash, isolation_key, ordering_key, turn_id, payload_json,
          l0_source_event_id, l0_content_hash, skill_source_event_id, skill_content_hash, state,
          attempt_count, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(
        normalizedRound.sourceEventId,
        logicalRoundKey,
        contentHash,
        isolationKey(normalizedRound.identity),
        orderingKey(normalizedRound.identity),
        normalizedRound.identity.turnId,
        payloadJson,
        l0.sourceEventId,
        l0.contentHash,
        skill.sourceEventId,
        skill.contentHash,
        now,
        now,
        now,
      );
      const persisted = this.select(normalizedRound.sourceEventId);
      if (!persisted) throw new Error("Durable outbox insert did not persist a row");
      return persisted;
    });

    return toRecord(insert());
  }

  async get(sourceEventId: string): Promise<OutboxRecord | null> {
    this.assertOpen();
    const row = this.select(sourceEventId);
    return row ? toRecord(row) : null;
  }

  async health(): Promise<OutboxHealth> {
    this.assertOpen();
    const now = this.now();
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN state = 'inflight' THEN 1 ELSE 0 END) AS inflight_count,
        SUM(CASE WHEN state = 'pending' AND attempt_count > 0 THEN 1 ELSE 0 END) AS retrying_count,
        SUM(CASE WHEN state = 'dead' THEN 1 ELSE 0 END) AS dead_count,
        MIN(CASE WHEN state IN ('pending', 'inflight') THEN created_at END) AS oldest_pending_at,
        MIN(CASE WHEN state = 'pending' AND attempt_count > 0 THEN next_attempt_at END) AS next_retry_at
      FROM completed_round_outbox
    `).get() as {
      pending_count: number | null;
      inflight_count: number | null;
      retrying_count: number | null;
      dead_count: number | null;
      oldest_pending_at: number | null;
      next_retry_at: number | null;
    };
    const health: OutboxHealth = {
      pendingCount: row.pending_count ?? 0,
      inflightCount: row.inflight_count ?? 0,
      retryingCount: row.retrying_count ?? 0,
      deadCount: row.dead_count ?? 0,
      oldestPendingAgeMs: row.oldest_pending_at === null ? 0 : Math.max(0, now - row.oldest_pending_at),
    };
    if (row.next_retry_at !== null) health.nextRetryAt = row.next_retry_at;
    if (this.workerErrorKind !== undefined) health.workerErrorKind = this.workerErrorKind;
    return health;
  }

  async drainReady(options: { concurrency?: number; maxEntries?: number } = {}): Promise<{
    committed: number;
    retried: number;
    dead: number;
  }> {
    this.assertOpen();
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1_000));
    const totals = { committed: 0, retried: 0, dead: 0 };
    let claimed = 0;

    const worker = async (): Promise<void> => {
      while (claimed < maxEntries) {
        const row = this.claimNext();
        if (!row) return;
        claimed += 1;
        const outcome = await this.deliver(row);
        totals[outcome] += 1;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return totals;
  }

  async start(options: { pollIntervalMs?: number; concurrency?: number } = {}): Promise<void> {
    this.assertOpen();
    if (this.pollTimer) return;
    const pollIntervalMs = Math.max(10, Math.floor(options.pollIntervalMs ?? 1_000));
    await this.runWorker(options.concurrency);
    this.pollTimer = setInterval(() => {
      void this.runWorker(options.concurrency).catch((error: unknown) => {
        this.workerErrorKind = safeErrorKind(error);
      });
    }, pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.activeDrain;
  }

  close(): void {
    if (this.closed) return;
    if (this.pollTimer || this.activeDrain) {
      throw new Error("Stop the durable round outbox worker before closing it");
    }
    this.closed = true;
    this.db.close();
  }

  private select(sourceEventId: string): OutboxRow | undefined {
    return this.db.prepare(`
      SELECT sequence, source_event_id, round_key, content_hash, isolation_key, ordering_key, turn_id, payload_json,
             l0_source_event_id, l0_content_hash, skill_source_event_id, skill_content_hash,
             state, attempt_count, next_attempt_at, l0_receipt_json,
             skill_receipt_json, created_at, updated_at
      FROM completed_round_outbox WHERE source_event_id = ?
    `).get(sourceEventId) as OutboxRow | undefined;
  }

  private selectByRoundKey(logicalRoundKey: string): OutboxRow | undefined {
    return this.db.prepare(`
      SELECT sequence, source_event_id, round_key, content_hash, isolation_key, ordering_key, turn_id, payload_json,
             l0_source_event_id, l0_content_hash, skill_source_event_id, skill_content_hash,
             state, attempt_count, next_attempt_at, l0_receipt_json,
             skill_receipt_json, created_at, updated_at
      FROM completed_round_outbox WHERE round_key = ?
    `).get(logicalRoundKey) as OutboxRow | undefined;
  }

  private claimNext(): OutboxRow | null {
    const claim = this.db.transaction(() => {
      const now = this.now();
      const candidate = this.db.prepare(`
        SELECT candidate.sequence, candidate.source_event_id, candidate.content_hash,
               candidate.round_key, candidate.isolation_key, candidate.ordering_key,
               candidate.turn_id, candidate.payload_json,
               candidate.l0_source_event_id, candidate.l0_content_hash,
               candidate.skill_source_event_id, candidate.skill_content_hash, candidate.state,
               candidate.attempt_count, candidate.next_attempt_at,
               candidate.l0_receipt_json, candidate.skill_receipt_json,
               candidate.created_at, candidate.updated_at
        FROM completed_round_outbox AS candidate
        WHERE candidate.state = 'pending'
          AND candidate.next_attempt_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM completed_round_outbox AS earlier
            WHERE earlier.ordering_key = candidate.ordering_key
              AND earlier.sequence < candidate.sequence
              AND earlier.state IN ('pending', 'inflight')
          )
        ORDER BY candidate.sequence
        LIMIT 1
      `).get(now) as OutboxRow | undefined;
      if (!candidate) return null;

      const update = this.db.prepare(`
        UPDATE completed_round_outbox
        SET state = 'inflight', attempt_count = attempt_count + 1, updated_at = ?
        WHERE source_event_id = ? AND state = 'pending'
      `).run(now, candidate.source_event_id);
      if (update.changes !== 1) return null;
      return this.select(candidate.source_event_id) ?? null;
    });
    return claim();
  }

  private async deliver(row: OutboxRow): Promise<"committed" | "retried" | "dead"> {
    try {
      const round = parseCompletedRound(row.payload_json);
      if (round.channels?.l0 !== false && row.l0_receipt_json === null) {
        const input = l0Delivery(round, row.l0_source_event_id, row.l0_content_hash);
        const receipt = await this.delivery.deliverL0(input);
        validateReceipt(receipt, input);
        this.saveReceipt(row.source_event_id, "l0_receipt_json", receipt);
      }
      if (round.channels?.skill !== false && row.skill_receipt_json === null) {
        const input = skillDelivery(round, row.skill_source_event_id, row.skill_content_hash);
        const receipt = await this.delivery.deliverSkill(input);
        validateReceipt(receipt, input);
        this.saveReceipt(row.source_event_id, "skill_receipt_json", receipt);
      }

      const now = this.now();
      const committed = this.db.prepare(`
        UPDATE completed_round_outbox
        SET state = 'committed', last_error_kind = NULL, updated_at = ?
        WHERE source_event_id = ? AND state = 'inflight'
      `).run(now, row.source_event_id);
      requireSingleTransition(committed.changes, "commit", row.source_event_id);
      return "committed";
    } catch (error) {
      const failure = classifyFailure(error);
      const now = this.now();
      if (!failure.retryable || row.attempt_count >= this.maxAttempts) {
        const dead = this.db.prepare(`
          UPDATE completed_round_outbox
          SET state = 'dead', last_error_kind = ?, updated_at = ?
          WHERE source_event_id = ? AND state = 'inflight'
        `).run(failure.kind, now, row.source_event_id);
        requireSingleTransition(dead.changes, "dead-letter", row.source_event_id);
        return "dead";
      }

      const exponent = Math.max(0, row.attempt_count - 1);
      const backoff = Math.min(this.retryCapMs, this.retryBaseMs * (2 ** exponent));
      const jitter = Math.floor(this.random() * (this.retryJitterMs + 1));
      const delay = Math.min(this.retryCapMs, backoff + jitter);
      const retry = this.db.prepare(`
        UPDATE completed_round_outbox
        SET state = 'pending', next_attempt_at = ?, last_error_kind = ?, updated_at = ?
        WHERE source_event_id = ? AND state = 'inflight'
      `).run(now + delay, failure.kind, now, row.source_event_id);
      requireSingleTransition(retry.changes, "schedule retry", row.source_event_id);
      return "retried";
    }
  }

  private async runWorker(concurrency: number | undefined): Promise<{
    committed: number;
    retried: number;
    dead: number;
  }> {
    if (this.activeDrain) return this.activeDrain;
    const drain = this.drainReady({ concurrency });
    this.activeDrain = drain;
    try {
      const result = await drain;
      this.workerErrorKind = undefined;
      return result;
    } finally {
      if (this.activeDrain === drain) this.activeDrain = null;
    }
  }

  private saveReceipt(
    sourceEventId: string,
    column: "l0_receipt_json" | "skill_receipt_json",
    receipt: DeliveryReceipt,
  ): void {
    const now = this.now();
    const update = this.db.prepare(`
      UPDATE completed_round_outbox
      SET ${column} = ?, updated_at = ?
      WHERE source_event_id = ? AND state = 'inflight'
    `).run(JSON.stringify(receipt), now, sourceEventId);
    if (update.changes !== 1) throw new Error("Outbox delivery lost its inflight claim");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Durable round outbox is closed");
  }
}

export function openDurableRoundOutbox(options: OpenDurableRoundOutboxOptions): DurableRoundOutbox {
  if (!options.dbPath.trim() || options.dbPath.trim() === ":memory:") {
    throw new Error("Hooks-capable runtime requires a file-backed durable outbox");
  }
  const dbPath = resolve(options.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    const journalMode: unknown = db.pragma("journal_mode = WAL", { simple: true });
    if (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal") {
      throw new Error(`SQLite refused WAL journal mode (active mode: ${String(journalMode)})`);
    }
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 5000");
    db.exec(OUTBOX_SCHEMA_SQL);
    return new DurableRoundOutbox(db, options.delivery, options);
  } catch (error) {
    db?.close();
    throw new Error(
      `Durable round outbox is unavailable at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function orderingKey(identity: CompletedRoundIdentity): string {
  // Task may change during a long-lived session. Ordering intentionally uses
  // the stable session namespace so such turns cannot overtake one another.
  return canonicalJson([
    identity.serviceId,
    identity.teamId,
    identity.userId,
    identity.agentId,
    identity.agentSource,
    identity.sessionId,
  ]);
}

function isolationKey(identity: CompletedRoundIdentity): string {
  // Unlike the ordering key, durable identity retains the complete applicable
  // isolation tuple, including task, for receipts and duplicate detection.
  return canonicalJson([
    identity.serviceId,
    identity.teamId,
    identity.userId,
    identity.agentId,
    identity.taskId ?? "",
    identity.agentSource,
    identity.sessionId,
  ]);
}

function roundKey(identity: CompletedRoundIdentity): string {
  return canonicalJson([
    isolationKey(identity),
    identity.turnId,
  ]);
}

function toRecord(row: OutboxRow): OutboxRecord {
  return {
    sourceEventId: row.source_event_id,
    contentHash: row.content_hash,
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseCompletedRound(value: unknown): CompletedRound {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!isRecord(parsed) || !isNonEmptyString(parsed.sourceEventId) || !isRecord(parsed.identity) ||
      !isRecord(parsed.l0) || !isRecord(parsed.skill)) {
    throw new TypeError("Completed round has an invalid top-level shape");
  }

  const identity = parsed.identity;
  if (!isNonEmptyString(identity.serviceId) || !isNonEmptyString(identity.teamId) ||
      !isNonEmptyString(identity.userId) || !isNonEmptyString(identity.agentId) ||
      !isNonEmptyString(identity.agentSource) || !isNonEmptyString(identity.sessionId) ||
      !isNonEmptyString(identity.turnId) ||
      (identity.taskId !== undefined && !isNonEmptyString(identity.taskId))) {
    throw new TypeError("Completed round identity fields must be non-empty strings");
  }
  if (!Array.isArray(parsed.l0.messages) || parsed.l0.messages.length === 0 ||
      !Array.isArray(parsed.skill.messages) || parsed.skill.messages.length === 0) {
    throw new TypeError("Completed round deliveries must contain non-empty message arrays");
  }
  const channels = parsed.channels === undefined
    ? { l0: true, skill: true }
    : parseDeliveryChannels(parsed.channels);

  const l0Messages: TdaiMessage[] = [];
  for (const message of parsed.l0.messages) {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string") {
      throw new TypeError("Completed round contains an invalid L0 message");
    }
    l0Messages.push({ role: message.role, content: message.content });
  }

  const skillMessages: ConversationTurnMessage[] = [];
  for (const message of parsed.skill.messages) {
    if (!isRecord(message) || !isSkillRole(message.role) || typeof message.content !== "string" ||
        (message.tool_name !== undefined && typeof message.tool_name !== "string") ||
        (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") ||
        (message.timestamp !== undefined && typeof message.timestamp !== "string" &&
          (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp))) ||
        (message.role === "tool_call" &&
          (!isNonEmptyString(message.tool_name) || !isNonEmptyString(message.tool_call_id))) ||
        (message.role === "tool_result" && !isNonEmptyString(message.tool_call_id))) {
      throw new TypeError("Completed round contains an invalid skill message");
    }
    const normalized: ConversationTurnMessage = { role: message.role, content: message.content };
    if (message.tool_name !== undefined) normalized.tool_name = message.tool_name;
    if (message.tool_call_id !== undefined) normalized.tool_call_id = message.tool_call_id;
    if (message.timestamp !== undefined) normalized.timestamp = message.timestamp;
    skillMessages.push(normalized);
  }

  const normalizedIdentity: CompletedRoundIdentity = {
    serviceId: identity.serviceId,
    teamId: identity.teamId,
    userId: identity.userId,
    agentId: identity.agentId,
    agentSource: identity.agentSource,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
  };
  if (identity.taskId !== undefined) normalizedIdentity.taskId = identity.taskId;
  return {
    sourceEventId: parsed.sourceEventId,
    identity: normalizedIdentity,
    l0: { messages: l0Messages },
    skill: { messages: skillMessages },
    channels,
  };
}

function parseDeliveryChannels(value: unknown): { l0: boolean; skill: boolean } {
  if (!isRecord(value) || typeof value.l0 !== "boolean" || typeof value.skill !== "boolean") {
    throw new TypeError("Completed round delivery channels must be booleans");
  }
  if (!value.l0 && !value.skill) {
    throw new TypeError("Completed round must enable at least one delivery channel");
  }
  return { l0: value.l0, skill: value.skill };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSkillRole(value: unknown): value is ConversationTurnMessage["role"] {
  return value === "user" || value === "assistant" || value === "tool_call" ||
    value === "tool_result" || value === "system";
}

function l0Delivery(
  round: CompletedRound,
  sourceEventId = channelSourceEventId(round, "l0"),
  contentHash = sha256(canonicalJson({ identity: round.identity, messages: round.l0.messages })),
): L0RoundDelivery {
  return {
    sourceEventId,
    contentHash,
    identity: round.identity,
    messages: round.l0.messages,
  };
}

function skillDelivery(
  round: CompletedRound,
  sourceEventId = channelSourceEventId(round, "skill"),
  contentHash = sha256(canonicalJson({ identity: round.identity, messages: round.skill.messages })),
): SkillRoundDelivery {
  return {
    sourceEventId,
    contentHash,
    identity: round.identity,
    messages: round.skill.messages,
  };
}

function channelSourceEventId(round: CompletedRound, eventType: "l0" | "skill"): string {
  const digest = sha256(canonicalJson({
    sourceEventId: round.sourceEventId,
    identity: round.identity,
    eventType,
  })).slice("sha256:".length);
  return `${round.identity.agentSource}:outbox:${digest}:${eventType}`;
}

function validateReceipt(
  receipt: DeliveryReceipt,
  expected: { sourceEventId: string; contentHash: string },
): void {
  if (
    receipt.sourceEventId !== expected.sourceEventId ||
    receipt.contentHash !== expected.contentHash ||
    typeof receipt.receiptId !== "string" || receipt.receiptId.length === 0 ||
    (receipt.status !== "committed" && receipt.status !== "duplicate")
  ) {
    throw new RetryableOutboxDeliveryError("receipt_mismatch");
  }
}

function validateL0Receipts(receipts: TdaiConversationReceipt[], sourceEventId: string): void {
  if (receipts.length === 0) throw new RetryableOutboxDeliveryError("l0_receipt_missing");
  const escapedSource = sourceEventId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedSource}:batch:(\\d+)-of-(\\d+)$`);
  const parsed = receipts.map((receipt) => {
    const match = pattern.exec(receipt.source_event_id);
    if (!match || !receipt.content_hash || !receipt.committed_at ||
        (receipt.status !== "committed" && receipt.status !== "duplicate")) {
      throw new RetryableOutboxDeliveryError("l0_receipt_mismatch");
    }
    return { index: Number(match[1]), count: Number(match[2]) };
  });
  const expectedCount = parsed[0]?.count ?? 0;
  if (
    expectedCount !== receipts.length ||
    parsed.some((entry) => entry.count !== expectedCount) ||
    parsed.map((entry) => entry.index).sort((left, right) => left - right)
      .some((index, expected) => index !== expected)
  ) {
    throw new RetryableOutboxDeliveryError("l0_receipt_mismatch");
  }
}

class RetryableOutboxDeliveryError extends Error {
  readonly retryable = true;

  constructor(readonly safeKind: string) {
    super("MemoryCore returned a missing or mismatched durable receipt");
    this.name = "RetryableOutboxDeliveryError";
  }
}

class OutboxConfigurationError extends Error {
  readonly retryable = false;

  constructor(readonly safeKind: string) {
    super("MemoryCore delivery client is configured for a different service identity");
    this.name = "OutboxConfigurationError";
  }
}

function classifyFailure(error: unknown): { retryable: boolean; kind: string } {
  if (error instanceof RetryableOutboxDeliveryError) {
    return { retryable: true, kind: error.safeKind };
  }
  if (error instanceof OutboxConfigurationError) {
    return { retryable: false, kind: error.safeKind };
  }
  if (error !== null && typeof error === "object") {
    const candidate = error as {
      retryable?: unknown;
      kind?: unknown;
      status?: unknown;
      httpStatus?: unknown;
      name?: unknown;
    };
    const status = typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.httpStatus === "number" ? candidate.httpStatus : undefined;
    const kind = normalizeErrorKind(candidate.kind);
    if (typeof candidate.retryable === "boolean") return { retryable: candidate.retryable, kind };
    if (status !== undefined) {
      return { retryable: status === 408 || status === 429 || status >= 500, kind: `http_${status}` };
    }
  }
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const network = /abort|econnreset|enotfound|etimedout|fetch failed|network|timeout/i.test(text);
  return { retryable: network, kind: network ? "network" : safeErrorKind(error) };
}

function safeErrorKind(error: unknown): string {
  if (error instanceof TypeError) return "type_error";
  if (error instanceof SyntaxError) return "syntax_error";
  return error instanceof Error ? "error" : "unknown";
}

function normalizeErrorKind(value: unknown): string {
  if (typeof value !== "string") return "delivery_error";
  const knownKinds = new Set([
    "network", "timeout", "http", "envelope", "malformed", "rate_limit",
    "conflict", "client", "server", "invalid_response",
  ]);
  return knownKinds.has(value) ? value : "delivery_error";
}

function requireSingleTransition(changes: number, operation: string, sourceEventId: string): void {
  if (changes !== 1) {
    throw new Error(`Durable outbox could not ${operation} event ${sourceEventId}`);
  }
}

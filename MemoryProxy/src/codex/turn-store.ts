import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { canonicalJson } from "./round-normalizer.js";

export interface CodexTurnIdentity {
  serviceId: string;
  teamId: string;
  userId: string;
  agentId: string;
  taskId: string;
  agentSource: "codex";
  sessionId: string;
  turnId: string;
}

export interface BeginCodexTurnInput {
  identity: CodexTurnIdentity;
  prompt: string;
}

export interface CodexToolEvent {
  identity: CodexTurnIdentity;
  toolUseId: string;
  toolName: string;
  input: unknown;
  output: string;
  failed: boolean;
}

export interface RecordCodexStopInput {
  identity: CodexTurnIdentity;
  finalResponse: string;
}

export interface CodexCompletedTurn {
  identity: CodexTurnIdentity;
  prompt: string;
  tools: Array<Omit<CodexToolEvent, "identity">>;
  finalResponse: string;
}

export interface RecordCodexStopResult {
  status: "persisted" | "duplicate";
  committed: boolean;
  round: CodexCompletedTurn;
}

export interface CodexTurnStore {
  beginTurn(input: BeginCodexTurnInput): Promise<{ status: "persisted" | "duplicate" }>;
  appendToolEvent(input: CodexToolEvent): Promise<{ status: "persisted" | "duplicate" }>;
  recordStop(input: RecordCodexStopInput): Promise<RecordCodexStopResult>;
  markCommitted(identity: CodexTurnIdentity): Promise<{ status: "committed" | "duplicate" }>;
  close(): void;
}

export interface OpenDurableCodexTurnStoreOptions {
  dbPath: string;
  now?: () => number;
}

interface TurnRow {
  service_id: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  task_id: string;
  agent_source: "codex";
  session_id: string;
  turn_id: string;
  prompt: string;
  content_hash: string;
}

interface ToolRow {
  tool_use_id: string;
  tool_name: string;
  input_json: string;
  output: string;
  failed: number;
  content_hash: string;
}

interface StopRow {
  final_response: string;
  content_hash: string;
  committed_at: number | null;
}

const TURN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_turns (
  service_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_source TEXT NOT NULL CHECK (agent_source = 'codex'),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    service_id, team_id, user_id, agent_id, task_id,
    agent_source, session_id, turn_id
  )
);
CREATE INDEX IF NOT EXISTS codex_turns_session
  ON codex_turns(service_id, user_id, agent_source, session_id, created_at);
CREATE TABLE IF NOT EXISTS codex_turn_tools (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_source TEXT NOT NULL CHECK (agent_source = 'codex'),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output TEXT NOT NULL,
  failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (
    service_id, team_id, user_id, agent_id, task_id,
    agent_source, session_id, turn_id, tool_use_id
  )
);
CREATE INDEX IF NOT EXISTS codex_turn_tools_round
  ON codex_turn_tools(
    service_id, team_id, user_id, agent_id, task_id,
    agent_source, session_id, turn_id, sequence
  );
CREATE TABLE IF NOT EXISTS codex_turn_stops (
  service_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_source TEXT NOT NULL CHECK (agent_source = 'codex'),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  final_response TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  PRIMARY KEY (
    service_id, team_id, user_id, agent_id, task_id,
    agent_source, session_id, turn_id
  )
);
CREATE TRIGGER IF NOT EXISTS codex_turn_tools_reject_after_stop
BEFORE INSERT ON codex_turn_tools
WHEN EXISTS (
  SELECT 1 FROM codex_turn_stops
  WHERE service_id = NEW.service_id AND team_id = NEW.team_id
    AND user_id = NEW.user_id AND agent_id = NEW.agent_id
    AND task_id = NEW.task_id AND agent_source = NEW.agent_source
    AND session_id = NEW.session_id AND turn_id = NEW.turn_id
)
BEGIN
  SELECT RAISE(ABORT, 'Codex turn already stopped');
END;
`;

export class CodexTurnConflictError extends Error {
  constructor(readonly sessionId: string, readonly turnId: string) {
    super(`Codex turn ${sessionId}/${turnId} was already persisted with different content`);
    this.name = "CodexTurnConflictError";
  }
}

export class DurableCodexTurnStore implements CodexTurnStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private closed = false;

  constructor(options: OpenDurableCodexTurnStoreOptions) {
    const dbPath = requiredText(options.dbPath, "dbPath");
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 2000");
    this.db.exec(TURN_SCHEMA_SQL);
    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (existsSync(filePath)) chmodSync(filePath, 0o600);
      } catch {
        // Some non-POSIX filesystems do not expose mode bits.
      }
    }
    this.now = options.now ?? Date.now;
  }

  async beginTurn(rawInput: BeginCodexTurnInput): Promise<{ status: "persisted" | "duplicate" }> {
    this.assertOpen();
    const input = validateInput(rawInput);
    const contentHash = hashTurn(input);
    const timestamp = this.now();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO codex_turns (
        service_id, team_id, user_id, agent_id, task_id, agent_source,
        session_id, turn_id, prompt, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.identity.serviceId,
      input.identity.teamId,
      input.identity.userId,
      input.identity.agentId,
      input.identity.taskId,
      input.identity.agentSource,
      input.identity.sessionId,
      input.identity.turnId,
      input.prompt,
      contentHash,
      timestamp,
      timestamp,
    );
    if (insert.changes === 1) return { status: "persisted" };

    const existing = this.select(input.identity);
    if (existing?.content_hash === contentHash) return { status: "duplicate" };
    throw new CodexTurnConflictError(input.identity.sessionId, input.identity.turnId);
  }

  async getTurn(identity: CodexTurnIdentity): Promise<BeginCodexTurnInput | null> {
    this.assertOpen();
    const normalized = validateIdentity(identity);
    const row = this.select(normalized);
    if (!row) return null;
    return {
      identity: {
        serviceId: row.service_id,
        teamId: row.team_id,
        userId: row.user_id,
        agentId: row.agent_id,
        taskId: row.task_id,
        agentSource: row.agent_source,
        sessionId: row.session_id,
        turnId: row.turn_id,
      },
      prompt: row.prompt,
    };
  }

  async appendToolEvent(rawInput: CodexToolEvent): Promise<{ status: "persisted" | "duplicate" }> {
    this.assertOpen();
    const input = validateToolEvent(rawInput);
    if (!this.select(input.identity)) {
      throw new CodexTurnConflictError(input.identity.sessionId, input.identity.turnId);
    }
    const inputJson = canonicalJson(input.input);
    const contentHash = sha256(canonicalJson({
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      input: input.input,
      output: input.output,
      failed: input.failed,
    }));
    const existing = this.selectTool(input.identity, input.toolUseId);
    if (existing) {
      if (existing.content_hash === contentHash) return { status: "duplicate" };
      throw new CodexTurnConflictError(input.identity.sessionId, input.identity.turnId);
    }
    if (this.selectStop(input.identity)) {
      throw new CodexTurnConflictError(input.identity.sessionId, input.identity.turnId);
    }
    const timestamp = this.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO codex_turn_tools (
        service_id, team_id, user_id, agent_id, task_id, agent_source,
        session_id, turn_id, tool_use_id, tool_name, input_json, output,
        failed, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...identityValues(input.identity),
      input.toolUseId,
      input.toolName,
      inputJson,
      input.output,
      input.failed ? 1 : 0,
      contentHash,
      timestamp,
    );
    if (result.changes === 1) return { status: "persisted" };
    const concurrent = this.selectTool(input.identity, input.toolUseId);
    if (concurrent?.content_hash === contentHash) return { status: "duplicate" };
    throw new CodexTurnConflictError(input.identity.sessionId, input.identity.turnId);
  }

  async recordStop(rawInput: RecordCodexStopInput): Promise<RecordCodexStopResult> {
    this.assertOpen();
    const input = validateStopInput(rawInput);
    const turn = this.select(input.identity);
    if (!turn) throw new CodexTurnConflictError(input.identity.sessionId, input.identity.turnId);
    const contentHash = sha256(canonicalJson({ finalResponse: input.finalResponse }));
    const existing = this.selectStop(input.identity);
    let status: RecordCodexStopResult["status"] = "duplicate";
    if (existing) {
      if (existing.content_hash !== contentHash) {
        throw new CodexTurnConflictError(input.identity.sessionId, input.identity.turnId);
      }
    } else {
      const timestamp = this.now();
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO codex_turn_stops (
          service_id, team_id, user_id, agent_id, task_id, agent_source,
          session_id, turn_id, final_response, content_hash, created_at, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(...identityValues(input.identity), input.finalResponse, contentHash, timestamp);
      status = result.changes === 1 ? "persisted" : "duplicate";
    }
    const persisted = this.selectStop(input.identity);
    if (!persisted || persisted.content_hash !== contentHash) {
      throw new CodexTurnConflictError(input.identity.sessionId, input.identity.turnId);
    }
    return {
      status,
      committed: persisted.committed_at !== null,
      round: {
        identity: input.identity,
        prompt: turn.prompt,
        tools: this.selectTools(input.identity).map(toToolEvent),
        finalResponse: persisted.final_response,
      },
    };
  }

  async markCommitted(identity: CodexTurnIdentity): Promise<{ status: "committed" | "duplicate" }> {
    this.assertOpen();
    const normalized = validateIdentity(identity);
    const existing = this.selectStop(normalized);
    if (!existing) throw new CodexTurnConflictError(normalized.sessionId, normalized.turnId);
    if (existing.committed_at !== null) return { status: "duplicate" };
    const result = this.db.prepare(`
      UPDATE codex_turn_stops SET committed_at = ?
      WHERE service_id = ? AND team_id = ? AND user_id = ?
        AND agent_id = ? AND task_id = ? AND agent_source = ?
        AND session_id = ? AND turn_id = ? AND committed_at IS NULL
    `).run(this.now(), ...identityValues(normalized));
    return { status: result.changes === 1 ? "committed" : "duplicate" };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private select(identity: CodexTurnIdentity): TurnRow | undefined {
    const row: unknown = this.db.prepare(`
      SELECT service_id, team_id, user_id, agent_id, task_id, agent_source,
             session_id, turn_id, prompt, content_hash
      FROM codex_turns
      WHERE service_id = ? AND team_id = ? AND user_id = ?
        AND agent_id = ? AND task_id = ? AND agent_source = ?
        AND session_id = ? AND turn_id = ?
    `).get(
      identity.serviceId,
      identity.teamId,
      identity.userId,
      identity.agentId,
      identity.taskId,
      identity.agentSource,
      identity.sessionId,
      identity.turnId,
    );
    return parseTurnRow(row);
  }

  private selectTool(identity: CodexTurnIdentity, toolUseId: string): ToolRow | undefined {
    const row: unknown = this.db.prepare(`
      SELECT tool_use_id, tool_name, input_json, output, failed, content_hash
      FROM codex_turn_tools
      WHERE service_id = ? AND team_id = ? AND user_id = ?
        AND agent_id = ? AND task_id = ? AND agent_source = ?
        AND session_id = ? AND turn_id = ? AND tool_use_id = ?
    `).get(...identityValues(identity), toolUseId);
    return parseToolRow(row);
  }

  private selectTools(identity: CodexTurnIdentity): ToolRow[] {
    const rows: unknown[] = this.db.prepare(`
      SELECT tool_use_id, tool_name, input_json, output, failed, content_hash
      FROM codex_turn_tools
      WHERE service_id = ? AND team_id = ? AND user_id = ?
        AND agent_id = ? AND task_id = ? AND agent_source = ?
        AND session_id = ? AND turn_id = ?
      ORDER BY sequence ASC
    `).all(...identityValues(identity));
    return rows.map((row) => {
      const parsed = parseToolRow(row);
      if (!parsed) throw new TypeError("Invalid Codex tool row");
      return parsed;
    });
  }

  private selectStop(identity: CodexTurnIdentity): StopRow | undefined {
    const row: unknown = this.db.prepare(`
      SELECT final_response, content_hash, committed_at
      FROM codex_turn_stops
      WHERE service_id = ? AND team_id = ? AND user_id = ?
        AND agent_id = ? AND task_id = ? AND agent_source = ?
        AND session_id = ? AND turn_id = ?
    `).get(...identityValues(identity));
    return parseStopRow(row);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Codex turn store is closed");
  }
}

export function openDurableCodexTurnStore(
  options: OpenDurableCodexTurnStoreOptions,
): DurableCodexTurnStore {
  return new DurableCodexTurnStore(options);
}

function validateInput(input: BeginCodexTurnInput): BeginCodexTurnInput {
  return {
    identity: validateIdentity(input.identity),
    prompt: requiredText(input.prompt, "prompt"),
  };
}

function validateToolEvent(input: CodexToolEvent): CodexToolEvent {
  if (typeof input.failed !== "boolean") throw new TypeError("failed is required");
  canonicalJson(input.input);
  if (typeof input.output !== "string") throw new TypeError("output must be a string");
  return {
    identity: validateIdentity(input.identity),
    toolUseId: requiredText(input.toolUseId, "toolUseId"),
    toolName: requiredText(input.toolName, "toolName"),
    input: input.input,
    output: input.output,
    failed: input.failed,
  };
}

function validateStopInput(input: RecordCodexStopInput): RecordCodexStopInput {
  return {
    identity: validateIdentity(input.identity),
    finalResponse: requiredText(input.finalResponse, "finalResponse"),
  };
}

function validateIdentity(identity: CodexTurnIdentity): CodexTurnIdentity {
  if (identity.agentSource !== "codex") throw new TypeError("agentSource must be codex");
  return {
    serviceId: requiredText(identity.serviceId, "serviceId"),
    teamId: requiredText(identity.teamId, "teamId"),
    userId: requiredText(identity.userId, "userId"),
    agentId: requiredText(identity.agentId, "agentId"),
    taskId: requiredText(identity.taskId, "taskId"),
    agentSource: "codex",
    sessionId: requiredText(identity.sessionId, "sessionId"),
    turnId: requiredText(identity.turnId, "turnId"),
  };
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function hashTurn(input: BeginCodexTurnInput): string {
  return sha256(canonicalJson(input));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identityValues(identity: CodexTurnIdentity): string[] {
  return [
    identity.serviceId,
    identity.teamId,
    identity.userId,
    identity.agentId,
    identity.taskId,
    identity.agentSource,
    identity.sessionId,
    identity.turnId,
  ];
}

function parseTurnRow(value: unknown): TurnRow | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid Codex turn row");
  }
  const agentSource = Reflect.get(value, "agent_source");
  if (agentSource !== "codex") throw new TypeError("Invalid Codex turn agent source");
  return {
    service_id: rowText(value, "service_id"),
    team_id: rowText(value, "team_id"),
    user_id: rowText(value, "user_id"),
    agent_id: rowText(value, "agent_id"),
    task_id: rowText(value, "task_id"),
    agent_source: agentSource,
    session_id: rowText(value, "session_id"),
    turn_id: rowText(value, "turn_id"),
    prompt: rowText(value, "prompt"),
    content_hash: rowText(value, "content_hash"),
  };
}

function parseToolRow(value: unknown): ToolRow | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid Codex tool row");
  }
  const failed = Reflect.get(value, "failed");
  if (failed !== 0 && failed !== 1) throw new TypeError("Invalid Codex tool failure state");
  return {
    tool_use_id: rowText(value, "tool_use_id"),
    tool_name: rowText(value, "tool_name"),
    input_json: rowText(value, "input_json"),
    output: rowText(value, "output"),
    failed,
    content_hash: rowText(value, "content_hash"),
  };
}

function parseStopRow(value: unknown): StopRow | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid Codex stop row");
  }
  const committedAt = Reflect.get(value, "committed_at");
  if (committedAt !== null && typeof committedAt !== "number") {
    throw new TypeError("Invalid Codex stop committed state");
  }
  return {
    final_response: rowText(value, "final_response"),
    content_hash: rowText(value, "content_hash"),
    committed_at: committedAt,
  };
}

function toToolEvent(row: ToolRow): Omit<CodexToolEvent, "identity"> {
  return {
    toolUseId: row.tool_use_id,
    toolName: row.tool_name,
    input: JSON.parse(row.input_json),
    output: row.output,
    failed: row.failed === 1,
  };
}

function rowText(row: object, field: string): string {
  const value = Reflect.get(row, field);
  if (typeof value !== "string") throw new TypeError(`Invalid Codex turn row field ${field}`);
  return value;
}

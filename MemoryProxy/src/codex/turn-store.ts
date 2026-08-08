import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

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

export interface CodexTurnStore {
  beginTurn(input: BeginCodexTurnInput): Promise<{ status: "persisted" | "duplicate" }>;
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
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
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

function rowText(row: object, field: string): string {
  const value = Reflect.get(row, field);
  if (typeof value !== "string") throw new TypeError(`Invalid Codex turn row field ${field}`);
  return value;
}

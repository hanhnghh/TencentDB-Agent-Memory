/**
 * SkillBufferStorage — 封装 §4 中所有 COS 对象读写。
 *
 * 路径规则（挂在 memory 全局 PathPrefix 下，subPath 默认 "skill_buffer"）：
 *   Session 级:
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/state.json
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/data-current.jsonl
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/data-<ts>.jsonl
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/meta.json
 *   Agent 级:
 *     {subPath}/{space}/{user}/{team}/{agent}/_tasks.json
 *
 * 底层复用 memory 现有 StorageAdapter (Local 或 Cos)。
 *
 * 读写规则：
 *   - state.json:   versioned aggregate；buffer/meta/source receipts 单次覆盖提交
 *   - data-current/meta: 旧版兼容读取，首次新写自动迁移进 state.json
 *   - archive:      明文 JSON（写入前 exists() 判定，已存在直接视为成功）
 *   - _tasks.json:  明文 JSON（读改写，由上层 SkillAgentTaskQueue 用 Redis 短锁保护）
 */

import { z } from "zod";

import type { StorageAdapter } from "../../storage/adapter.js";

export interface SessionKey {
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
}

export interface AgentTuple {
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
}

const storedMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
}).catchall(z.unknown());

const bufferedMessagesSchema = z.object({
  messages: z.array(storedMessageSchema),
});

const sessionMetaSchema = z.object({
  session_id: z.string(),
  space_id: z.string(),
  user_id: z.string(),
  team_id: z.string(),
  agent_id: z.string(),
  tool_call_count: z.number().int().nonnegative(),
  byte_count: z.number().int().nonnegative(),
  last_appended_at_ms: z.number().optional(),
  last_archived_at_ms: z.number().optional(),
});

/** meta.json 结构（§4.2）。只放计数器。 */
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

/** _tasks.json 单个 task 条目（§4.3）。 */
const skillTaskEntrySchema = z.object({
  task_id: z.string().min(1),
  session_id: z.string().min(1),
  user_id: z.string().min(1),
  team_id: z.string().min(1),
  agent_id: z.string().min(1),
  space_id: z.string().min(1),
  task_ref_id: z.string().optional(),
  archive_key: z.string().min(1),
  archived_at_ms: z.number(),
  enqueued_at_ms: z.number(),
  reason: z.string().optional(),
  max_iterations: z.number().int().positive().optional(),
  retry_count: z.number().int().nonnegative().optional(),
  last_error: z.string().optional(),
});
export type SkillTaskEntry = z.infer<typeof skillTaskEntrySchema>;

const agentTasksDocSchema = z.object({
  team_id: z.string(),
  agent_id: z.string(),
  updated_at_ms: z.number(),
  tasks: z.array(skillTaskEntrySchema),
});
export type AgentTasksDoc = z.infer<typeof agentTasksDocSchema>;

/**
 * `_tasks_dlq.json` 单条死信记录。
 *
 * DLQ 只落盘不做端点：人工用 `cat` / `mv` 救回来，或者 grafana 告警脚本直接
 * scan 文件。当前不做 TTL / 大小限制（每 agent 一份文件，量大时用户自己处理）。
 */
const skillDeadTaskEntrySchema = skillTaskEntrySchema.extend({
  /** DLQ 追加时的 wall clock 时间戳。 */
  dead_lettered_at_ms: z.number(),
});
export type SkillDeadTaskEntry = z.infer<typeof skillDeadTaskEntrySchema>;

/** `_tasks_dlq.json` 整体结构。 */
const agentDeadTasksDocSchema = z.object({
  team_id: z.string(),
  agent_id: z.string(),
  updated_at_ms: z.number(),
  tasks: z.array(skillDeadTaskEntrySchema),
});
export type AgentDeadTasksDoc = z.infer<typeof agentDeadTasksDocSchema>;

/** data-current / archive 缓存内容。使用 { messages: [...] } 而不是纯 JSONL，简化读写。 */
export type BufferedMessages = z.infer<typeof bufferedMessagesSchema>;

const conversationReceiptSchema = z.object({
  receipt_id: z.string().min(1),
  source_event_id: z.string().min(1).optional(),
  content_hash: z.string().min(1),
  accepted_at_ms: z.number(),
});
export type ConversationReceipt = z.infer<typeof conversationReceiptSchema>;

const archivedConversationResultSchema = z.object({
  task_id: z.string().min(1),
  archived_at_ms: z.number(),
  archive_key: z.string().min(1),
  reason: z.enum(["tool_calls", "bytes", "compressed", "oversize"]),
});

const storedConversationAddResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), receipt: conversationReceiptSchema }).strict(),
  z.object({
    status: z.literal("archived"),
    archived: archivedConversationResultSchema,
    receipt: conversationReceiptSchema,
  }).strict(),
]);
export type StoredConversationAddResult = z.infer<typeof storedConversationAddResultSchema>;

const pendingConversationArchiveSchema = z.object({
  task_id: z.string().min(1),
  archived_at_ms: z.number(),
  archive_key: z.string().min(1),
  messages: z.array(storedMessageSchema),
  task_ref_id: z.string().optional(),
});
export type PendingConversationArchive = z.infer<typeof pendingConversationArchiveSchema>;

const storedConversationEventSchema = z.object({
  /** Server-computed canonical fingerprint; never trusts a caller hash for conflicts. */
  fingerprint: z.string().min(1),
  result: storedConversationAddResultSchema,
  pending_archive: pendingConversationArchiveSchema.optional(),
});
export type StoredConversationEvent = z.infer<typeof storedConversationEventSchema>;

/**
 * Versioned session aggregate. One object replacement commits the applied
 * buffer/meta state and its source-event receipt together.
 */
const conversationSessionStateSchema = z.object({
  version: z.number().int().nonnegative(),
  current: bufferedMessagesSchema,
  meta: sessionMetaSchema,
  receipts: z.record(z.string(), storedConversationEventSchema),
});
export type ConversationSessionState = z.infer<typeof conversationSessionStateSchema>;

export interface SkillBufferStorageOptions {
  storage: StorageAdapter;
  /** COS 子路径前缀。默认 "skill_buffer"。 */
  subPath?: string;
}

const DEFAULT_SUB_PATH = "skill_buffer";

export class SkillBufferStorage {
  private readonly storage: StorageAdapter;
  private readonly subPath: string;

  constructor(opts: SkillBufferStorageOptions) {
    this.storage = opts.storage;
    this.subPath = (opts.subPath ?? DEFAULT_SUB_PATH).replace(/\/+$/, "");
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  // 路径规则对齐设计文档 §15.3：SkillBufferStorage 只负责 subPath 之下的层级
  // ({user}/{team}/{agent}/...)，space_id/instanceId 由上层 StorageAdapter 的
  // per-instance prefix 提供。带 space_id 会导致 CosStorageBackend 的 prefix
  // (`.../{instanceId}/`) 之后重复出现 `{space}/`。
  private sessionDir(sess: SessionKey): string {
    return [sess.user_id, sess.team_id, sess.agent_id, sess.session_id]
      .map(encodePathSegment)
      .reduce((path, segment) => `${path}/${segment}`, this.subPath);
  }

  private agentDir(agent: AgentTuple): string {
    return [agent.user_id, agent.team_id, agent.agent_id]
      .map(encodePathSegment)
      .reduce((path, segment) => `${path}/${segment}`, this.subPath);
  }

  currentKey(sess: SessionKey): string {
    return `${this.sessionDir(sess)}/data-current.jsonl`;
  }

  metaKey(sess: SessionKey): string {
    return `${this.sessionDir(sess)}/meta.json`;
  }

  stateKey(sess: SessionKey): string {
    return `${this.sessionDir(sess)}/state.json`;
  }

  archiveKey(sess: SessionKey, archivedAtMs: number): string {
    return `${this.sessionDir(sess)}/data-${archivedAtMs}.jsonl`;
  }

  tasksKey(agent: AgentTuple): string {
    return `${this.agentDir(agent)}/_tasks.json`;
  }

  dlqKey(agent: AgentTuple): string {
    return `${this.agentDir(agent)}/_tasks_dlq.json`;
  }

  // ── data-current ──────────────────────────────────────────────────────────

  async readCurrent(sess: SessionKey): Promise<BufferedMessages> {
    const state = await this.readStoredSessionState(sess);
    if (state) return state.current;
    return this.readLegacyCurrent(sess);
  }

  private async readLegacyCurrent(sess: SessionKey): Promise<BufferedMessages> {
    const raw = await this.storage.readFile(this.currentKey(sess));
    if (!raw) return { messages: [] };
    try {
      const parsed = bufferedMessagesSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { messages: [] };
    } catch {
      // 损坏 → 视为空
      return { messages: [] };
    }
  }

  async writeCurrent(sess: SessionKey, buf: BufferedMessages): Promise<void> {
    await this.storage.writeFile(this.currentKey(sess), JSON.stringify(buf));
  }

  // ── session meta.json ────────────────────────────────────────────────────

  async readMeta(sess: SessionKey): Promise<SessionMeta> {
    const state = await this.readStoredSessionState(sess);
    if (state) return state.meta;
    return this.readLegacyMeta(sess);
  }

  private async readLegacyMeta(sess: SessionKey): Promise<SessionMeta> {
    const raw = await this.storage.readFile(this.metaKey(sess));
    if (!raw) return this.defaultMeta(sess);
    try {
      const parsed = sessionMetaSchema.partial().safeParse(JSON.parse(raw));
      if (!parsed.success) return this.defaultMeta(sess);
      return {
        ...this.defaultMeta(sess),
        ...parsed.data,
        // 强制关键字段一致（防止旧对象 session_id/space_id 被替换）
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
      };
    } catch {
      return this.defaultMeta(sess);
    }
  }

  async writeMeta(sess: SessionKey, meta: SessionMeta): Promise<void> {
    await this.storage.writeFile(this.metaKey(sess), JSON.stringify(meta));
  }

  async readSessionState(sess: SessionKey): Promise<ConversationSessionState> {
    const stored = await this.readStoredSessionState(sess);
    if (stored) return stored;
    const [current, meta] = await Promise.all([
      this.readLegacyCurrent(sess),
      this.readLegacyMeta(sess),
    ]);
    return { version: 0, current, meta, receipts: {} };
  }

  async writeSessionState(sess: SessionKey, state: ConversationSessionState): Promise<void> {
    const validated = conversationSessionStateSchema.parse({
      ...state,
      meta: {
        ...state.meta,
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
      },
    });
    await this.storage.writeFile(this.stateKey(sess), JSON.stringify(validated));
  }

  private async readStoredSessionState(sess: SessionKey): Promise<ConversationSessionState | null> {
    const raw = await this.storage.readFile(this.stateKey(sess));
    if (!raw) return null;
    try {
      const parsed = conversationSessionStateSchema.parse(JSON.parse(raw));
      return {
        version: parsed.version,
        current: parsed.current,
        meta: {
          ...this.defaultMeta(sess),
          ...parsed.meta,
          session_id: sess.session_id,
          space_id: sess.space_id,
          user_id: sess.user_id,
          team_id: sess.team_id,
          agent_id: sess.agent_id,
        },
        receipts: parsed.receipts,
      };
    } catch (error) {
      throw new Error(`Corrupt skill conversation session state: ${this.stateKey(sess)}`, {
        cause: error,
      });
    }
  }

  private defaultMeta(sess: SessionKey): SessionMeta {
    return {
      session_id: sess.session_id,
      space_id: sess.space_id,
      user_id: sess.user_id,
      team_id: sess.team_id,
      agent_id: sess.agent_id,
      tool_call_count: 0,
      byte_count: 0,
    };
  }

  // ── archive ────────────────────────────────────────────────────────────

  /**
   * 写归档文件；若 key 已存在直接视为成功（对齐设计 §7.4 ④）。
   *
   * 注：我们不用 If-None-Match: * 头（storage 抽象层未暴露），
   * 而是 exists() → putObject 两步。同 session 由 server-side lock 保证串行，
   * 且 archived_at_ms 递增（毫秒时间戳），实际不会撞。
   */
  async writeArchive(sess: SessionKey, archivedAtMs: number, buf: BufferedMessages): Promise<void> {
    const key = this.archiveKey(sess, archivedAtMs);
    const validated = bufferedMessagesSchema.parse(buf);
    if (await this.storage.exists(key)) {
      const existing = await this.readArchive(key);
      if (existing && JSON.stringify(existing) === JSON.stringify(validated)) return;
      throw new Error(`Skill archive collision: ${key}`);
    }
    await this.storage.writeFile(key, JSON.stringify(validated));
  }

  async readArchive(archiveKey: string): Promise<BufferedMessages | null> {
    const raw = await this.storage.readFile(archiveKey);
    if (!raw) return null;
    try {
      const parsed = bufferedMessagesSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  // ── agent _tasks.json ────────────────────────────────────────────────────

  async readTasks(agent: AgentTuple): Promise<AgentTasksDoc> {
    const raw = await this.storage.readFile(this.tasksKey(agent));
    if (!raw) return this.defaultTasks(agent);
    try {
      const parsed = agentTasksDocSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return this.defaultTasks(agent);
      return {
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        updated_at_ms: parsed.data.updated_at_ms,
        tasks: parsed.data.tasks
          .filter((task) => this.isTaskArchiveScoped(agent, task))
          .map((task) => this.overwriteTaskIdentity(agent, task)),
      };
    } catch {
      return this.defaultTasks(agent);
    }
  }

  async writeTasks(agent: AgentTuple, doc: AgentTasksDoc): Promise<void> {
    if (doc.tasks.some((task) => !this.isTaskArchiveScoped(agent, task))) {
      throw new Error("Skill task archive key is outside its scoped session");
    }
    const validated = agentTasksDocSchema.parse({
      ...doc,
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      tasks: doc.tasks.map((task) => this.overwriteTaskIdentity(agent, task)),
    });
    await this.storage.writeFile(this.tasksKey(agent), JSON.stringify(validated));
  }

  private isTaskArchiveScoped(
    agent: AgentTuple,
    task: SkillTaskEntry,
  ): boolean {
    const session: SessionKey = {
      ...agent,
      session_id: task.session_id,
    };
    const expectedArchivePrefix = `${this.sessionDir(session)}/data-`;
    return task.archive_key.startsWith(expectedArchivePrefix) && task.archive_key.endsWith(".jsonl");
  }

  private overwriteTaskIdentity(agent: AgentTuple, task: SkillTaskEntry): SkillTaskEntry {
    return {
      ...task,
      space_id: agent.space_id,
      user_id: agent.user_id,
      team_id: agent.team_id,
      agent_id: agent.agent_id,
    };
  }

  private defaultTasks(agent: AgentTuple): AgentTasksDoc {
    return {
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      updated_at_ms: 0,
      tasks: [],
    };
  }

  // ── agent _tasks_dlq.json（死信队列） ─────────────────────────────────────
  //
  // DLQ 只被 Worker 追加（且 Worker 已持 extract-lock，同一 agent 只有一个写者），
  // 因此不需要 tasks-mutex 保护——但读改写仍要求先 read 再 write，避免旧内容被截。

  async readDlq(agent: AgentTuple): Promise<AgentDeadTasksDoc> {
    const raw = await this.storage.readFile(this.dlqKey(agent));
    if (!raw) return this.defaultDlq(agent);
    try {
      const parsed = agentDeadTasksDocSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return this.defaultDlq(agent);
      return {
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        updated_at_ms: parsed.data.updated_at_ms,
        tasks: parsed.data.tasks
          .filter((task) => this.isTaskArchiveScoped(agent, task))
          .map((task) => ({
            ...task,
            space_id: agent.space_id,
            user_id: agent.user_id,
            team_id: agent.team_id,
            agent_id: agent.agent_id,
          })),
      };
    } catch {
      return this.defaultDlq(agent);
    }
  }

  async appendDlq(agent: AgentTuple, dead: SkillDeadTaskEntry): Promise<void> {
    if (!this.isTaskArchiveScoped(agent, dead)) {
      throw new Error("Skill dead-letter archive key is outside its scoped session");
    }
    const doc = await this.readDlq(agent);
    doc.tasks.push({
      ...dead,
      space_id: agent.space_id,
      user_id: agent.user_id,
      team_id: agent.team_id,
      agent_id: agent.agent_id,
    });
    doc.updated_at_ms = dead.dead_lettered_at_ms;
    await this.storage.writeFile(this.dlqKey(agent), JSON.stringify(doc));
  }

  private defaultDlq(agent: AgentTuple): AgentDeadTasksDoc {
    return {
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      updated_at_ms: 0,
      tasks: [],
    };
  }
}

function encodePathSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  // Preserve legacy paths for ordinary dotted identifiers, but never allow a
  // complete "." or ".." segment to retain filesystem traversal semantics.
  if (encoded === ".") return "%2E";
  if (encoded === "..") return "%2E%2E";
  return encoded;
}

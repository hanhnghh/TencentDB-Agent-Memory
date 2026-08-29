/**
 * SkillConversationAddHandler — §7 Handler 主流程。
 *
 * 处理 `POST /v3/skill/conversation/add`：
 *   ① 校验必填字段 + role
 *   ② 计算 raw_bytes
 *   ③ 分路径：normal (< requestCompressThreshold) / compressed (≥) / oversize (拼接后 > chunkMax)
 *   ④ 在 server-side session lock 内拼接并累加计数
 *   ⑤ 用一个 versioned state write 原子提交 buffer + receipt
 *   ⑥ 幂等投递达到阈值的归档任务
 */

import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_COMPRESS_OPTIONS,
  type CompressibleMessage,
  type CompressOptions,
  type CompressibleRole,
} from "./message-compressor.js";
import {
  DEFAULT_OVERSIZE_OPTIONS,
  type OversizeMessage,
  type OversizeOptions,
} from "./oversize-strategy.js";
import { prepareArchivePayload } from "./prepare-archive.js";
import type {
  ConversationReceipt,
  ConversationSessionState,
  SkillBufferStorage,
  SessionKey,
  SessionMeta,
  StoredConversationAddResult,
  StoredConversationEvent,
} from "./buffer-storage.js";
import type { SkillTriggerService } from "./trigger-service.js";
import { obsLogger } from "../../report/obs-logger.js";

const VALID_ROLES: ReadonlySet<CompressibleRole> = new Set([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
]);

/**
 * 归档阈值 `tool_call_count` 的计数集合。
 *
 * **只算 `tool_call`, 不算 `tool_result`。** 二者天然 1:1 配对 (每次
 * agent 调工具都会带回一次 result), 把两者都算等于把计数翻倍, 用户会
 * 观察到"agent 调 5 次工具就归档"——完全不是配置里的 10。
 *
 * 具体来说, VALID_ROLES 里 "tool_call" 是 agent 主动发起的调用,
 * "tool_result" 是配对的返回。归档触发的语义是"agent 用工具的次数",
 * 所以只数 call 一侧。
 *
 * 校验路径 (validate() 里) 依然对 tool_call 和 tool_result 都要求
 * tool_call_id —— 那是**结构合法性**校验, 跟计数无关, 两码事。
 */
const TOOL_CALL_ROLES: ReadonlySet<CompressibleRole> = new Set(["tool_call"]);

/** 校验时需要 tool_call_id 的 role 集合 (call 和 result 都要携带配对锚点)。 */
const TOOL_PAIR_ROLES: ReadonlySet<CompressibleRole> = new Set(["tool_call", "tool_result"]);

const ID_FORBIDDEN_CHAR = "|";

export interface AddConversationInput {
  /**
   * 2026-07-30 新增：多租户实例 ID。透传到 AgentTuple 里让 worker pool
   * 出队时能按 instance_id 动态解析对应 instance 的 CoS/VDB/LLM 资源。
   * standalone 模式下由 gateway 兜底 "default"。缺失会在 validate 阶段拒绝。
   */
  instance_id: string;
  session_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  /** 业务侧 task 引用，透传到 archive 落地时的 task.task_ref_id。 */
  task_id?: string;
  /** Stable caller event identity. Exact retries return the original receipt. */
  source_event_id?: string;
  /** Optional caller hash echoed in the durable receipt. */
  content_hash?: string;
  messages: CompressibleMessage[];
  /**
   * 上游 HTTP handler 的 req_id，用于 obsLogger 分段事件关联链路。
   * 缺省则事件字段少一个 req_id，业务逻辑不受影响。
   */
  perfRequestId?: string;
}

export type AddConversationResult = StoredConversationAddResult;

export interface HandlerThresholds {
  /** tool_call 累计阈值。默认 10。 */
  toolCallThreshold: number;
  /** 字节累计阈值。默认 40960 (40KB)。 */
  bytesThreshold: number;
  /** 本次 add 字节 ≥ 此值走压缩路径。默认 40960。 */
  requestCompressThresholdBytes: number;
}

export const DEFAULT_HANDLER_THRESHOLDS: HandlerThresholds = {
  toolCallThreshold: 10,
  bytesThreshold: 40 * 1024,
  requestCompressThresholdBytes: 40 * 1024,
};

export interface SkillConversationAddHandlerOptions {
  buffer: SkillBufferStorage;
  trigger: SkillTriggerService;
  thresholds?: Partial<HandlerThresholds>;
  compressOptions?: Partial<CompressOptions>;
  oversizeOptions?: Partial<OversizeOptions>;
  now?: () => number;
  /** Server-side serialization seam; production wiring supplies a distributed lock. */
  serialize?: <T>(
    session: SessionKey,
    fn: (assertOwned: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
}

export class HandlerValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "HandlerValidationError";
  }
}

export class SourceEventConflictError extends Error {
  readonly code = "SOURCE_EVENT_CONFLICT";

  constructor(
    readonly sourceEventId: string,
    readonly expectedContentHash: string,
    readonly actualContentHash: string,
  ) {
    super(`source_event_id ${sourceEventId} was already committed with different content`);
    this.name = "SourceEventConflictError";
  }
}

export class SkillConversationAddHandler {
  private readonly buffer: SkillBufferStorage;
  private readonly trigger: SkillTriggerService;
  private readonly thresholds: HandlerThresholds;
  private readonly compressOptions: CompressOptions;
  private readonly oversizeOptions: OversizeOptions;
  private readonly now: () => number;
  private readonly serialize: <T>(
    session: SessionKey,
    fn: (assertOwned: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  private readonly localTails = new Map<string, Promise<void>>();
  private readonly localOwners = new Map<string, symbol>();

  constructor(opts: SkillConversationAddHandlerOptions) {
    this.buffer = opts.buffer;
    this.trigger = opts.trigger;
    this.thresholds = { ...DEFAULT_HANDLER_THRESHOLDS, ...opts.thresholds };
    this.compressOptions = { ...DEFAULT_COMPRESS_OPTIONS, ...opts.compressOptions };
    this.oversizeOptions = { ...DEFAULT_OVERSIZE_OPTIONS, ...opts.oversizeOptions };
    this.now = opts.now ?? (() => Date.now());
    this.serialize = opts.serialize ?? ((session, fn) => this.withLocalSessionLock(session, fn));
  }

  async handle(input: AddConversationInput): Promise<AddConversationResult> {
    this.validate(input);
    const sess: SessionKey = {
      instance_id: input.instance_id,
      space_id: input.space_id,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      session_id: input.session_id,
    };
    return this.serialize(
      sess,
      (assertOwned) => this.handleSerialized(input, sess, assertOwned),
    );
  }

  private async handleSerialized(
    input: AddConversationInput,
    sess: SessionKey,
    assertOwned: () => Promise<void>,
  ): Promise<AddConversationResult> {
    const rid = input.perfRequestId;
    let state = await this.buffer.readSessionState(sess);
    state = await this.flushPendingArchives(sess, state, assertOwned, input.perfRequestId);

    const fingerprint = fingerprintInput(input);
    const sourceEventId = input.source_event_id;
    const eventKey = sourceEventId ? sourceEventKey(sourceEventId) : undefined;
    if (sourceEventId) {
      const existing = state.receipts[sourceEventKey(sourceEventId)];
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new SourceEventConflictError(
            sourceEventId,
            existing.result.receipt.content_hash,
            input.content_hash ?? fingerprint,
          );
        }
        return existing.result;
      }
    }

    const rawBytes = totalMessagesBytes(input.messages);
    const useCompress = rawBytes >= this.thresholds.requestCompressThresholdBytes;
    obsLogger.info("skill.add_handler.read_buffer", {
      req_id: rid ?? "",
      session_id: input.session_id,
      instance_id: input.instance_id,
      current_msgs: state.current.messages.length,
      raw_bytes: rawBytes,
      use_compress: useCompress,
      state_version: state.version,
    });

    const t0Prep = Date.now();
    const prepared = prepareArchivePayload(
      state.current.messages,
      input.messages,
      {
        compress: this.compressOptions,
        oversize: this.oversizeOptions,
        forceCompress: useCompress,
      },
    );
    obsLogger.info("skill.add_handler.prepare_archive", {
      req_id: rid ?? "",
      session_id: input.session_id,
      instance_id: input.instance_id,
      dur_ms: Date.now() - t0Prep,
      msg_in: input.messages.length,
      msg_out: prepared.messages.length,
      used_oversize: prepared.usedOversize,
    });
    const combinedMessages: OversizeMessage[] = prepared.messages;
    const usedOversize = prepared.usedOversize;

    const addedToolCalls = countRoles(input.messages, TOOL_CALL_ROLES);
    const nextTool = state.meta.tool_call_count + addedToolCalls;
    const nextBytes = state.meta.byte_count + rawBytes;

    const hitTool = nextTool >= this.thresholds.toolCallThreshold;
    const hitBytes = nextBytes >= this.thresholds.bytesThreshold;
    const shouldArchive = useCompress || hitTool || hitBytes;
    const acceptedAtMs = this.now();
    const receipt: ConversationReceipt = {
      receipt_id: randomUUID(),
      ...(input.source_event_id === undefined
        ? {}
        : { source_event_id: input.source_event_id }),
      content_hash: input.content_hash ?? fingerprint,
      accepted_at_ms: acceptedAtMs,
    };

    let result: StoredConversationAddResult;
    let storedEvent: StoredConversationEvent;
    let nextCurrent: ConversationSessionState["current"];
    let nextMeta: SessionMeta;

    if (shouldArchive) {
      const reason: Extract<AddConversationResult, { status: "archived" }>["archived"]["reason"] = usedOversize
        ? "oversize"
        : useCompress
          ? "compressed"
          : hitTool
            ? "tool_calls"
            : "bytes";
      const plan = this.trigger.planArchive(sess, state.meta.last_archived_at_ms);
      nextCurrent = { messages: [] };
      nextMeta = {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: 0,
        byte_count: 0,
        last_appended_at_ms: acceptedAtMs,
        last_archived_at_ms: plan.archivedAtMs,
      };
      result = {
        status: "archived",
        archived: {
          task_id: plan.taskId,
          archived_at_ms: plan.archivedAtMs,
          archive_key: plan.archiveKey,
          reason,
        },
        receipt,
      };
      storedEvent = {
        fingerprint,
        result,
        pending_archive: {
          task_id: plan.taskId,
          archived_at_ms: plan.archivedAtMs,
          archive_key: plan.archiveKey,
          messages: combinedMessages,
          task_ref_id: input.task_id,
        },
      };
    } else {
      nextCurrent = { messages: combinedMessages };
      nextMeta = {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: nextTool,
        byte_count: nextBytes,
        last_appended_at_ms: acceptedAtMs,
        last_archived_at_ms: state.meta.last_archived_at_ms,
      };
      result = { status: "ok", receipt };
      storedEvent = { fingerprint, result };
    }

    const receiptKey = eventKey ?? `receipt:${receipt.receipt_id}`;
    const committed: ConversationSessionState = {
      version: state.version + 1,
      current: nextCurrent,
      meta: nextMeta,
      receipts: { ...state.receipts, [receiptKey]: storedEvent },
    };
    const t0Commit = Date.now();
    await assertOwned();
    await this.buffer.writeSessionState(sess, committed);
    obsLogger.info("skill.add_handler.write_back", {
      req_id: rid ?? "",
      session_id: input.session_id,
      instance_id: input.instance_id,
      dur_ms: Date.now() - t0Commit,
      archived: shouldArchive,
      state_version: committed.version,
      source_event_id: input.source_event_id ?? "",
    });

    await this.flushPendingArchives(sess, committed, assertOwned, input.perfRequestId);
    return result;
  }

  private async flushPendingArchives(
    sess: SessionKey,
    state: ConversationSessionState,
    assertOwned: () => Promise<void>,
    perfRequestId?: string,
  ): Promise<ConversationSessionState> {
    let changed = false;
    for (const event of Object.values(state.receipts)) {
      const pending = event.pending_archive;
      if (!pending) continue;
      await assertOwned();
      await this.trigger.archive({
        session: sess,
        bufferAtTrigger: { messages: pending.messages },
        taskRefId: pending.task_ref_id,
        perfRequestId,
        plan: {
          taskId: pending.task_id,
          archivedAtMs: pending.archived_at_ms,
          archiveKey: pending.archive_key,
        },
      });
      delete event.pending_archive;
      changed = true;
    }
    if (!changed) return state;
    const completed = { ...state, version: state.version + 1 };
    await assertOwned();
    await this.buffer.writeSessionState(sess, completed);
    return completed;
  }

  private async withLocalSessionLock<T>(
    sess: SessionKey,
    fn: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const key = `${sess.space_id}|${sess.user_id}|${sess.team_id}|${sess.agent_id}|${sess.session_id}`;
    const previous = this.localTails.get(key) ?? Promise.resolve();
    const current = createDeferred();
    const tail = previous.then(() => current.promise);
    this.localTails.set(key, tail);
    await previous;
    const owner = Symbol(key);
    this.localOwners.set(key, owner);
    const assertOwned = async (): Promise<void> => {
      if (this.localOwners.get(key) !== owner) {
        throw new Error(`Skill conversation session lock lost for ${key}`);
      }
    };
    try {
      return await fn(assertOwned);
    } finally {
      if (this.localOwners.get(key) === owner) this.localOwners.delete(key);
      current.resolve();
      if (this.localTails.get(key) === tail) this.localTails.delete(key);
    }
  }

  private validate(input: AddConversationInput): void {
    const required: Array<keyof AddConversationInput> = [
      "instance_id",
      "session_id",
      "space_id",
      "user_id",
      "team_id",
      "agent_id",
    ];
    for (const f of required) {
      const v = input[f];
      if (typeof v !== "string" || v.length === 0) {
        throw new HandlerValidationError(String(f), `${String(f)} is required and must be non-empty string`);
      }
      if (v.includes(ID_FORBIDDEN_CHAR)) {
        throw new HandlerValidationError(
          String(f),
          `${String(f)} must not contain '|' (reserved for agent tuple)`,
        );
      }
    }
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      throw new HandlerValidationError("messages", "messages must be a non-empty array");
    }
    if (input.source_event_id !== undefined && (
      typeof input.source_event_id !== "string" ||
      input.source_event_id.length === 0 ||
      input.source_event_id.length > 256
    )) {
      throw new HandlerValidationError(
        "source_event_id",
        "source_event_id must be a non-empty string of at most 256 characters",
      );
    }
    if (input.content_hash !== undefined && (
      typeof input.content_hash !== "string" ||
      input.content_hash.length === 0 ||
      input.content_hash.length > 256
    )) {
      throw new HandlerValidationError(
        "content_hash",
        "content_hash must be a non-empty string of at most 256 characters",
      );
    }
    for (const [i, m] of input.messages.entries()) {
      if (!VALID_ROLES.has(m.role)) {
        throw new HandlerValidationError(`messages[${i}].role`, `invalid role: ${m.role}`);
      }
      if (typeof m.content !== "string") {
        throw new HandlerValidationError(`messages[${i}].content`, "content must be string");
      }
      if (TOOL_PAIR_ROLES.has(m.role)) {
        // tool_call_id 是**必须**的（tool_call 和 tool_result 通过它配对）
        // tool_name 是**可选**的：Anthropic 协议 tool_use block 里有 name, OpenAI 协议
        //   role=tool 消息本身没有 tool_name 字段, 只有 tool_call_id。要求 tool_name
        //   必填会让 proxy 侧被迫反查 assistant.tool_calls 才能填, 属于协议差异导致
        //   的绕圈；干脆放宽为 optional (对 skill 抽取而言, content 才是关键)。
        if (typeof m.tool_call_id !== "string" || m.tool_call_id.length === 0) {
          throw new HandlerValidationError(
            `messages[${i}].tool_call_id`,
            "tool_call/tool_result must carry tool_call_id",
          );
        }
        if (m.tool_name !== undefined && (typeof m.tool_name !== "string" || m.tool_name.length === 0)) {
          throw new HandlerValidationError(
            `messages[${i}].tool_name`,
            "tool_name if provided must be non-empty string",
          );
        }
      }
    }
  }
}

function totalMessagesBytes(msgs: CompressibleMessage[]): number {
  let sum = 0;
  for (const m of msgs) {
    sum += Buffer.byteLength(JSON.stringify(m), "utf8");
  }
  return sum;
}

function countRoles(msgs: CompressibleMessage[], roles: ReadonlySet<CompressibleRole>): number {
  let n = 0;
  for (const m of msgs) if (roles.has(m.role)) n++;
  return n;
}

function fingerprintInput(input: AddConversationInput): string {
  const canonical = stableStringify({
    task_id: input.task_id,
    messages: input.messages,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function sourceEventKey(sourceEventId: string): string {
  return `source:${createHash("sha256").update(sourceEventId).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Unsupported value in conversation fingerprint");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => (
    `${JSON.stringify(key)}:${stableStringify(entryValue)}`
  )).join(",")}}`;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

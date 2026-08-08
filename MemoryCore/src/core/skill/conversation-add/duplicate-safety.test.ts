import { afterEach, describe, expect, it, vi } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import type {
  IStorageBackend,
  ListObjectsOptions,
  ListResult,
  PutObjectOptions,
  StorageObject,
} from "../../storage/types.js";
import { StorageAdapter } from "../../storage/adapter.js";
import { conversationAddRequestSchema } from "../../../gateway/skill-schemas.js";
import { handleV2Route } from "../../../gateway/v2-router.js";
import {
  handleConversationAdd,
} from "../../../gateway/skill-handlers.js";
import {
  LocalSkillAgentTaskQueue,
  RedisSkillAgentTaskQueue,
  type RedisLike,
} from "./agent-task-queue.js";
import { SkillBufferStorage } from "./buffer-storage.js";
import { SkillConversationAddHandler } from "./add-handler.js";
import { SkillTriggerService } from "./trigger-service.js";
import { wireConversationAdd } from "./wire.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class MemoryBackend implements IStorageBackend {
  readonly type: "local" = "local";
  readonly objects = new Map<string, Buffer>();
  throwAfterSessionCommitOnce = false;
  failSessionCommitOnce = false;
  readDelaysMs: number[] = [];
  private readCount = 0;

  async putObject(key: string, content: string | Buffer, _opts?: PutObjectOptions): Promise<void> {
    if (this.failSessionCommitOnce && key.endsWith("/state.json")) {
      this.failSessionCommitOnce = false;
      throw new Error("secret-storage-path /credentials/internal-state.json");
    }
    this.objects.set(key, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
    if (this.throwAfterSessionCommitOnce && key.endsWith("/state.json")) {
      this.throwAfterSessionCommitOnce = false;
      throw new Error("simulated acknowledgement loss after durable commit");
    }
  }

  async appendObject(key: string, content: string | Buffer): Promise<void> {
    const previous = this.objects.get(key) ?? Buffer.alloc(0);
    const appended = Buffer.isBuffer(content) ? content : Buffer.from(content);
    this.objects.set(key, Buffer.concat([previous, appended]));
  }

  async getObject(key: string): Promise<StorageObject | null> {
    const delay = this.readDelaysMs[this.readCount++] ?? 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const content = this.objects.get(key);
    return content ? { key, content: Buffer.from(content), size: content.length } : null;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async listObjects(prefix: string, _opts?: ListObjectsOptions): Promise<ListResult> {
    const entries = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, content]) => ({
        key,
        size: content.length,
        lastModified: new Date(0),
        isDirectory: false,
      }));
    return { entries, total: entries.length };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    keys.forEach((key) => this.objects.delete(key));
    return keys.length;
  }
}

class LeaseRedis implements RedisLike {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();

  private read(key: string): { value: string; expiresAt: number } | undefined {
    const current = this.values.get(key);
    if (current && current.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return current;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    if (this.read(key)) return null;
    const pxIndex = args.indexOf("PX");
    const ttlMs = Number(args[pxIndex + 1]);
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
    return "OK";
  }

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const [key, token, ttlMs] = args;
    const current = this.read(String(key));
    if (!current || current.value !== token) return 0;
    if (script.includes("PEXPIRE")) {
      current.expiresAt = Date.now() + Number(ttlMs);
      return 1;
    }
    this.values.delete(String(key));
    return 1;
  }

  async get(key: string): Promise<string | null> {
    return this.read(key)?.value ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) removed += this.values.delete(key) ? 1 : 0;
    return removed;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    const current = this.read(key);
    if (!current) return 0;
    current.expiresAt = Date.now() + ms;
    return 1;
  }

  async sadd(): Promise<number> { return 0; }
  async srem(): Promise<number> { return 0; }
  async lpush(): Promise<number> { return 0; }
  async lrem(): Promise<number> { return 0; }
  async brpop(): Promise<[string, string] | null> { return null; }
  async rpop(): Promise<string | null> { return null; }

  clearLeases(): void {
    this.values.clear();
  }
}

const baseInput = {
  session_id: "session-1",
  space_id: "space-1",
  user_id: "user-1",
  team_id: "team-1",
  agent_id: "agent-1",
  messages: [{ role: "user" as const, content: "hello" }],
};

function makeWired(
  backend = new MemoryBackend(),
  thresholds: Partial<{ toolCallThreshold: number; bytesThreshold: number; requestCompressThresholdBytes: number }> = {},
) {
  const wired = wireConversationAdd({
    storage: new StorageAdapter(backend),
    queue: undefined,
    extractor: { extract: async () => ({ candidates: [] }) },
    logger: { info() {}, warn() {}, error() {} },
    thresholds: {
      toolCallThreshold: 1_000,
      bytesThreshold: 1_000_000,
      requestCompressThresholdBytes: 1_000_000,
      ...thresholds,
    },
    skipWorker: true,
  });
  return { backend, wired };
}

async function dispatchConversation(
  wired: ReturnType<typeof makeWired>["wired"],
  body: unknown,
): Promise<{ status: number; envelope: Record<string, unknown> }> {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.headers = {
    authorization: "Bearer key",
    "x-tdai-service-id": "space-1",
  };
  const res = new ServerResponse(req);
  let sent: { status: number; envelope: Record<string, unknown> } | undefined;
  const deps = {
    getStore: () => undefined,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    deployMode: "standalone" as const,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSkillCore: () => undefined,
    resolveConversationAdd: async () => wired,
  };

  try {
    const handled = await handleV2Route(
      req,
      res,
      "/v3/skill/conversation/add",
      "POST",
      async () => body,
      (_response, status, payload) => {
        sent = { status, envelope: requireRecord(payload, "HTTP response envelope") };
      },
      deps,
      {
        "/v3/skill/conversation/add": (routeBody, auth, requestId) => (
          handleConversationAdd(routeBody, auth, requestId, deps)
        ),
      },
    );
    if (!handled || !sent) throw new Error("conversation route did not emit an HTTP response");
    return sent;
  } finally {
    res.destroy();
    socket.destroy();
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("skill conversation ingestion duplicate safety", () => {
  it("keeps the legacy HTTP contract valid when source identity is omitted", async () => {
    const { wired } = makeWired();

    const response = await dispatchConversation(wired, baseInput);

    expect(response).toMatchObject({
      status: 200,
      envelope: {
        code: 0,
        data: {
          status: "ok",
          receipt: {
            receipt_id: expect.any(String),
            content_hash: expect.stringMatching(/^sha256:/),
            accepted_at_ms: expect.any(Number),
          },
        },
      },
    });
    const data = requireRecord(response.envelope.data, "success data");
    expect(requireRecord(data.receipt, "conversation receipt"))
      .not.toHaveProperty("source_event_id");
  });

  it("returns the original receipt for an exact replay through HTTP dispatch", async () => {
    const { wired } = makeWired();
    const body = {
      ...baseInput,
      source_event_id: "http-replay",
      content_hash: "sha256:caller-content",
    };

    const first = await dispatchConversation(wired, body);
    const replay = await dispatchConversation(wired, body);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.envelope.data).toEqual(first.envelope.data);
    await expect(wired.buffer.readCurrent(baseInput)).resolves.toEqual({
      messages: baseInput.messages,
    });
  });

  it("returns a conflict envelope for changed content through HTTP dispatch", async () => {
    const { wired } = makeWired();
    const body = { ...baseInput, source_event_id: "http-conflict" };
    await dispatchConversation(wired, body);

    const conflict = await dispatchConversation(wired, {
      ...body,
      messages: [{ role: "user", content: "changed" }],
    });

    // The gateway's established compatibility surface uses HTTP 200 for
    // multi-digit business codes; retry clients classify envelope code 40902.
    expect(conflict).toMatchObject({
      status: 200,
      envelope: {
        code: 40902,
        data: { source_event_id: "http-conflict" },
      },
    });
  });

  it("serializes concurrent distinct appends through HTTP dispatch", async () => {
    const backend = new MemoryBackend();
    backend.readDelaysMs = [0, 20, 10, 0];
    const { wired } = makeWired(backend);

    await Promise.all([
      dispatchConversation(wired, {
        ...baseInput,
        source_event_id: "http-event-a",
        messages: [{ role: "user", content: "a" }],
      }),
      dispatchConversation(wired, {
        ...baseInput,
        source_event_id: "http-event-b",
        messages: [{ role: "assistant", content: "b" }],
      }),
    ]);

    const current = await wired.buffer.readCurrent(baseInput);
    expect(current.messages.map((message) => message.content).sort()).toEqual(["a", "b"]);
  });

  it("coalesces concurrent duplicate delivery through HTTP dispatch", async () => {
    const { wired } = makeWired();
    const body = { ...baseInput, source_event_id: "http-concurrent-duplicate" };

    const [first, replay] = await Promise.all([
      dispatchConversation(wired, body),
      dispatchConversation(wired, body),
    ]);

    expect(replay.envelope.data).toEqual(first.envelope.data);
    await expect(wired.buffer.readCurrent(baseInput)).resolves.toEqual({
      messages: baseInput.messages,
    });
  });

  it("recovers the committed receipt after acknowledgement loss through HTTP dispatch", async () => {
    const backend = new MemoryBackend();
    const { wired: beforeRestart } = makeWired(backend);
    backend.throwAfterSessionCommitOnce = true;
    const body = { ...baseInput, source_event_id: "http-ack-loss" };

    const ambiguous = await dispatchConversation(beforeRestart, body);
    expect(ambiguous.envelope).toMatchObject({ code: 50001 });

    const { wired: afterRestart } = makeWired(backend);
    const replay = await dispatchConversation(afterRestart, body);
    expect(replay).toMatchObject({
      status: 200,
      envelope: {
        code: 0,
        data: { receipt: { source_event_id: "http-ack-loss" } },
      },
    });
    await expect(afterRestart.buffer.readCurrent(baseInput)).resolves.toEqual({
      messages: baseInput.messages,
    });
  });

  it("accepts exactly 500 messages through HTTP dispatch", async () => {
    const { wired } = makeWired();
    const messages = Array.from({ length: 500 }, (_, index) => ({
      role: "user" as const,
      content: `message-${index}`,
    }));

    const response = await dispatchConversation(wired, {
      ...baseInput,
      source_event_id: "http-500-messages",
      messages,
    });

    expect(response).toMatchObject({ status: 200, envelope: { code: 0 } });
    await expect(wired.buffer.readCurrent(baseInput)).resolves.toEqual({ messages });
  });

  it("rejects 501 messages through HTTP dispatch", async () => {
    const { wired } = makeWired();
    const messages = Array.from({ length: 501 }, (_, index) => ({
      role: "user" as const,
      content: `message-${index}`,
    }));

    const response = await dispatchConversation(wired, {
      ...baseInput,
      source_event_id: "http-501-messages",
      messages,
    });

    expect(response).toMatchObject({
      status: 200,
      envelope: { code: 40001, message: expect.stringContaining("messages") },
    });
    await expect(wired.buffer.readCurrent(baseInput)).resolves.toEqual({ messages: [] });
  });

  it("accepts optional source identity fields at the request boundary", () => {
    const parsed = conversationAddRequestSchema.safeParse({
      ...baseInput,
      source_event_id: "stop:session-1:turn-1",
      content_hash: "sha256:client-hash",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      source_event_id: "stop:session-1:turn-1",
      content_hash: "sha256:client-hash",
    });
    expect(conversationAddRequestSchema.safeParse(baseInput).success).toBe(true);
  });

  it.each([
    ["source_event_id", ""],
    ["source_event_id", "x".repeat(257)],
    ["source_event_id", 42],
    ["content_hash", ""],
    ["content_hash", "x".repeat(257)],
    ["content_hash", 42],
  ])("rejects invalid %s values at the request boundary", (field, value) => {
    expect(conversationAddRequestSchema.safeParse({
      ...baseInput,
      [field]: value,
    }).success).toBe(false);
  });

  it("returns the original receipt for an exact replay and rejects changed content", async () => {
    const { wired } = makeWired();
    const first = await wired.handler.handle({
      ...baseInput,
      source_event_id: "stop:session-1:turn-1",
      content_hash: "sha256:client-hash",
    });
    const replay = await wired.handler.handle({
      ...baseInput,
      source_event_id: "stop:session-1:turn-1",
      content_hash: "sha256:client-hash",
    });

    expect(replay).toEqual(first);
    expect(first.receipt).toMatchObject({
      source_event_id: "stop:session-1:turn-1",
      content_hash: "sha256:client-hash",
    });
    await expect(wired.handler.handle({
      ...baseInput,
      source_event_id: "stop:session-1:turn-1",
      messages: [{ role: "user", content: "changed" }],
    })).rejects.toMatchObject({ name: "SourceEventConflictError" });

    const current = await wired.buffer.readCurrent(baseInput);
    expect(current.messages).toEqual(baseInput.messages);
  });

  it("keeps legacy requests without source identity backward compatible", async () => {
    const { wired } = makeWired();
    const result = await handleConversationAdd(
      baseInput,
      { apiKey: "key", serviceId: "space-1" },
      "request-legacy",
      {
        getSkillCore: () => undefined,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        resolveConversationAdd: async () => wired,
      },
    );

    expect(result).toMatchObject({
      code: 0,
      data: {
        status: "ok",
        receipt: {
          receipt_id: expect.any(String),
          content_hash: expect.stringMatching(/^sha256:/),
          accepted_at_ms: expect.any(Number),
        },
      },
    });
    const data = requireRecord(result.data, "success data");
    expect(requireRecord(data.receipt, "conversation receipt"))
      .not.toHaveProperty("source_event_id");
    await expect(wired.buffer.readCurrent(baseInput)).resolves.toEqual({
      messages: baseInput.messages,
    });
  });

  it("rejects changed payload content even when the caller repeats the declared hash", async () => {
    const { wired } = makeWired();
    const original = {
      ...baseInput,
      source_event_id: "event-with-untrusted-hash",
      content_hash: "sha256:caller-value",
    };
    await wired.handler.handle(original);

    await expect(wired.handler.handle({
      ...original,
      messages: [{ role: "user", content: "changed despite repeated declared hash" }],
    })).rejects.toMatchObject({
      name: "SourceEventConflictError",
      sourceEventId: "event-with-untrusted-hash",
    });

    await expect(wired.buffer.readCurrent(baseInput)).resolves.toEqual({
      messages: baseInput.messages,
    });
  });

  it("makes a failed aggregate commit expose neither the append nor its receipt", async () => {
    const backend = new MemoryBackend();
    backend.failSessionCommitOnce = true;
    const { wired } = makeWired(backend);
    const input = { ...baseInput, source_event_id: "event-failed-before-commit" };

    await expect(wired.handler.handle(input)).rejects.toThrow("secret-storage-path");
    await expect(wired.buffer.readSessionState(baseInput)).resolves.toMatchObject({
      version: 0,
      current: { messages: [] },
      receipts: {},
    });

    const retry = await wired.handler.handle(input);
    expect(retry.receipt.source_event_id).toBe("event-failed-before-commit");
    await expect(wired.buffer.readCurrent(baseInput)).resolves.toEqual({
      messages: baseInput.messages,
    });
  });

  it("fails closed when durable session state has an invalid boundary shape", async () => {
    const backend = new MemoryBackend();
    const { wired } = makeWired(backend);
    backend.objects.set(
      wired.buffer.stateKey(baseInput),
      Buffer.from(JSON.stringify({
        version: 1,
        current: { messages: [] },
        meta: {
          session_id: baseInput.session_id,
          space_id: baseInput.space_id,
          user_id: baseInput.user_id,
          team_id: baseInput.team_id,
          agent_id: baseInput.agent_id,
          tool_call_count: 0,
          byte_count: 0,
        },
        receipts: [],
      })),
    );

    await expect(wired.buffer.readSessionState(baseInput))
      .rejects.toThrow("Corrupt skill conversation session state");
  });

  it("encodes storage identity segments without tuple collisions or traversal", () => {
    const { wired } = makeWired();
    const slashInUser = wired.buffer.stateKey({
      ...baseInput,
      user_id: "user/segment",
      team_id: "team",
    });
    const slashInTeam = wired.buffer.stateKey({
      ...baseInput,
      user_id: "user",
      team_id: "segment/team",
    });
    const traversal = wired.buffer.stateKey({ ...baseInput, session_id: ".." });

    expect(slashInUser).not.toBe(slashInTeam);
    expect(slashInUser).toContain("user%2Fsegment");
    expect(slashInTeam).toContain("segment%2Fteam");
    expect(traversal).toContain("%2E%2E");
    expect(traversal).not.toContain("/../");
  });

  it("maps changed-content replay to the public conflict envelope", async () => {
    const { wired } = makeWired();
    const deps = {
      getSkillCore: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      resolveConversationAdd: async () => wired,
    };
    const body = { ...baseInput, source_event_id: "gateway-event" };
    const first = await handleConversationAdd(
      body,
      { apiKey: "key", serviceId: "space-1" },
      "request-1",
      deps,
    );
    const conflict = await handleConversationAdd(
      { ...body, messages: [{ role: "user", content: "changed" }] },
      { apiKey: "key", serviceId: "space-1" },
      "request-2",
      deps,
    );

    expect(first).toMatchObject({ code: 0, data: { receipt: { source_event_id: "gateway-event" } } });
    expect(conflict).toMatchObject({
      code: 40902,
      data: { source_event_id: "gateway-event" },
    });
  });

  it("returns the original receipt through the public gateway on replay", async () => {
    const { wired } = makeWired();
    const deps = {
      getSkillCore: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      resolveConversationAdd: async () => wired,
    };
    const body = { ...baseInput, source_event_id: "gateway-replay" };

    const first = await handleConversationAdd(
      body,
      { apiKey: "key", serviceId: "space-1" },
      "request-first",
      deps,
    );
    const replay = await handleConversationAdd(
      body,
      { apiKey: "key", serviceId: "space-1" },
      "request-replay",
      deps,
    );

    expect(replay.code).toBe(0);
    expect(replay.data).toEqual(first.data);
    await expect(wired.buffer.readCurrent(baseInput)).resolves.toEqual({
      messages: baseInput.messages,
    });
  });

  it("rejects a body space that differs from the authenticated instance", async () => {
    const { backend, wired } = makeWired();
    const result = await handleConversationAdd(
      { ...baseInput, space_id: "attacker-space", source_event_id: "event-1" },
      { apiKey: "key", serviceId: "space-1" },
      "request-1",
      {
        getSkillCore: () => undefined,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        resolveConversationAdd: async () => wired,
      },
    );

    expect(result).toMatchObject({
      code: 40001,
      message: expect.stringContaining("space_id"),
    });
    expect(backend.objects.size).toBe(0);
  });

  it("does not expose storage failure details in the public envelope", async () => {
    const backend = new MemoryBackend();
    backend.failSessionCommitOnce = true;
    const { wired } = makeWired(backend);
    const warnings: string[] = [];
    const result = await handleConversationAdd(
      { ...baseInput, source_event_id: "event-1" },
      { apiKey: "key", serviceId: "space-1" },
      "request-1",
      {
        getSkillCore: () => undefined,
        logger: {
          debug() {},
          info() {},
          warn(message) { warnings.push(message); },
          error() {},
        },
        resolveConversationAdd: async () => wired,
      },
    );

    expect(result).toMatchObject({ code: 50001 });
    expect(result.message).not.toContain("secret-storage-path");
    expect(result.message).not.toContain("credentials");
    expect(warnings.join("\n")).not.toContain("secret-storage-path");
    expect(warnings.join("\n")).not.toContain("credentials");
  });

  it("serializes concurrent appends in one session without losing either event", async () => {
    const backend = new MemoryBackend();
    // Without server serialization these staggered legacy reads both observe
    // the empty state and the later writer overwrites the earlier append.
    backend.readDelaysMs = [0, 20, 10, 0];
    const { wired } = makeWired(backend);
    await Promise.all([
      wired.handler.handle({
        ...baseInput,
        source_event_id: "event-a",
        messages: [{ role: "user", content: "a" }],
      }),
      wired.handler.handle({
        ...baseInput,
        source_event_id: "event-b",
        messages: [{ role: "assistant", content: "b" }],
      }),
    ]);

    const current = await wired.buffer.readCurrent(baseInput);
    expect(current.messages).toHaveLength(2);
    expect(current.messages.map((message) => message.content).sort()).toEqual(["a", "b"]);
  });

  it("coalesces concurrent delivery of the same source event", async () => {
    const { wired } = makeWired();
    const input = { ...baseInput, source_event_id: "concurrent-duplicate" };

    const [first, duplicate] = await Promise.all([
      wired.handler.handle(input),
      wired.handler.handle(input),
    ]);

    expect(duplicate).toEqual(first);
    const current = await wired.buffer.readCurrent(baseInput);
    expect(current.messages).toEqual(baseInput.messages);
  });

  it("recovers a committed receipt after the acknowledgement is lost", async () => {
    const backend = new MemoryBackend();
    const { wired: beforeRestart } = makeWired(backend, { toolCallThreshold: 1 });
    backend.throwAfterSessionCommitOnce = true;
    const input = {
      ...baseInput,
      source_event_id: "event-after-crash",
      messages: [{ role: "tool_call" as const, content: "{}", tool_call_id: "call-1" }],
    };

    await expect(beforeRestart.handler.handle(input)).rejects.toThrow("acknowledgement loss");
    const { wired: afterRestart } = makeWired(backend, { toolCallThreshold: 1 });
    const replay = await afterRestart.handler.handle(input);

    expect(replay).toMatchObject({
      status: "archived",
      receipt: { source_event_id: "event-after-crash" },
    });
    const current = await afterRestart.buffer.readCurrent(baseInput);
    expect(current.messages).toEqual([]);
    const tasks = await afterRestart.buffer.readTasks(baseInput);
    expect(tasks.tasks).toHaveLength(1);
  });

  it("keeps the same-session mutex exclusive after its initial lease duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queue = new LocalSkillAgentTaskQueue();
    const releaseFirst = createDeferred();
    let active = 0;
    let maxActive = 0;
    const first = queue.withSessionMutex(
      baseInput,
      { lockTtlMs: 5, waitDeadlineMs: 100 },
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await releaseFirst.promise;
        active -= 1;
      },
    );

    vi.setSystemTime(10);
    const second = queue.withSessionMutex(
      baseInput,
      { lockTtlMs: 5, waitDeadlineMs: 100 },
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
      },
    );

    expect(maxActive).toBe(1);
    releaseFirst.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(10);
    await second;

    expect(maxActive).toBe(1);
  });

  it("fails closed before committing when session-lock ownership is lost", async () => {
    const backend = new MemoryBackend();
    const buffer = new SkillBufferStorage({ storage: new StorageAdapter(backend) });
    const queue = new LocalSkillAgentTaskQueue();
    const trigger = new SkillTriggerService({ buffer, queue });
    const handler = new SkillConversationAddHandler({
      buffer,
      trigger,
      serialize: (_session, fn) => fn(async () => {
        throw new Error("simulated session lease loss");
      }),
    });

    await expect(handler.handle({
      ...baseInput,
      source_event_id: "lost-lease",
    })).rejects.toThrow("simulated session lease loss");
    await expect(buffer.readSessionState(baseInput)).resolves.toMatchObject({
      version: 0,
      current: { messages: [] },
      receipts: {},
    });
  });

  it.each([
    ["space_id", "space-2"],
    ["user_id", "user-2"],
    ["team_id", "team-2"],
    ["agent_id", "agent-2"],
    ["session_id", "session-2"],
  ] as const)("includes %s in the session serialization scope", async (field, value) => {
    const queue = new LocalSkillAgentTaskQueue();
    let active = 0;
    let maxActive = 0;
    const bothEntered = createDeferred();
    const enter = async (session: typeof baseInput) => queue.withSessionMutex(
      session,
      { lockTtlMs: 1_000, waitDeadlineMs: 1_000 },
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 2) bothEntered.resolve();
        await bothEntered.promise;
        active -= 1;
      },
    );

    await Promise.all([
      enter(baseInput),
      enter({ ...baseInput, [field]: value }),
    ]);

    expect(maxActive).toBe(2);
  });

  it("renews the distributed same-session mutex while work is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queue = new RedisSkillAgentTaskQueue({
      client: new LeaseRedis(),
      keyPrefix: "test",
    });
    const releaseFirst = createDeferred();
    let active = 0;
    let maxActive = 0;
    const first = queue.withSessionMutex(
      baseInput,
      { lockTtlMs: 30, waitDeadlineMs: 300 },
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await releaseFirst.promise;
        active -= 1;
      },
    );

    await vi.advanceTimersByTimeAsync(90);
    const second = queue.withSessionMutex(
      baseInput,
      { lockTtlMs: 30, waitDeadlineMs: 300 },
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
      },
    );

    expect(maxActive).toBe(1);
    releaseFirst.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(50);
    await second;

    expect(maxActive).toBe(1);
  });

  it("detects a lost distributed lease through the public mutex guard", async () => {
    const redis = new LeaseRedis();
    const queue = new RedisSkillAgentTaskQueue({ client: redis, keyPrefix: "test" });

    await expect(queue.withSessionMutex(
      baseInput,
      { lockTtlMs: 1_000, waitDeadlineMs: 1_000 },
      async (lease) => {
        redis.clearLeases();
        await lease.assertOwned();
      },
    )).rejects.toThrow("session-mutex lease lost");
  });

  it("uses distinct archive keys when consecutive archives share a wall-clock millisecond", async () => {
    const backend = new MemoryBackend();
    const buffer = new SkillBufferStorage({ storage: new StorageAdapter(backend) });
    const queue = new LocalSkillAgentTaskQueue();
    const trigger = new SkillTriggerService({ buffer, queue, now: () => 42 });
    const handler = new SkillConversationAddHandler({
      buffer,
      trigger,
      thresholds: {
        toolCallThreshold: 1,
        bytesThreshold: 1_000_000,
        requestCompressThresholdBytes: 1_000_000,
      },
      now: () => 42,
      serialize: (session, fn) => queue.withSessionMutex(
        session,
        { lockTtlMs: 1_000, waitDeadlineMs: 1_000 },
        (lease) => fn(lease.assertOwned),
      ),
    });

    const first = await handler.handle({
      ...baseInput,
      source_event_id: "event-a",
      messages: [{ role: "tool_call", content: "a", tool_call_id: "call-a" }],
    });
    const second = await handler.handle({
      ...baseInput,
      source_event_id: "event-b",
      messages: [{ role: "tool_call", content: "b", tool_call_id: "call-b" }],
    });

    expect(first.archived).toBeDefined();
    expect(second.archived).toBeDefined();
    if (!first.archived || !second.archived) throw new Error("expected both requests to archive");
    expect(first.archived.archive_key).not.toBe(second.archived.archive_key);
    await expect(buffer.readArchive(first.archived.archive_key)).resolves.toMatchObject({
      messages: [{ content: "a" }],
    });
    await expect(buffer.readArchive(second.archived.archive_key)).resolves.toMatchObject({
      messages: [{ content: "b" }],
    });
  });

  it("rejects an archive-key replay when the stored content differs", async () => {
    const backend = new MemoryBackend();
    const buffer = new SkillBufferStorage({ storage: new StorageAdapter(backend) });
    await buffer.writeArchive(baseInput, 42, {
      messages: [{ role: "user", content: "first" }],
    });

    await expect(buffer.writeArchive(baseInput, 42, {
      messages: [{ role: "user", content: "different" }],
    })).rejects.toThrow("Skill archive collision");
    await expect(buffer.readArchive(buffer.archiveKey(baseInput, 42))).resolves.toEqual({
      messages: [{ role: "user", content: "first" }],
    });
  });

  it("overwrites stored task identity with the scoped agent tuple", async () => {
    const backend = new MemoryBackend();
    const buffer = new SkillBufferStorage({ storage: new StorageAdapter(backend) });
    backend.objects.set(buffer.tasksKey(baseInput), Buffer.from(JSON.stringify({
      team_id: "forged-team",
      agent_id: "forged-agent",
      updated_at_ms: 42,
      tasks: [{
        task_id: "extract-1",
        session_id: baseInput.session_id,
        space_id: "forged-space",
        user_id: "forged-user",
        team_id: "forged-team",
        agent_id: "forged-agent",
        archive_key: buffer.archiveKey(baseInput, 42),
        archived_at_ms: 42,
        enqueued_at_ms: 42,
      }, {
        task_id: "extract-cross-scope",
        session_id: baseInput.session_id,
        space_id: "forged-space",
        user_id: "forged-user",
        team_id: "forged-team",
        agent_id: "forged-agent",
        archive_key: "skill_buffer/another-user/team/agent/session/data-42.jsonl",
        archived_at_ms: 42,
        enqueued_at_ms: 42,
      }],
    })));

    const tasks = await buffer.readTasks(baseInput);

    expect(tasks).toMatchObject({
      team_id: baseInput.team_id,
      agent_id: baseInput.agent_id,
      tasks: [{
        space_id: baseInput.space_id,
        user_id: baseInput.user_id,
        team_id: baseInput.team_id,
        agent_id: baseInput.agent_id,
      }],
    });
    expect(tasks.tasks).toHaveLength(1);
  });

  it("preserves observed legacy tool-call counting and paired archive payloads", async () => {
    const { wired } = makeWired(undefined, { toolCallThreshold: 2 });
    const first = await wired.handler.handle({
      ...baseInput,
      source_event_id: "tool-pair-a",
      messages: [
        { role: "tool_call", content: "{\"command\":\"first\"}", tool_call_id: "call-a" },
        { role: "tool_result", content: "", tool_call_id: "call-a" },
      ],
    });
    const second = await wired.handler.handle({
      ...baseInput,
      source_event_id: "tool-pair-b",
      messages: [
        { role: "tool_call", content: "{\"command\":\"second\"}", tool_call_id: "call-b" },
        { role: "tool_result", content: "command failed", tool_call_id: "call-b" },
      ],
    });

    expect(first.status).toBe("ok");
    expect(second).toMatchObject({
      status: "archived",
      archived: { reason: "tool_calls" },
    });
    if (!second.archived) throw new Error("expected tool threshold archive");
    await expect(wired.buffer.readArchive(second.archived.archive_key)).resolves.toMatchObject({
      messages: [
        { role: "tool_call", tool_call_id: "call-a" },
        { role: "tool_result", tool_call_id: "call-a", content: "" },
        { role: "tool_call", tool_call_id: "call-b" },
        { role: "tool_result", tool_call_id: "call-b", content: "command failed" },
      ],
    });
  });

  it("preserves the observed legacy byte-threshold archive reason", async () => {
    const { wired } = makeWired(undefined, {
      bytesThreshold: 1,
      requestCompressThresholdBytes: 1_000_000,
    });

    const result = await wired.handler.handle({
      ...baseInput,
      source_event_id: "byte-threshold",
    });

    expect(result).toMatchObject({
      status: "archived",
      archived: { reason: "bytes" },
    });
  });

  it("preserves the observed legacy inclusive compression boundary", async () => {
    const rawBytes = baseInput.messages.reduce(
      (sum, message) => sum + Buffer.byteLength(JSON.stringify(message), "utf8"),
      0,
    );
    const { wired } = makeWired(undefined, {
      requestCompressThresholdBytes: rawBytes,
    });

    const result = await wired.handler.handle({
      ...baseInput,
      source_event_id: "compression-boundary",
    });

    expect(result).toMatchObject({
      status: "archived",
      archived: { reason: "compressed" },
    });
  });

  it("preserves the observed legacy deterministic oversize fallback", async () => {
    const backend = new MemoryBackend();
    const storage = new StorageAdapter(backend);
    const buffer = new SkillBufferStorage({ storage });
    const queue = new LocalSkillAgentTaskQueue();
    const trigger = new SkillTriggerService({ buffer, queue });
    const handler = new SkillConversationAddHandler({
      buffer,
      trigger,
      thresholds: {
        toolCallThreshold: 1_000,
        bytesThreshold: 1_000_000,
        requestCompressThresholdBytes: 1,
      },
      compressOptions: { toolContentThresholdBytes: 1_000_000 },
      oversizeOptions: {
        chunkMaxBytes: 120,
        headKeepBytes: 60,
        tailKeepBytes: 60,
        placeholderTemplate: "omitted {n} messages ({bytes} bytes)",
      },
      serialize: (session, fn) => queue.withSessionMutex(
        session,
        { lockTtlMs: 1_000, waitDeadlineMs: 1_000 },
        (lease) => fn(lease.assertOwned),
      ),
    });

    const result = await handler.handle({
      ...baseInput,
      source_event_id: "oversize-boundary",
      messages: ["first", "middle-a", "middle-b", "last"].map((label) => ({
        role: "user" as const,
        content: `${label}:${"x".repeat(50)}`,
      })),
    });

    expect(result).toMatchObject({
      status: "archived",
      archived: { reason: "oversize" },
    });
    if (!result.archived) throw new Error("expected oversize archive");
    const archive = await buffer.readArchive(result.archived.archive_key);
    expect(archive?.messages).toEqual([
      expect.objectContaining({ content: expect.stringContaining("first:") }),
      expect.objectContaining({
        role: "system",
        content: expect.stringMatching(/^omitted \d+ messages/),
      }),
      expect.objectContaining({ content: expect.stringContaining("last:") }),
    ]);
  });
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

import { describe, expect, it } from "vitest";

import type {
  IStorageBackend,
  ListObjectsOptions,
  ListResult,
  PutObjectOptions,
  StorageObject,
} from "../../storage/types.js";
import { StorageAdapter } from "../../storage/adapter.js";
import { conversationAddRequestSchema } from "../../../gateway/skill-schemas.js";
import { handleConversationAdd } from "../../../gateway/skill-handlers.js";
import {
  LocalSkillAgentTaskQueue,
  RedisSkillAgentTaskQueue,
  type RedisLike,
} from "./agent-task-queue.js";
import { SkillBufferStorage } from "./buffer-storage.js";
import { SkillConversationAddHandler } from "./add-handler.js";
import { SkillTriggerService } from "./trigger-service.js";
import { wireConversationAdd } from "./wire.js";

class MemoryBackend implements IStorageBackend {
  readonly type = "local" as const;
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

describe("skill conversation ingestion duplicate safety", () => {
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
    const result = await handleConversationAdd(
      { ...baseInput, source_event_id: "event-1" },
      { apiKey: "key", serviceId: "space-1" },
      "request-1",
      {
        getSkillCore: () => undefined,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        resolveConversationAdd: async () => wired,
      },
    );

    expect(result).toMatchObject({ code: 50001 });
    expect(result.message).not.toContain("secret-storage-path");
    expect(result.message).not.toContain("credentials");
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
    const queue = new LocalSkillAgentTaskQueue();
    let active = 0;
    let maxActive = 0;
    const enter = async (holdMs: number) => queue.withSessionMutex(
      baseInput,
      { lockTtlMs: 5, waitDeadlineMs: 100 },
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        active -= 1;
      },
    );

    const first = enter(30);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.all([first, enter(1)]);

    expect(maxActive).toBe(1);
  });

  it("renews the distributed same-session mutex while work is active", async () => {
    const queue = new RedisSkillAgentTaskQueue({
      client: new LeaseRedis(),
      keyPrefix: "test",
    });
    let active = 0;
    let maxActive = 0;
    const enter = async (holdMs: number) => queue.withSessionMutex(
      baseInput,
      { lockTtlMs: 30, waitDeadlineMs: 300 },
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        active -= 1;
      },
    );

    const first = enter(90);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([first, enter(1)]);

    expect(maxActive).toBe(1);
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
        fn,
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
});

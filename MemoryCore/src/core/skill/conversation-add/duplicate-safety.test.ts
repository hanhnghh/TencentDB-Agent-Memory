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
import { wireConversationAdd } from "./wire.js";

class MemoryBackend implements IStorageBackend {
  readonly type = "local" as const;
  readonly objects = new Map<string, Buffer>();
  throwAfterSessionCommitOnce = false;
  readDelaysMs: number[] = [];
  private readCount = 0;

  async putObject(key: string, content: string | Buffer, _opts?: PutObjectOptions): Promise<void> {
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

  it("recovers a committed receipt after the acknowledgement is lost", async () => {
    const backend = new MemoryBackend();
    const { wired } = makeWired(backend, { toolCallThreshold: 1 });
    backend.throwAfterSessionCommitOnce = true;
    const input = {
      ...baseInput,
      source_event_id: "event-after-crash",
      messages: [{ role: "tool_call" as const, content: "{}", tool_call_id: "call-1" }],
    };

    await expect(wired.handler.handle(input)).rejects.toThrow("acknowledgement loss");
    const replay = await wired.handler.handle(input);

    expect(replay).toMatchObject({
      status: "archived",
      receipt: { source_event_id: "event-after-crash" },
    });
    const current = await wired.buffer.readCurrent(baseInput);
    expect(current.messages).toEqual([]);
    const tasks = await wired.buffer.readTasks(baseInput);
    expect(tasks.tasks).toHaveLength(1);
  });
});

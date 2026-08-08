import { afterEach, describe, expect, it, vi } from "vitest";

import { TdaiClient, TdaiWriteError } from "../client.js";
import {
  __resetL0WriteOrderingForTests,
  withL0Retry,
  withL0SessionOrdering,
} from "../pending-writes.js";
import { recordTdaiTurn } from "../recorder.js";
import type { TdaiIdentity, TdaiMemoryConfig, TdaiMessage } from "../types.js";

const config: TdaiMemoryConfig = {
  enabled: true,
  endpoint: "http://memory-core.test",
  apiKey: "test-key",
  serviceId: "memory-1",
  writeL0: true,
  recallL1: true,
  injectL2L3: true,
  l1Limit: 5,
  l2Limit: 5,
  timeoutMs: 1_000,
};

const identity: TdaiIdentity = {
  teamId: "team-1",
  userId: "user-1",
  agentId: "agent-1",
  sessionId: "session-1",
};

interface ConversationWriteBody {
  sourceEventId: string;
  contentHash: string;
  messages: TdaiMessage[];
}

function parseConversationWriteBody(init: RequestInit): ConversationWriteBody {
  if (typeof init.body !== "string") throw new Error("Expected JSON request body");
  const body: unknown = JSON.parse(init.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected request object");
  const sourceEventId = Reflect.get(body, "source_event_id");
  const contentHash = Reflect.get(body, "content_hash");
  const messages = Reflect.get(body, "messages");
  if (typeof sourceEventId !== "string" || typeof contentHash !== "string" || !Array.isArray(messages)) {
    throw new Error("Expected source-event conversation request");
  }
  const parsedMessages = messages.map((message: unknown): TdaiMessage => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("Expected conversation message object");
    }
    const role = Reflect.get(message, "role");
    const content = Reflect.get(message, "content");
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      throw new Error("Expected normalized conversation message");
    }
    return { role, content };
  });
  return { sourceEventId, contentHash, messages: parsedMessages };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetL0WriteOrderingForTests();
});

describe("TdaiClient L0 write contract", () => {
  it("serializes same-session writes while keeping agent-source scopes independent", async () => {
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const scope = {
      serviceId: "memory-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      taskId: "task-1",
      agentSource: "codebuddy",
      sessionId: "session-1",
    };

    const first = withL0SessionOrdering(scope, async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = withL0SessionOrdering(scope, async () => {
      order.push("second");
    });
    const otherSource = withL0SessionOrdering({ ...scope, agentSource: "claude-code" }, async () => {
      order.push("other-source");
    });

    await otherSource;
    expect(order).toEqual(["first:start", "other-source"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other-source", "first:end", "second"]);
  });

  it("derives stable but distinct source events for separate same-turn responses", async () => {
    const seenSourceEvents: string[] = [];
    const client = {
      addConversation: vi.fn(async (
        _identity: TdaiIdentity,
        _messages: TdaiMessage[],
        options: { sourceEventId?: string; contentHash?: string } = {},
      ) => {
        seenSourceEvents.push(options.sourceEventId ?? "");
        return { acceptedIds: [], totalCount: 0, receipts: [] };
      }),
    };
    const userMessage: TdaiMessage = { role: "user", content: "run the checks" };
    const source = { sourceEventId: "proxy:session-1:turn:4" };

    await recordTdaiTurn(client, identity, userMessage, "first tool request", source);
    await recordTdaiTurn(client, identity, userMessage, "first tool request", source);
    await recordTdaiTurn(client, identity, userMessage, "final response", source);

    expect(seenSourceEvents[0]).toBe(seenSourceEvents[1]);
    expect(seenSourceEvents[2]).not.toBe(seenSourceEvents[0]);
  });

  it("replays partial batches with stable event ids and returns all receipts", async () => {
    const messages: TdaiMessage[] = Array.from({ length: 101 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
    }));
    const seenEventIds: string[] = [];
    let request = 0;
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request += 1;
      const body = parseConversationWriteBody(init);
      seenEventIds.push(body.sourceEventId);
      if (request === 2) {
        return new Response(JSON.stringify({ code: 503, message: "storage unavailable", request_id: "req-2" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const duplicate = request === 3;
      const acceptedIds = body.messages.map((_, index) => `${body.sourceEventId}-${index}`);
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        request_id: `req-${request}`,
        data: {
          accepted_ids: acceptedIds,
          accepted_versions: acceptedIds.map(() => "v1"),
          total_count: acceptedIds.length,
          receipt: {
            source_event_id: body.sourceEventId,
            content_hash: body.contentHash,
            status: duplicate ? "duplicate" : "committed",
            committed_at: "2026-08-08T00:00:00.000Z",
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await withL0Retry(
      () => new TdaiClient(config).addConversation(identity, messages, { sourceEventId: "turn-7" }),
      { attempts: 2, baseMs: 0 },
    );

    expect(seenEventIds).toEqual([
      "turn-7:batch:0-of-2",
      "turn-7:batch:1-of-2",
      "turn-7:batch:0-of-2",
      "turn-7:batch:1-of-2",
    ]);
    expect(result.totalCount).toBe(101);
    expect(result.receipts.map((receipt) => receipt.status)).toEqual(["duplicate", "committed"]);
  });

  it.each([
    { count: 100, expectedBatches: 1 },
    { count: 101, expectedBatches: 2 },
  ])("preserves the $count-message batch boundary without dropping content", async ({ count, expectedBatches }) => {
    const batches: Array<Array<{ content: string }>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = parseConversationWriteBody(init);
      batches.push(body.messages);
      const acceptedIds = body.messages.map((_, index) => `${body.sourceEventId}-${index}`);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          accepted_ids: acceptedIds,
          accepted_versions: acceptedIds.map(() => "v1"),
          total_count: acceptedIds.length,
          receipt: {
            source_event_id: body.sourceEventId,
            content_hash: body.contentHash,
            status: "committed",
            committed_at: "2026-08-08T00:00:00.000Z",
          },
        },
      }), { status: 200 });
    }));
    const messages = Array.from({ length: count }, (_, index) => ({
      role: "user" as const,
      content: `message-${index}`,
    }));

    const result = await new TdaiClient(config).addConversation(identity, messages, { sourceEventId: "boundary" });

    expect(batches).toHaveLength(expectedBatches);
    expect(batches.flat().map(({ content }) => content)).toEqual(messages.map(({ content }) => content));
    expect(result.totalCount).toBe(count);
  });

  it.each([
    { chars: 8192, expectedChunks: 1 },
    { chars: 8193, expectedChunks: 2 },
  ])("preserves all content at the $chars-character message boundary", async ({ chars, expectedChunks }) => {
    const chunks: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = parseConversationWriteBody(init);
      chunks.push(...body.messages.map(({ content }) => content));
      const acceptedIds = body.messages.map((_, index) => `${body.sourceEventId}-${index}`);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          accepted_ids: acceptedIds,
          accepted_versions: acceptedIds.map(() => "v1"),
          total_count: acceptedIds.length,
          receipt: {
            source_event_id: body.sourceEventId,
            content_hash: body.contentHash,
            status: "committed",
            committed_at: "2026-08-08T00:00:00.000Z",
          },
        },
      }), { status: 200 });
    }));
    const content = "x".repeat(chars);

    await new TdaiClient(config).addConversation(
      identity,
      [{ role: "user", content }],
      { sourceEventId: "content-boundary" },
    );

    expect(chunks).toHaveLength(expectedChunks);
    expect(chunks.join("")).toBe(content);
  });

  it.each([408, 429, 500, 503, 599])("surfaces HTTP %i write failures as typed retryable errors", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ code: status, message: "storage unavailable", request_id: "req-http" }),
      { status, headers: { "content-type": "application/json" } },
    )));

    const error = await new TdaiClient(config)
      .addConversation(identity, [{ role: "user", content: "hello" }], { sourceEventId: "event-http" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TdaiWriteError);
    expect(error).toMatchObject({ kind: "http", status, retryable: true });
  });

  it("classifies a non-JSON server failure by HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "upstream unavailable",
      { status: 503, headers: { "content-type": "text/plain" } },
    )));

    const error = await new TdaiClient(config)
      .addConversation(identity, [{ role: "user", content: "hello" }], { sourceEventId: "event-http-text" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TdaiWriteError);
    expect(error).toMatchObject({ kind: "http", status: 503, retryable: true });
    expect(String(error)).not.toContain("upstream unavailable");
  });

  it("surfaces a permanent HTTP 400 write failure as typed and non-retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ code: 400, message: "invalid request", request_id: "req-http-400" }),
      { status: 400, headers: { "content-type": "application/json" } },
    )));

    const error = await new TdaiClient(config)
      .addConversation(identity, [{ role: "user", content: "hello" }], { sourceEventId: "event-http-400" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TdaiWriteError);
    expect(error).toMatchObject({ kind: "http", status: 400, retryable: false });
  });

  it("does not retry a permanent 4xx write failure", async () => {
    const write = vi.fn(async () => {
      throw new TdaiWriteError("http", "invalid request", false, 400);
    });

    await expect(withL0Retry(write, { attempts: 3, baseMs: 0 })).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("surfaces a write timeout as a typed retryable timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const write = new TdaiClient({ ...config, timeoutMs: 10 })
      .addConversation(identity, [{ role: "user", content: "hello" }], { sourceEventId: "event-timeout" })
      .catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(10);
    const error = await write;

    expect(error).toBeInstanceOf(TdaiWriteError);
    expect(error).toMatchObject({ kind: "timeout", retryable: true });
  });

  it("rejects a success envelope with a malformed receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ code: 0, message: "ok", request_id: "req-malformed", data: {} }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const error = await new TdaiClient(config)
      .addConversation(identity, [{ role: "user", content: "hello" }], { sourceEventId: "event-malformed" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TdaiWriteError);
    expect(error).toMatchObject({ kind: "malformed", retryable: true });
  });

  it("rejects mismatched success counts as a malformed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = parseConversationWriteBody(init);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          accepted_ids: ["msg-1"],
          accepted_versions: [],
          total_count: 2,
          receipt: {
            source_event_id: body.sourceEventId,
            content_hash: body.contentHash,
            status: "committed",
            committed_at: "2026-08-08T00:00:00.000Z",
          },
        },
      }), { status: 200 });
    }));

    const error = await new TdaiClient(config)
      .addConversation(identity, [{ role: "user", content: "hello" }], { sourceEventId: "event-counts" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TdaiWriteError);
    expect(error).toMatchObject({ kind: "malformed", retryable: true });
  });

  it("surfaces network and permanent envelope failures with retry classification", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const networkError = await new TdaiClient(config)
      .addConversation(identity, [{ role: "user", content: "hello" }], { sourceEventId: "event-network" })
      .catch((caught: unknown) => caught);
    expect(networkError).toMatchObject({ kind: "network", retryable: true });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ code: 40901, message: "conflict", request_id: "req-conflict" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const envelopeError = await new TdaiClient(config)
      .addConversation(identity, [{ role: "user", content: "hello" }], { sourceEventId: "event-conflict" })
      .catch((caught: unknown) => caught);
    expect(envelopeError).toMatchObject({ kind: "envelope", code: 40901, retryable: false });
  });

  it("keeps read-path retrieval fail-soft while write failures stay observable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const client = new TdaiClient(config);

    await expect(client.searchL1(identity, "query")).resolves.toEqual([]);
    await expect(client.addConversation(
      identity,
      [{ role: "user", content: "hello" }],
      { sourceEventId: "event-write-failure" },
    )).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  it("fails ACL checks closed when an allowed-looking response omits the envelope code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { allowed: true },
    }), { status: 200 })));

    await expect(new TdaiClient(config).checkAcl({
      user_key: "user-key",
      asset_id: "asset-1",
      action: "read",
    })).rejects.toThrow("acl/check malformed response envelope");
  });
});

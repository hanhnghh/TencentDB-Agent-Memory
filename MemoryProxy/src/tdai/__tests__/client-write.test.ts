import { afterEach, describe, expect, it, vi } from "vitest";

import { TdaiClient, TdaiWriteError } from "../client.js";
import { withL0Retry } from "../pending-writes.js";
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TdaiClient L0 write contract", () => {
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
      const body = JSON.parse(String(init.body)) as {
        source_event_id: string;
        content_hash: string;
        messages: unknown[];
      };
      seenEventIds.push(body.source_event_id);
      if (request === 2) {
        return new Response(JSON.stringify({ code: 503, message: "storage unavailable", request_id: "req-2" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const duplicate = request === 3;
      const acceptedIds = body.messages.map((_: unknown, index: number) => `${body.source_event_id}-${index}`);
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        request_id: `req-${request}`,
        data: {
          accepted_ids: acceptedIds,
          accepted_versions: acceptedIds.map(() => "v1"),
          total_count: acceptedIds.length,
          receipt: {
            source_event_id: body.source_event_id,
            content_hash: body.content_hash,
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

  it.each([408, 429, 503])("surfaces HTTP %i write failures as typed retryable errors", async (status) => {
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
});

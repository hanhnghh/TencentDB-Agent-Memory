import { afterEach, describe, expect, it, vi } from "vitest";

import type { Transport } from "../src/client.js";
import { TDAMError, TDAMResponseError, TDAMTransportError } from "../src/errors.js";
import { MemoryClient } from "../src/v3/client.js";
import { V3HttpTransport } from "../src/v3/http.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("v3 conversation ingestion contract", () => {
  it("sends optional source identity and returns the typed receipt", async () => {
    const post = vi.fn(async () => ({
      accepted_ids: ["msg-stable"],
      accepted_versions: ["v1"],
      total_count: 1,
      receipt: {
        source_event_id: "event-1",
        content_hash: "hash-1",
        status: "committed" as const,
        committed_at: "2026-08-08T00:00:00.000Z",
      },
    }));
    const client = new MemoryClient({ post } as Transport, {
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "session-1",
    });

    const receipt = await client.addConversation({
      source_event_id: "event-1",
      content_hash: "hash-1",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(post).toHaveBeenCalledWith("/v3/conversation/add", expect.objectContaining({
      source_event_id: "event-1",
      content_hash: "hash-1",
    }));
    expect(receipt.receipt).toMatchObject({ source_event_id: "event-1", status: "committed" });
  });

  it("preserves legacy omission of source identity and receipt", async () => {
    const post = vi.fn(async () => ({
      accepted_ids: ["msg-legacy"],
      accepted_versions: ["v1"],
      total_count: 1,
    }));
    const client = new MemoryClient({ post } as Transport, {
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "session-1",
    });

    const result = await client.addConversation({
      messages: [{ role: "user", content: "legacy" }],
    });

    expect(post).toHaveBeenCalledWith("/v3/conversation/add", expect.not.objectContaining({
      source_event_id: expect.anything(),
      content_hash: expect.anything(),
    }));
    expect(result).not.toHaveProperty("receipt");
  });

  it("rejects malformed successful conversation responses with a typed error", async () => {
    const client = new MemoryClient({ post: vi.fn(async () => ({})) } as Transport, {
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "session-1",
    });

    const error = await client.addConversation({
      source_event_id: "event-malformed",
      messages: [{ role: "user", content: "hello" }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMResponseError);
    expect(error).toMatchObject({ kind: "malformed", retryable: true });
  });

  it("rejects mismatched success counts with a typed malformed-response error", async () => {
    const client = new MemoryClient({ post: vi.fn(async () => ({
      accepted_ids: ["msg-1"],
      accepted_versions: [],
      total_count: 2,
      receipt: {
        source_event_id: "event-counts",
        content_hash: "hash-counts",
        status: "committed" as const,
        committed_at: "2026-08-08T00:00:00.000Z",
      },
    })) } as Transport, {
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "session-1",
    });

    const error = await client.addConversation({
      source_event_id: "event-counts",
      content_hash: "hash-counts",
      messages: [{ role: "user", content: "hello" }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMResponseError);
    expect(error).toMatchObject({ kind: "malformed", retryable: true });
  });

  it("rejects a receipt whose content hash mismatches the request", async () => {
    const client = new MemoryClient({ post: vi.fn(async () => ({
      accepted_ids: ["msg-1"],
      accepted_versions: ["v1"],
      total_count: 1,
      receipt: {
        source_event_id: "event-hash",
        content_hash: "different-hash",
        status: "committed" as const,
        committed_at: "2026-08-08T00:00:00.000Z",
      },
    })) } as Transport, {
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "session-1",
    });

    const error = await client.addConversation({
      source_event_id: "event-hash",
      content_hash: "expected-hash",
      messages: [{ role: "user", content: "hello" }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMResponseError);
  });

  it("wraps network failures in a typed retryable transport error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const transport = new V3HttpTransport({
      endpoint: "http://memory-core.test",
      apiKey: "key",
      serviceId: "memory-1",
    });

    const error = await transport.post("/v3/conversation/add", {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMTransportError);
    expect(error).toMatchObject({ kind: "network", retryable: true });
  });

  it("wraps timeouts in a typed retryable timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const transport = new V3HttpTransport({
      endpoint: "http://memory-core.test",
      apiKey: "key",
      serviceId: "memory-1",
      timeout: 10,
    });
    const response = transport.post("/v3/conversation/add", {}).catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(10);
    const error = await response;

    expect(error).toBeInstanceOf(TDAMTransportError);
    expect(error).toMatchObject({ kind: "timeout", retryable: true });
  });

  it.each([408, 429, 500, 503, 599])("classifies HTTP %i as a typed retryable API error", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: status,
      message: "temporarily unavailable",
      request_id: `req-${status}`,
    }), { status, headers: { "content-type": "application/json" } })));
    const transport = new V3HttpTransport({
      endpoint: "http://memory-core.test",
      apiKey: "key",
      serviceId: "memory-1",
    });

    const error = await transport.post("/v3/conversation/add", {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMError);
    expect(error).toMatchObject({ code: status, retryable: true });
  });

  it.each([
    { status: 400, retryable: false },
    { status: 503, retryable: true },
  ])("classifies non-JSON HTTP $status by status", async ({ status, retryable }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("plain-text failure", { status })));
    const transport = new V3HttpTransport({
      endpoint: "http://memory-core.test",
      apiKey: "key",
      serviceId: "memory-1",
    });

    const error = await transport.post("/v3/conversation/add", {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMError);
    expect(error).not.toBeInstanceOf(TDAMResponseError);
    expect(error).toMatchObject({ code: status, retryable });
  });

  it("classifies a permanent business-envelope conflict as non-retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 40901,
      message: "source event conflict",
      request_id: "req-conflict",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const transport = new V3HttpTransport({
      endpoint: "http://memory-core.test",
      apiKey: "key",
      serviceId: "memory-1",
    });

    const error = await transport.post("/v3/conversation/add", {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMError);
    expect(error).toMatchObject({ code: 40901, retryable: false });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { TDAMError, TDAMResponseError, TDAMTransportError } from "../src/errors.js";
import { MemoryClient } from "../src/v3/client.js";
import { V3HttpTransport } from "../src/v3/http.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createClient(): MemoryClient {
  return new MemoryClient({
    endpoint: "http://memory-core.test",
    apiKey: "key",
    serviceId: "memory-1",
    teamId: "team-1",
    agentId: "agent-1",
    userId: "user-1",
    sessionId: "session-1",
  });
}

function stubSuccess(data: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    code: 0,
    message: "ok",
    request_id: "req-test",
    data,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call: unknown = fetchMock.mock.calls[0];
  if (!Array.isArray(call) || call.length < 2) throw new Error("Expected fetch request fixture");
  const init: unknown = call[1];
  if (!init || typeof init !== "object" || !("body" in init) || typeof init.body !== "string") {
    throw new Error("Expected JSON request body");
  }
  const body: unknown = JSON.parse(init.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected request object");
  return body;
}

describe("v3 conversation ingestion contract", () => {
  it("sends optional source identity and returns the typed receipt", async () => {
    const fetchMock = stubSuccess({
      accepted_ids: ["msg-stable"],
      accepted_versions: ["v1"],
      total_count: 1,
      receipt: {
        source_event_id: "event-1",
        content_hash: "hash-1",
        status: "committed",
        committed_at: "2026-08-08T00:00:00.000Z",
      },
    });
    const client = createClient();

    const receipt = await client.addConversation({
      source_event_id: "event-1",
      content_hash: "hash-1",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(requestBody(fetchMock)).toMatchObject({
      source_event_id: "event-1",
      content_hash: "hash-1",
    });
    expect(receipt.receipt).toMatchObject({ source_event_id: "event-1", status: "committed" });
  });

  it("preserves legacy omission of source identity and receipt", async () => {
    const fetchMock = stubSuccess({
      accepted_ids: ["msg-legacy"],
      accepted_versions: ["v1"],
      total_count: 1,
    });
    const client = createClient();

    const result = await client.addConversation({
      messages: [{ role: "user", content: "legacy" }],
    });

    expect(requestBody(fetchMock)).toEqual(expect.not.objectContaining({
      source_event_id: expect.anything(),
      content_hash: expect.anything(),
    }));
    expect(result).not.toHaveProperty("receipt");
  });

  it("rejects malformed successful conversation responses with a typed error", async () => {
    stubSuccess({});
    const client = createClient();

    const error = await client.addConversation({
      source_event_id: "event-malformed",
      messages: [{ role: "user", content: "hello" }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMResponseError);
    expect(error).toMatchObject({ kind: "invalid_response", retryable: false });
  });

  it("rejects mismatched success counts with a typed malformed-response error", async () => {
    stubSuccess({
      accepted_ids: ["msg-1"],
      accepted_versions: [],
      total_count: 2,
      receipt: {
        source_event_id: "event-counts",
        content_hash: "hash-counts",
        status: "committed",
        committed_at: "2026-08-08T00:00:00.000Z",
      },
    });
    const client = createClient();

    const error = await client.addConversation({
      source_event_id: "event-counts",
      content_hash: "hash-counts",
      messages: [{ role: "user", content: "hello" }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMResponseError);
    expect(error).toMatchObject({ kind: "invalid_response", retryable: false });
  });

  it("rejects a receipt whose content hash mismatches the request", async () => {
    stubSuccess({
      accepted_ids: ["msg-1"],
      accepted_versions: ["v1"],
      total_count: 1,
      receipt: {
        source_event_id: "event-hash",
        content_hash: "different-hash",
        status: "committed",
        committed_at: "2026-08-08T00:00:00.000Z",
      },
    });
    const client = createClient();

    const error = await client.addConversation({
      source_event_id: "event-hash",
      content_hash: "expected-hash",
      messages: [{ role: "user", content: "hello" }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TDAMResponseError);
  });

  it("rejects a receipt with an invalid commit timestamp", async () => {
    stubSuccess({
      accepted_ids: ["msg-1"],
      accepted_versions: ["v1"],
      total_count: 1,
      receipt: {
        source_event_id: "event-time",
        content_hash: "hash-time",
        status: "committed",
        committed_at: "not-a-timestamp",
      },
    });

    await expect(createClient().addConversation({
      source_event_id: "event-time",
      content_hash: "hash-time",
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toBeInstanceOf(TDAMResponseError);
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
    expect(String(error)).not.toContain("plain-text failure");
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

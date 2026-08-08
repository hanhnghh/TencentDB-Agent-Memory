import { afterEach, describe, expect, it, vi } from "vitest";

import { SkillClient } from "../src/v3/skill-client.js";
import { V3HttpTransport } from "../src/v3/http.js";

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const request = {
  session_id: "session-1",
  user_id: "user-1",
  team_id: "team-1",
  agent_id: "agent-1",
  source_event_id: "event-1",
  content_hash: "sha256:abc",
  messages: [{ role: "user" as const, content: "hello" }],
};

function client(): SkillClient {
  return new SkillClient({
    endpoint: "https://core.example",
    apiKey: "key",
    serviceId: "space-1",
  });
}

describe("TypeScript SDK skill conversation receipt", () => {
  it("sends event identity and returns the receipt", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return response({ code: 0, data: {
        status: "ok",
        receipt: {
          receipt_id: "receipt-1",
          source_event_id: "event-1",
          content_hash: "sha256:abc",
          accepted_at_ms: 42,
        },
      } });
    }));

    const result = await client().conversationAdd(request);

    expect(body).toMatchObject({ source_event_id: "event-1", content_hash: "sha256:abc" });
    expect(result.receipt.receipt_id).toBe("receipt-1");
  });

  it.each([
    [400, 40001, false, "client"],
    [408, 40001, true, "timeout"],
    [409, 40902, false, "conflict"],
    [429, 4291, true, "rate_limit"],
    [503, 50001, true, "server"],
  ])("exposes typed retry classification for HTTP %i", async (status, code, retryable, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      code,
      message: "failed",
      request_id: "request-1",
    }, status)));

    const failure = await client().conversationAdd(request).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "TDAMError",
      code,
      requestId: "request-1",
      retryable,
      kind,
    });
  });

  it("surfaces malformed success responses as typed permanent failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    const failure = await client().conversationAdd(request).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "TDAMError",
      kind: "invalid_response",
      retryable: false,
    });
  });

  it("rejects a success envelope that omits the durable receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      code: 0,
      data: { status: "ok" },
    })));

    const failure = await client().conversationAdd(request).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "TDAMError",
      kind: "invalid_response",
      retryable: false,
    });
  });

  it("rejects a non-object data payload in a generic success envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ code: 0, data: [] })));
    const transport = new V3HttpTransport({
      endpoint: "https://core.example",
      apiKey: "key",
      serviceId: "space-1",
    });

    const failure = await transport.post("/v3/skill/listing", {})
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "TDAMError",
      kind: "invalid_response",
      retryable: false,
    });
  });
});

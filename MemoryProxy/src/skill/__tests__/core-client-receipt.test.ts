import { describe, expect, it, vi } from "vitest";

import { CoreSkillClient } from "../core-client.js";

const config = {
  endpoint: "https://core.example",
  serviceToken: "token",
  serviceId: "space-1",
  timeoutMs: 1_000,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CoreSkillClient conversation receipts", () => {
  it("sends source identity and exposes the durable receipt", async () => {
    let capturedInit: RequestInit | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return response({
        code: 0,
        data: {
          status: "ok",
          receipt: {
            receipt_id: "receipt-1",
            source_event_id: "event-1",
            content_hash: "sha256:abc",
            accepted_at_ms: 42,
          },
        },
      });
    });
    const client = new CoreSkillClient(config, fetcher as typeof fetch);

    const result = await client.addConversation({
      session_id: "session-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      source_event_id: "event-1",
      content_hash: "sha256:abc",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.receipt.receipt_id).toBe("receipt-1");
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      source_event_id: "event-1",
      content_hash: "sha256:abc",
    });
  });

  it.each([
    [400, 40001, false, "client"],
    [408, 40001, true, "timeout"],
    [409, 40902, false, "conflict"],
    [429, 4291, true, "rate_limit"],
    [503, 50001, true, "server"],
  ])("classifies HTTP %i failures for retry", async (status, code, retryable, kind) => {
    const client = new CoreSkillClient(config, vi.fn(async () => response({
      code,
      message: "failed",
      request_id: "request-1",
    }, status)) as typeof fetch);

    const failure = await client.addConversation({
      session_id: "session-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      source_event_id: "event-1",
      messages: [{ role: "user", content: "hello" }],
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "CoreSkillClientError",
      code,
      httpStatus: status,
      retryable,
      kind,
      requestId: "request-1",
    });
  });

  it.each([
    [Object.assign(new Error("socket unavailable"), { name: "TypeError" }), "network"],
    [Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" }), "timeout"],
  ])("classifies %s transport failures as retryable", async (transportError, kind) => {
    const client = new CoreSkillClient(
      config,
      vi.fn(async () => { throw transportError; }) as typeof fetch,
    );

    const failure = await client.addConversation({
      session_id: "session-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      source_event_id: "event-1",
      messages: [{ role: "user", content: "hello" }],
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "CoreSkillClientError",
      kind,
      retryable: true,
    });
  });

  it.each([
    [40902, "conflict", false],
    [50001, "server", true],
  ])("classifies HTTP-200 business failure %i", async (code, kind, retryable) => {
    const client = new CoreSkillClient(
      config,
      vi.fn(async () => response({ code, message: "failed", request_id: "request-business" })) as typeof fetch,
    );

    const failure = await client.addConversation({
      session_id: "session-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      source_event_id: "event-1",
      messages: [{ role: "user", content: "hello" }],
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "CoreSkillClientError",
      code,
      kind,
      retryable,
      requestId: "request-business",
    });
  });

  it("surfaces malformed success responses as typed permanent failures", async () => {
    const client = new CoreSkillClient(
      config,
      vi.fn(async () => new Response("not-json", { status: 200 })) as typeof fetch,
    );
    const failure = await client.addConversation({
      session_id: "session-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      messages: [{ role: "user", content: "hello" }],
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "CoreSkillClientError",
      kind: "invalid_response",
      retryable: false,
    });
  });

  it("rejects a success envelope that omits the durable receipt", async () => {
    const client = new CoreSkillClient(
      config,
      vi.fn(async () => response({ code: 0, data: { status: "ok" } })) as typeof fetch,
    );
    const failure = await client.addConversation({
      session_id: "session-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      messages: [{ role: "user", content: "hello" }],
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "CoreSkillClientError",
      kind: "invalid_response",
      retryable: false,
    });
  });

  it("rejects a non-object data payload in a generic success envelope", async () => {
    const client = new CoreSkillClient(
      config,
      vi.fn(async () => response({ code: 0, data: [] })) as typeof fetch,
    );
    const failure = await client.post("/v3/skill/listing", {})
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "CoreSkillClientError",
      kind: "invalid_response",
      retryable: false,
    });
  });

  it("rejects a non-object response envelope", async () => {
    const client = new CoreSkillClient(
      config,
      vi.fn(async () => response([])) as typeof fetch,
    );

    const failure = await client.post("/v3/skill/listing", {})
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "CoreSkillClientError",
      kind: "invalid_response",
      retryable: false,
    });
  });
});

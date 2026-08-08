import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { handleAnthropicMessages } from "../anthropicHandler.js";
import {
  initAuth,
  verifyUserKey,
  verifyUserKeyWithConfig,
} from "../auth.js";
import { handleChatCompletions } from "../handler.js";
import type { ProxyConfig } from "../types.js";

afterEach(() => {
  initAuth({ enabled: false, url: "", timeoutMs: 0 });
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

describe("user-key verifier extraction", () => {
  it("preserves the legacy verifier result and request contract", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://auth.example/v3/meta/auth/verify");
      expect(new Headers(init?.headers).get("x-tdai-service-id")).toBe("memory-1");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({ user_key: "user-key-secret" });
      return jsonResponse({
        code: 0,
        data: { valid: true, user: { user_id: "user-1" } },
      });
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetcher);
    initAuth({ enabled: true, url: "https://auth.example/", timeoutMs: 5_000 });

    await expect(verifyUserKey("user-key-secret", "memory-1")).resolves.toEqual({
      userId: "user-1",
      rejected: false,
    });
    await expect(verifyUserKeyWithConfig(
      { url: "https://auth.example/", timeoutMs: 5_000 },
      "user-key-secret",
      "memory-1",
      fetcher,
    )).resolves.toEqual({
      userId: "user-1",
      rejected: false,
    });
  });

  it("rejects malformed success identities through the legacy verifier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      code: 0,
      data: { valid: true, user: { user_id: { value: "user-1" } } },
    })));
    initAuth({ enabled: true, url: "https://auth.example", timeoutMs: 5_000 });

    await expect(verifyUserKey("user-key-secret", "memory-1")).resolves.toEqual({
      userId: "",
      rejected: true,
      rejectReason: "unexpected verify response (code=0)",
    });
  });

  it("redacts credentials from verifier transport failures", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("transport exposed user-key-secret and service-secret");
    }) as typeof fetch;

    const result = await verifyUserKeyWithConfig(
      {
        url: "https://auth.example",
        timeoutMs: 5_000,
        serviceToken: "service-secret",
      },
      "user-key-secret",
      "memory-1",
      fetcher,
    );

    expect(result.rejected).toBe(true);
    expect(result.rejectReason).toContain("[REDACTED]");
    expect(result.rejectReason).not.toContain("user-key-secret");
    expect(result.rejectReason).not.toContain("service-secret");
  });

  it("preserves OpenAI and Anthropic auth failures on a Codex source path", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-tdai-service-id")).toBe("memory-1");
      return jsonResponse({ code: 0, data: { valid: false } });
    });
    vi.stubGlobal("fetch", fetcher);
    initAuth({ enabled: true, url: "https://auth.example", timeoutMs: 5_000 });
    const app = new Hono();
    const config = {} as ProxyConfig;
    app.post("/codex/:service/v1/chat/completions", (context) => (
      handleChatCompletions(context, config)
    ));
    app.post("/codex/:service/v1/messages", (context) => (
      handleAnthropicMessages(context, config)
    ));

    const openAiResponse = await app.request("/codex/memory-1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer invalid-user-key" },
      body: "{}",
    });
    const anthropicResponse = await app.request("/codex/memory-1/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "invalid-user-key" },
      body: "{}",
    });

    expect(openAiResponse.status).toBe(401);
    await expect(openAiResponse.json()).resolves.toEqual({
      error: "Authentication failed: invalid user_key",
    });
    expect(anthropicResponse.status).toBe(401);
    await expect(anthropicResponse.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Authentication failed: invalid user_key",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

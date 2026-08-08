import { afterEach, describe, expect, it, vi } from "vitest";

import { checkAclOrDeny, TdaiClient } from "../../tdai/client.js";
import { fetchAssetCapabilities } from "../../tdai/capabilities.js";
import { createApp } from "../../server.js";
import { DEFAULT_CONFIG } from "../../config.js";
import type { ProxyConfig } from "../../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("memory parity: ACL and capability gates", () => {
  it("maps per-user asset capability flags without contacting a real service", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      data: {
        items: [
          { param_name: "skill.enabled", effective_value: "false" },
          { param_name: "llm_wiki.enabled", effective_value: "1" },
          { param_name: "code_graph.enabled", effective_value: "0" },
          { param_name: "chat_memory.enabled", effective_value: "true" },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);

    await expect(fetchAssetCapabilities({
      endpoint: "http://metadata.fixture",
      apiKey: "service-token",
      serviceId: "configured-space",
      serviceIdOverride: "request-space",
      userId: "user-a",
      userKey: "user-key",
    })).resolves.toEqual({
      skill: false,
      llm_wiki: true,
      code_graph: false,
      chat_memory: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0];
    expect(init?.headers).toMatchObject({
      "x-tdai-service-id": "request-space",
      "x-tdai-user-key": "user-key",
    });
  });

  it("fails ACL checks closed when the authorization service is unavailable", async () => {
    const client = new TdaiClient({
      enabled: true,
      endpoint: "http://memory.fixture",
      apiKey: "service-token",
      serviceId: "mem-space-a",
      writeL0: true,
      recallL1: true,
      injectL2L3: true,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 50,
    });
    vi.spyOn(client, "checkAcl").mockRejectedValue(new Error("metadata unavailable"));

    await expect(checkAclOrDeny(client, {
      user_key: "user-key",
      asset_id: "chat_memory-team-a-agent-a",
      action: "read",
      agent_id: "agent-a",
    })).resolves.toEqual({ allowed: false, reason: "acl_check_error" });
  });

  it("fails ACL checks closed on a malformed success envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { allowed: "yes" },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const client = new TdaiClient({
      enabled: true,
      endpoint: "http://memory.fixture",
      apiKey: "service-token",
      serviceId: "mem-space-a",
      writeL0: true,
      recallL1: true,
      injectL2L3: true,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 50,
    });

    await expect(checkAclOrDeny(client, {
      user_key: "user-key",
      asset_id: "chat_memory-team-a-agent-a",
      action: "read",
      agent_id: "agent-a",
    })).resolves.toEqual({ allowed: false, reason: "acl_check_error" });
  });
});

describe("memory parity: existing proxy and bridge routes", () => {
  function testConfig(): ProxyConfig {
    return {
      ...structuredClone(DEFAULT_CONFIG),
      upstream: {
        url: "http://upstream.fixture/v1/chat/completions",
        apiKey: "",
        agents: {},
      },
      rateLimit: { tpm: 0, qpm: 0 },
    };
  }

  it("keeps health and both proxy protocols available with client-key passthrough", async () => {
    const openAiBody = {
      id: "response-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    };
    const anthropicBody = {
      id: "message-1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "fixture-model",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = headers.has("x-api-key") ? anthropicBody : openAiBody;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const config = testConfig();
    const app = createApp(config);

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });

    const response = await app.request("/codebuddy/mem-space-a/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer client-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture-model",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(openAiBody);

    const anthropicResponse = await app.request("/claude-code/mem-space-a/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "client-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture-model",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(anthropicResponse.status).toBe(200);
    await expect(anthropicResponse.json()).resolves.toEqual(anthropicBody);
    const upstreamCalls = fetcher.mock.calls.filter(
      ([input]) => String(input) === config.upstream.url,
    );
    expect(upstreamCalls).toHaveLength(2);
    const [, openAiInit] = upstreamCalls[0];
    const [, anthropicInit] = upstreamCalls[1];
    expect(new Headers(openAiInit?.headers).get("authorization")).toBe("Bearer client-key");
    expect(new Headers(anthropicInit?.headers).get("x-api-key")).toBe("client-key");
    expect(JSON.parse(String(openAiInit?.body))).toMatchObject({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(JSON.parse(String(anthropicInit?.body))).toMatchObject({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("keeps bridge capability allowlists ahead of the proxy catch-all", async () => {
    const app = createApp(testConfig());
    const options = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    };

    const skillRead = await app.request("/skill-bridge/v3/skill/search", options);
    const memoryRead = await app.request("/memory-bridge/v3/atomic/search", options);
    const skillWrite = await app.request("/skill-bridge/v3/skill/_gc/versions", options);
    const memoryWrite = await app.request("/memory-bridge/v3/core/write", options);

    expect(skillRead.status).toBe(401);
    expect(memoryRead.status).toBe(401);
    expect(skillWrite.status).toBe(403);
    expect(memoryWrite.status).toBe(403);
    await expect(skillRead.json()).resolves.toMatchObject({ code: 40101 });
    await expect(memoryRead.json()).resolves.toMatchObject({ code: 40101 });
    await expect(skillWrite.json()).resolves.toMatchObject({ code: 40301 });
    await expect(memoryWrite.json()).resolves.toMatchObject({ code: 40301 });
  });
});

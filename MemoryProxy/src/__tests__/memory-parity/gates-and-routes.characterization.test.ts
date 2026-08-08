import { afterEach, describe, expect, it, vi } from "vitest";

import { checkAclOrDeny, TdaiClient } from "../../tdai/client.js";
import { fetchAssetCapabilities } from "../../tdai/capabilities.js";
import { CoreKnowledgeClient } from "../../knowledge/core-client.js";
import { KnowledgeToolsInjector } from "../../injection/injectors/knowledge-tools-injector.js";
import { SkillToolsInjector } from "../../injection/injectors/skill-tools-injector.js";
import { TdaiMemoryToolsInjector } from "../../injection/injectors/tdai-tools-injector.js";
import { createApp } from "../../server.js";
import { DEFAULT_CONFIG } from "../../config.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
} from "../../session/store.js";
import type { ProxyConfig } from "../../types.js";
import type { AssetCapabilityFlags, PrewarmInput } from "../../injection/types.js";
import {
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_SESSION_INFO,
  PARITY_TASK,
} from "./fixtures.js";

afterEach(() => {
  __resetSessionStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function capabilityPrewarmInput(
  assetCapabilities: AssetCapabilityFlags,
): PrewarmInput {
  return {
    keyId: `${PARITY_IDENTITY.agentSource}:${PARITY_IDENTITY.sessionId}`,
    spaceId: PARITY_IDENTITY.spaceId,
    userId: PARITY_IDENTITY.userId,
    agentSource: PARITY_IDENTITY.agentSource,
    sessionInfo: PARITY_SESSION_INFO,
    agentDetail: PARITY_AGENT,
    taskDetail: PARITY_TASK,
    assetCapabilities,
  };
}

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

  it("suppresses skill context when the skill capability is disabled", async () => {
    const injector = new SkillToolsInjector({
      proxyBaseUrl: "http://proxy.fixture",
      allowLlmWrite: false,
    });

    await expect(injector.prewarm(capabilityPrewarmInput({
      skill: false,
      llm_wiki: true,
      code_graph: true,
      chat_memory: true,
    }))).resolves.toEqual([]);
    await expect(injector.prewarm(capabilityPrewarmInput({
      skill: true,
      llm_wiki: true,
      code_graph: true,
      chat_memory: true,
    }))).resolves.toEqual([
      expect.objectContaining({
        type: "text",
        content: expect.stringContaining("<skill_tools>"),
      }),
    ]);
  });

  it("suppresses memory context when the chat-memory capability is disabled", async () => {
    const injector = new TdaiMemoryToolsInjector({
      proxyBaseUrl: "http://proxy.fixture",
    });

    expect(injector.prewarm(capabilityPrewarmInput({
      skill: true,
      llm_wiki: true,
      code_graph: true,
      chat_memory: false,
    }))).toEqual([]);
    expect(injector.prewarm(capabilityPrewarmInput({
      skill: true,
      llm_wiki: true,
      code_graph: true,
      chat_memory: true,
    }))).toEqual([
      expect.objectContaining({
        type: "text",
        content: expect.stringContaining("<tdai_memory_tools>"),
      }),
    ]);
  });

  it.each([
    {
      disabled: "llm_wiki",
      capabilities: { skill: true, llm_wiki: false, code_graph: true, chat_memory: true },
      omittedId: "wiki-a",
      retainedId: "graph-a",
    },
    {
      disabled: "code_graph",
      capabilities: { skill: true, llm_wiki: true, code_graph: false, chat_memory: true },
      omittedId: "graph-a",
      retainedId: "wiki-a",
    },
  ] as const)(
    "suppresses $disabled knowledge context while retaining the other knowledge type",
    async ({ capabilities, omittedId, retainedId }) => {
      const client = new CoreKnowledgeClient({
        endpoint: "http://core.fixture",
        serviceToken: "service-token",
        serviceId: PARITY_IDENTITY.spaceId,
        timeoutMs: 1_000,
      }, async () => new Response(JSON.stringify({
        code: 0,
        data: {
          items: [
            {
              knowledge_id: "wiki-a",
              type: "wiki",
              service_url: "http://knowledge.fixture/v3",
              name: "Fixture Wiki",
              summary: "Wiki fixture",
              team_id: PARITY_IDENTITY.teamId,
              user_id: PARITY_IDENTITY.userId,
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
            {
              knowledge_id: "graph-a",
              type: "code-graph",
              service_url: "http://knowledge.fixture/v3",
              name: "Fixture Graph",
              summary: "Graph fixture",
              team_id: PARITY_IDENTITY.teamId,
              user_id: PARITY_IDENTITY.userId,
              repo_url: "https://example.invalid/repo.git",
              branch: "main",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          total: 2,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
      const injector = new KnowledgeToolsInjector({
        coreSkill: {
          endpoint: "http://core.fixture",
          serviceToken: "service-token",
          serviceId: PARITY_IDENTITY.spaceId,
          timeoutMs: 1_000,
        },
      }, client);

      const blocks = await injector.prewarm(capabilityPrewarmInput(capabilities));

      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain(retainedId);
      expect(blocks[0].content).not.toContain(omittedId);
    },
  );

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

  it("preserves an explicit ACL rejection from the authorization service", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({
        code: 0,
        data: { allowed: false, reason: "team_scope_denied" },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const client = new TdaiClient({
      enabled: true,
      endpoint: "http://memory.fixture",
      apiKey: "service-token",
      serviceId: PARITY_IDENTITY.spaceId,
      writeL0: true,
      recallL1: true,
      injectL2L3: true,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 50,
    });

    await expect(client.checkAcl({
      user_key: "user-key",
      asset_id: `chat_memory-${PARITY_IDENTITY.teamId}-${PARITY_IDENTITY.agentId}`,
      action: "read",
      agent_id: PARITY_IDENTITY.agentId,
    })).resolves.toEqual({ allowed: false, reason: "team_scope_denied" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [input, init] = fetcher.mock.calls[0];
    expect(String(input)).toBe("http://memory.fixture/v3/meta/acl/check");
    expect(new Headers(init?.headers).get("x-tdai-user-key")).toBe("user-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      user_key: "user-key",
      action: "read",
      agent_id: PARITY_IDENTITY.agentId,
    });
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
    const openAiRequest = {
      model: "fixture-model",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };
    const anthropicRequest = {
      model: "fixture-model",
      max_tokens: 128,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };
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
      body: JSON.stringify(openAiRequest),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(openAiBody);

    const anthropicResponse = await app.request("/claude-code/mem-space-a/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "client-key",
        "content-type": "application/json",
      },
      body: JSON.stringify(anthropicRequest),
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
    expect(JSON.parse(String(openAiInit?.body))).toEqual(openAiRequest);
    expect(JSON.parse(String(anthropicInit?.body))).toEqual(anthropicRequest);
  });

  it("preserves OpenAI and Anthropic streaming event boundaries", async () => {
    const openAiEvents = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const anthropicEvents = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"message-1","type":"message","role":"assistant","content":[],"model":"fixture-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = headers.has("x-api-key") ? anthropicEvents : openAiEvents;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    vi.stubGlobal("fetch", vi.fn(fetcher));
    const app = createApp(testConfig());

    const openAiResponse = await app.request(
      "/codebuddy/mem-space-a/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "fixture-model",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );
    const openAiText = await openAiResponse.text();

    expect(openAiResponse.status).toBe(200);
    expect(openAiResponse.headers.get("content-type")).toContain("text/event-stream");
    expect(openAiText).toContain('"content":"hel"');
    expect(openAiText).toContain('"content":"lo"');
    expect(openAiText).toContain("data: [DONE]");

    const anthropicResponse = await app.request(
      "/claude-code/mem-space-a/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": "client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "fixture-model",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );
    const anthropicText = await anthropicResponse.text();

    expect(anthropicResponse.status).toBe(200);
    expect(anthropicResponse.headers.get("content-type")).toContain("text/event-stream");
    expect(anthropicText).toContain("event: content_block_delta");
    expect(anthropicText).toContain('"text":"hello"');
    expect(anthropicText).toContain("event: message_stop");
    const streamedBodies = upstreamBodies.filter(({ stream }) => stream === true);
    expect(streamedBodies).toHaveLength(2);
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

  it("forwards authorized bridge reads with session-owned identity and service auth", async () => {
    await getSessionStore().set(
      `${PARITY_IDENTITY.agentSource}:${PARITY_IDENTITY.sessionId}`,
      {
        status: "initialized",
        keyId: `${PARITY_IDENTITY.agentSource}:${PARITY_IDENTITY.sessionId}`,
        startedAt: 1,
        attemptCount: 0,
        userId: PARITY_IDENTITY.userId,
        sessionInfo: PARITY_SESSION_INFO,
        agentDetail: PARITY_AGENT,
        taskDetail: PARITY_TASK,
      },
    );
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ code: 0, data: { source: String(input) } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    vi.stubGlobal("fetch", vi.fn(fetcher));
    const config = testConfig();
    config.coreSkill = {
      endpoint: "http://core.fixture",
      serviceToken: "service-token",
      serviceId: "configured-service",
      timeoutMs: 1_000,
    };
    config.tdai = {
      ...config.tdai,
      apiKey: "memory-token",
      serviceId: "configured-memory-space",
    };
    const app = createApp(config);
    const request = (path: string, body: Record<string, unknown>) => app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": PARITY_IDENTITY.sessionId,
      },
      body: JSON.stringify(body),
    });

    const skillResponse = await request("/skill-bridge/v3/skill/list", {
      team_id: "forged-team",
      user_id: "forged-user",
      agent_id: "forged-agent",
    });
    const memoryResponse = await request("/memory-bridge/v3/scenario/read", {
      path: "project/setup",
      team_id: "forged-team",
      user_id: "forged-user",
      agent_id: "forged-agent",
    });

    expect(skillResponse.status).toBe(200);
    expect(memoryResponse.status).toBe(200);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://core.fixture/v3/skill/list",
      "http://core.fixture/v3/scenario/read",
    ]);
    for (const { init } of calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization"))
        .toMatch(/^Bearer (service-token|memory-token)$/);
      expect(headers.get("x-tdai-service-id")).toBe(PARITY_IDENTITY.spaceId);
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        team_id: PARITY_IDENTITY.teamId,
        user_id: PARITY_IDENTITY.userId,
        agent_id: PARITY_IDENTITY.agentId,
      });
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { createApp } from "../../server.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
} from "../../session/store.js";
import type { ProxyConfig } from "../../types.js";
import { CoreSkillClient, setCoreSkillClient } from "../../skill/core-client.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import { extractLatestUserMessage, recordTdaiTurn } from "../../tdai/recorder.js";
import { TdaiClient } from "../../tdai/client.js";
import type { TdaiIdentity } from "../../tdai/types.js";
import {
  COMPLETED_ROUND_GOLDEN,
  FINAL_ASSISTANT,
  INTERMEDIATE_ASSISTANT,
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_SESSION_INFO,
  PARITY_TASK,
  PROXY_ROUND_INPUTS,
  USER_PROMPT,
} from "./fixtures.js";

const tdaiIdentity: TdaiIdentity = {
  teamId: PARITY_IDENTITY.teamId,
  userId: PARITY_IDENTITY.userId,
  agentId: PARITY_IDENTITY.agentId,
  taskId: PARITY_IDENTITY.taskId,
  sessionId: PARITY_IDENTITY.sessionId,
};

const coreSkillConfig = {
  endpoint: "http://core.fixture",
  serviceToken: "fixture-token",
  serviceId: "fixture-service",
  timeoutMs: 1_000,
} as const;

function memoryParityConfig(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream = {
    url: "http://upstream.fixture/v1/messages",
    apiKey: "",
    agents: {},
  };
  config.rateLimit = { tpm: 0, qpm: 0 };
  config.creditReport.url = "http://credit.fixture/report";
  config.sessionInit.enabled = true;
  config.tdai = {
    enabled: true,
    endpoint: "http://memory.fixture",
    apiKey: "service-token",
    serviceId: "configured-space",
    memory: {
      enabled: true,
      inject: false,
      writeL0: true,
      recallL1: false,
      injectL2L3: false,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 1_000,
    },
  };
  config.coreSkill = { ...coreSkillConfig };
  return config;
}

async function seedParitySession(): Promise<void> {
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
}

afterEach(() => {
  setCoreSkillClient(null);
  __resetSessionStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("memory parity: observed legacy intermediate L0 behavior", () => {
  it("keeps the proxy route's intermediate L0 write separate from completed-round skill ingestion", async () => {
    const config = memoryParityConfig();
    await seedParitySession();

    const l0Requests: Array<Record<string, unknown>> = [];
    const skillRequests: Array<Record<string, unknown>> = [];
    const intermediateBody = {
      id: "message-intermediate",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: INTERMEDIATE_ASSISTANT },
        {
          type: "tool_use",
          id: "tool-1",
          name: "shell",
          input: { cmd: "printf 'xin chào'" },
        },
      ],
      model: "fixture-model",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === config.upstream.url) {
        return new Response(JSON.stringify(intermediateBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === config.creditReport.url) {
        return new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v3/meta/config/user/get")) {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v3/skill/conversation/add")) {
        skillRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ code: 0, data: { status: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v3/conversation/add")) {
        l0Requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fixture URL: ${url}`);
    }));

    const app = createApp(config);
    const response = await app.request(
      `/claude-code/${PARITY_IDENTITY.spaceId}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "client-key",
          "x-conversation-id": PARITY_IDENTITY.sessionId,
          "x-user-id": PARITY_IDENTITY.userId,
        },
        body: JSON.stringify({
          model: "fixture-model",
          max_tokens: 128,
          stream: false,
          messages: [PROXY_ROUND_INPUTS[0].messages[1]],
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(intermediateBody);
    await vi.waitFor(() => expect(l0Requests).toHaveLength(1));
    expect(l0Requests[0]).toMatchObject({
      team_id: PARITY_IDENTITY.teamId,
      user_id: PARITY_IDENTITY.userId,
      agent_id: PARITY_IDENTITY.agentId,
      session_id: PARITY_IDENTITY.sessionId,
      task_id: PARITY_IDENTITY.taskId,
      messages: [
        { role: "user", content: USER_PROMPT },
        { role: "assistant", content: INTERMEDIATE_ASSISTANT },
      ],
    });
    expect(skillRequests).toHaveLength(0);
  });

  it("records each proxy HTTP response independently, including an intermediate tool-loop response", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    vi.stubGlobal("fetch", vi.fn(fetcher));
    const config = memoryParityConfig().tdai;
    const client = new TdaiClient({
      ...config.memory,
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      serviceId: config.serviceId,
    });

    await recordTdaiTurn(
      client,
      tdaiIdentity,
      { role: "user", content: USER_PROMPT },
      INTERMEDIATE_ASSISTANT,
    );
    await recordTdaiTurn(
      client,
      tdaiIdentity,
      { role: "user", content: "xin chào\nexit: 0" },
      FINAL_ASSISTANT,
    );

    // Characterization only: the approved target below deliberately does not
    // treat this per-response fragmentation as the future parity contract.
    expect(writes).toEqual([
      expect.objectContaining({
        team_id: tdaiIdentity.teamId,
        user_id: tdaiIdentity.userId,
        agent_id: tdaiIdentity.agentId,
        session_id: tdaiIdentity.sessionId,
        task_id: tdaiIdentity.taskId,
        messages: [
          { role: "user", content: USER_PROMPT },
          { role: "assistant", content: INTERMEDIATE_ASSISTANT },
        ],
      }),
      expect.objectContaining({
        team_id: tdaiIdentity.teamId,
        user_id: tdaiIdentity.userId,
        agent_id: tdaiIdentity.agentId,
        session_id: tdaiIdentity.sessionId,
        task_id: tdaiIdentity.taskId,
        messages: [
          { role: "user", content: "xin chào\nexit: 0" },
          { role: "assistant", content: FINAL_ASSISTANT },
        ],
      }),
    ]);
  });

  it("characterizes the proxy extractor treating a tool-result-shaped user message as L0 user text", () => {
    const extracted = extractLatestUserMessage([
      { role: "user", content: USER_PROMPT },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "tool output" }],
      },
    ]);

    expect(extracted).toEqual({ role: "user", content: "tool output" });
  });
});

describe("memory parity: approved completed-round target", () => {
  it.fails("commits one L0 write for the completed human round", async () => {
    const config = memoryParityConfig();
    await seedParitySession();
    const upstreamResponses = [
      {
        id: "message-intermediate",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: INTERMEDIATE_ASSISTANT },
          {
            type: "tool_use",
            id: "tool-1",
            name: "shell",
            input: { cmd: "printf 'xin chào'" },
          },
        ],
        model: "fixture-model",
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        id: "message-final",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: FINAL_ASSISTANT }],
        model: "fixture-model",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    const l0Requests: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === config.upstream.url) {
        const next = upstreamResponses.shift();
        if (!next) throw new Error("unexpected third upstream request");
        return new Response(JSON.stringify(next), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v3/conversation/add")) {
        l0Requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    vi.stubGlobal("fetch", vi.fn(fetcher));
    const app = createApp(config);
    const callProxy = (messages: Array<Record<string, unknown>>) => app.request(
      `/claude-code/${PARITY_IDENTITY.spaceId}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "client-key",
          "x-conversation-id": PARITY_IDENTITY.sessionId,
          "x-user-id": PARITY_IDENTITY.userId,
        },
        body: JSON.stringify({
          model: "fixture-model",
          max_tokens: 128,
          stream: false,
          messages,
        }),
      },
    );

    await callProxy([PROXY_ROUND_INPUTS[0].messages[1]]);
    await callProxy(PROXY_ROUND_INPUTS[0].messages.slice(1));
    await vi.waitFor(() => expect(l0Requests.length).toBeGreaterThan(0));

    expect(l0Requests).toHaveLength(1);
    expect(l0Requests[0]).toMatchObject({
      messages: [
        { role: "user", content: USER_PROMPT },
        { role: "assistant", content: FINAL_ASSISTANT },
      ],
    });
  });

  it("commits the full normalized tool-aware round to skill ingestion only after the final response", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ code: 0, data: { status: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
    const client = new CoreSkillClient(coreSkillConfig, fetcher);
    setCoreSkillClient(client);
    const fixture = PROXY_ROUND_INPUTS[0];
    const config = memoryParityConfig();
    const sessionInfo = {
      session_id: PARITY_IDENTITY.sessionId,
      space_id: PARITY_IDENTITY.spaceId,
      user_id: PARITY_IDENTITY.userId,
      team_id: PARITY_IDENTITY.teamId,
      agent_id: PARITY_IDENTITY.agentId,
      task_id: PARITY_IDENTITY.taskId,
    };

    await triggerSkillExtractIfReady({
      config,
      sessionKey: PARITY_IDENTITY.sessionId,
      agentSource: fixture.agentSource,
      sessionInfo,
      inputMessages: fixture.messages,
      assistantMessage: {
        role: "assistant",
        content: [{ type: "tool_use", id: "still-running", name: "read", input: {} }],
      },
      protocol: fixture.protocol,
    });
    expect(requests).toHaveLength(0);

    await triggerSkillExtractIfReady({
      config,
      sessionKey: PARITY_IDENTITY.sessionId,
      agentSource: fixture.agentSource,
      sessionInfo,
      inputMessages: fixture.messages,
      assistantMessage: fixture.assistantMessage,
      protocol: fixture.protocol,
      assetCapabilities: {
        skill: false,
        llm_wiki: true,
        code_graph: true,
        chat_memory: true,
      },
    });
    expect(requests).toHaveLength(0);

    await triggerSkillExtractIfReady({
      config,
      sessionKey: PARITY_IDENTITY.sessionId,
      agentSource: fixture.agentSource,
      sessionInfo,
      inputMessages: fixture.messages,
      assistantMessage: fixture.assistantMessage,
      protocol: fixture.protocol,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://core.fixture/v3/skill/conversation/add");
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
      session_id: PARITY_IDENTITY.sessionId,
      space_id: PARITY_IDENTITY.spaceId,
      user_id: PARITY_IDENTITY.userId,
      team_id: PARITY_IDENTITY.teamId,
      agent_id: PARITY_IDENTITY.agentId,
      task_id: PARITY_IDENTITY.taskId,
      messages: COMPLETED_ROUND_GOLDEN,
    });
  });
});

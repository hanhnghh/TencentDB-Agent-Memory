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
import { flushPendingWrites } from "../../tdai/pending-writes.js";
import type { TdaiIdentity } from "../../tdai/types.js";
import {
  InMemoryMemoryRuntimeAdapters,
  MemoryRuntime,
  type CommitCompletedRoundInput,
  type MemoryRuntimeContract,
} from "../../runtime/index.js";
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
import { parseRequestBody } from "./test-support.js";

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

function l0SuccessResponse(init?: RequestInit): Response {
  const body = parseRequestBody(init);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const acceptedIds = messages.map((_, index) => `fixture-message-${index}`);
  const sourceEventId = body.source_event_id;
  const contentHash = body.content_hash;
  const receipt = typeof sourceEventId === "string" && typeof contentHash === "string"
    ? {
        source_event_id: sourceEventId,
        content_hash: contentHash,
        status: "committed",
        committed_at: "2026-08-08T00:00:00.000Z",
      }
    : undefined;
  return new Response(JSON.stringify({
    code: 0,
    data: {
      accepted_ids: acceptedIds,
      accepted_versions: acceptedIds.map(() => "v1"),
      total_count: acceptedIds.length,
      receipt,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function seedParitySession(
  agentSource: string = PARITY_IDENTITY.agentSource,
): Promise<void> {
  await getSessionStore().set(
    `${agentSource}:${PARITY_IDENTITY.sessionId}`,
    {
      status: "initialized",
      keyId: `${agentSource}:${PARITY_IDENTITY.sessionId}`,
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
  it("keeps the Anthropic proxy route's intermediate L0 write separate from completed-round skill ingestion", async () => {
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
        skillRequests.push(parseRequestBody(init));
        return new Response(JSON.stringify({ code: 0, data: { status: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v3/conversation/add")) {
        l0Requests.push(parseRequestBody(init));
        return l0SuccessResponse(init);
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
    await expect(flushPendingWrites(1_000)).resolves.toEqual({
      drained: true,
      remaining: 0,
    });
    expect(l0Requests).toHaveLength(1);
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

  it("keeps the OpenAI proxy route's intermediate L0 write separate from completed-round skill ingestion", async () => {
    const config = memoryParityConfig();
    await seedParitySession("codebuddy");

    const l0Requests: Array<Record<string, unknown>> = [];
    const skillRequests: Array<Record<string, unknown>> = [];
    const intermediateBody = {
      id: "chatcmpl-intermediate",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: INTERMEDIATE_ASSISTANT,
          tool_calls: [{
            id: "tool-1",
            type: "function",
            function: {
              name: "shell",
              arguments: JSON.stringify({ cmd: "printf 'xin chào'" }),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
        skillRequests.push(parseRequestBody(init));
        return new Response(JSON.stringify({ code: 0, data: { status: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v3/conversation/add")) {
        l0Requests.push(parseRequestBody(init));
        return l0SuccessResponse(init);
      }
      throw new Error(`unexpected fixture URL: ${url}`);
    }));

    const app = createApp(config);
    const response = await app.request(
      `/codebuddy/${PARITY_IDENTITY.spaceId}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "x-conversation-id": PARITY_IDENTITY.sessionId,
          "x-user-id": PARITY_IDENTITY.userId,
        },
        body: JSON.stringify({
          model: "fixture-model",
          stream: false,
          messages: [PROXY_ROUND_INPUTS[1].messages[1]],
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(intermediateBody);
    await expect(flushPendingWrites(1_000)).resolves.toEqual({
      drained: true,
      remaining: 0,
    });
    expect(l0Requests).toHaveLength(1);
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
      writes.push(parseRequestBody(init));
      return l0SuccessResponse(init);
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
  it.fails("commits one Anthropic L0 write for the completed human round", async () => {
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
        l0Requests.push(parseRequestBody(init));
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
    await expect(flushPendingWrites(1_000)).resolves.toEqual({
      drained: true,
      remaining: 0,
    });

    expect(l0Requests).toHaveLength(1);
    expect(l0Requests[0]).toMatchObject({
      messages: [
        { role: "user", content: USER_PROMPT },
        { role: "assistant", content: FINAL_ASSISTANT },
      ],
    });
  });

  it("commits one OpenAI completed human round through MemoryRuntime", async () => {
    const config = memoryParityConfig();
    config.injection.enabled = true;
    config.injection.assetReflection = { markerOptIn: true };
    await seedParitySession("codebuddy");
    const runtimeAdapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: "codebuddy",
          sessionId: PARITY_IDENTITY.sessionId,
        },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        sessionInfo: PARITY_SESSION_INFO,
        resolution: "cached",
      },
      context: {
        blocks: [{
          id: "skill-tools-injector:0",
          sourceHookId: "skill-tools-injector",
          kind: "skill",
          order: 1,
          type: "text",
          content: "runtime-prepared-context",
        }],
        diagnostics: { prewarmed: ["skill-tools-injector"], cacheHits: [], degraded: [] },
      },
    });
    const runtime = new MemoryRuntime(runtimeAdapters);
    const upstreamResponses = [
      {
        id: "chatcmpl-intermediate",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: INTERMEDIATE_ASSISTANT,
            tool_calls: [{
              id: "tool-1",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({ cmd: "printf 'xin chào'" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        id: "chatcmpl-final",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: FINAL_ASSISTANT },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      [
        `data: ${JSON.stringify({
          id: "chatcmpl-final-stream",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: FINAL_ASSISTANT }, finish_reason: "stop" }],
        })}`,
        `data: ${JSON.stringify({
          id: "chatcmpl-final-stream",
          object: "chat.completion.chunk",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
    ];
    const l0Requests: Array<Record<string, unknown>> = [];
    const upstreamRequests: Array<Record<string, unknown>> = [];
    const upstreamAuthorizations: Array<string | null> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === config.upstream.url) {
        upstreamRequests.push(parseRequestBody(init));
        upstreamAuthorizations.push(new Headers(init?.headers).get("authorization"));
        const next = upstreamResponses.shift();
        if (!next) throw new Error("unexpected third upstream request");
        return new Response(typeof next === "string" ? next : JSON.stringify(next), {
          status: 200,
          headers: { "content-type": typeof next === "string" ? "text/event-stream" : "application/json" },
        });
      }
      if (url.endsWith("/v3/conversation/add")) {
        l0Requests.push(parseRequestBody(init));
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    vi.stubGlobal("fetch", vi.fn(fetcher));
    const app = createApp(config, {
      openAIMemoryRuntimeProvider: { forRequest: () => runtime },
    });
    const callProxy = (messages: Array<Record<string, unknown>>) => app.request(
      `/codebuddy/${PARITY_IDENTITY.spaceId}/analyse/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "x-conversation-id": PARITY_IDENTITY.sessionId,
          "x-user-id": PARITY_IDENTITY.userId,
        },
        body: JSON.stringify({
          model: "fixture-model",
          stream: false,
          messages,
        }),
      },
    );

    const intermediateResponse = await callProxy([PROXY_ROUND_INPUTS[1].messages[1]]);
    const finalResponse = await callProxy(PROXY_ROUND_INPUTS[1].messages.slice(1));
    expect(intermediateResponse.status).toBe(200);
    expect((await intermediateResponse.json() as { id: string }).id).toBe("chatcmpl-intermediate");
    expect(finalResponse.status).toBe(200);
    expect((await finalResponse.json() as { id: string }).id).toBe("chatcmpl-final");
    const streamResponse = await app.request(
      `/codebuddy/${PARITY_IDENTITY.spaceId}/analyse/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "x-conversation-id": PARITY_IDENTITY.sessionId,
          "x-user-id": PARITY_IDENTITY.userId,
        },
        body: JSON.stringify({
          model: "fixture-model",
          stream: true,
          messages: PROXY_ROUND_INPUTS[1].messages.slice(1),
        }),
      },
    );
    const streamText = await streamResponse.text();
    expect(streamText).toContain(`"content":"${FINAL_ASSISTANT}"`);
    expect(streamText).toContain("data: [DONE]");
    await expect(flushPendingWrites(1_000)).resolves.toEqual({
      drained: true,
      remaining: 0,
    });

    expect(l0Requests).toHaveLength(0);
    expect(upstreamAuthorizations).toEqual([
      "Bearer client-key",
      "Bearer client-key",
      "Bearer client-key",
    ]);
    expect(JSON.stringify(upstreamRequests[0].messages)).toContain("runtime-prepared-context");
    expect(JSON.stringify(upstreamRequests[0].messages)).toContain("<asset_reflection>");
    expect(runtimeAdapters.enqueuedRounds).toHaveLength(2);
    expect(runtimeAdapters.enqueuedRounds[0]).toMatchObject({
      identity: { agentSource: "codebuddy", turnId: "turn-1" },
      l0: { messages: [
        { role: "user", content: USER_PROMPT },
        { role: "assistant", content: FINAL_ASSISTANT },
      ] },
      skill: { messages: COMPLETED_ROUND_GOLDEN },
    });
    expect(runtimeAdapters.enqueuedRounds[1]).toEqual(runtimeAdapters.enqueuedRounds[0]);
  });

  it("keeps local mem-command interception while committing through MemoryRuntime", async () => {
    const config = memoryParityConfig();
    config.memCommand = { enabled: true, allowedCommands: ["help"] };
    await seedParitySession("codebuddy");
    const runtimeAdapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: "codebuddy",
          sessionId: PARITY_IDENTITY.sessionId,
        },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        sessionInfo: PARITY_SESSION_INFO,
        resolution: "cached",
      },
    });
    const runtime = new MemoryRuntime(runtimeAdapters);
    const fetcher = vi.fn(async () => {
      throw new Error("mem:help must not be forwarded upstream");
    });
    vi.stubGlobal("fetch", fetcher);
    const app = createApp(config, {
      openAIMemoryRuntimeProvider: { forRequest: () => runtime },
    });

    const response = await app.request(
      `/codebuddy/${PARITY_IDENTITY.spaceId}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "x-conversation-id": PARITY_IDENTITY.sessionId,
          "x-user-id": PARITY_IDENTITY.userId,
        },
        body: JSON.stringify({
          model: "fixture-model",
          stream: false,
          messages: [{ role: "user", content: "mem:help" }],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect(runtimeAdapters.enqueuedRounds).toHaveLength(1);
    expect(runtimeAdapters.enqueuedRounds[0].l0.messages).toEqual([
      { role: "user", content: "mem:help" },
      expect.objectContaining({ role: "assistant" }),
    ]);
  });

  it("still commits on a no-space route when context preparation fails", async () => {
    const config = memoryParityConfig();
    config.tdai.serviceId = PARITY_IDENTITY.spaceId;
    await seedParitySession("codebuddy");
    const committed: CommitCompletedRoundInput[] = [];
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => { throw new Error("context backend unavailable"); },
      commitCompletedRound: async (input) => {
        committed.push(input);
        return { status: "skipped", sourceEventId: input.sourceEventId, reason: "fixture" };
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === config.upstream.url) {
        return new Response(JSON.stringify({
          id: "chatcmpl-no-space",
          choices: [{ message: { role: "assistant", content: FINAL_ASSISTANT } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const app = createApp(config, {
      openAIMemoryRuntimeProvider: { forRequest: () => runtime },
    });

    const response = await app.request("/codebuddy/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer client-key",
        "content-type": "application/json",
        "x-conversation-id": PARITY_IDENTITY.sessionId,
        "x-user-id": PARITY_IDENTITY.userId,
      },
      body: JSON.stringify({
        model: "fixture-model",
        stream: false,
        messages: [{ role: "user", content: USER_PROMPT }],
      }),
    });

    expect(response.status).toBe(200);
    expect(committed).toHaveLength(1);
    expect(committed[0].identity.serviceId).toBe(PARITY_IDENTITY.spaceId);
    expect(committed[0].realPrompt).toBe(USER_PROMPT);
  });

  it("does not acknowledge an upstream success when durable enqueue fails", async () => {
    const config = memoryParityConfig();
    await seedParitySession("codebuddy");
    const runtime = new MemoryRuntime(new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: "codebuddy",
          sessionId: PARITY_IDENTITY.sessionId,
        },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        sessionInfo: PARITY_SESSION_INFO,
        resolution: "cached",
      },
    }));
    const failingRuntime: MemoryRuntimeContract = {
      prepareContext: (input) => runtime.prepareContext(input),
      commitCompletedRound: async () => { throw new Error("outbox disk unavailable"); },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === config.upstream.url) {
        return new Response(JSON.stringify({
          id: "chatcmpl-storage-failure",
          choices: [{ message: { role: "assistant", content: FINAL_ASSISTANT } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const app = createApp(config, {
      openAIMemoryRuntimeProvider: { forRequest: () => failingRuntime },
    });

    const response = await app.request(
      `/codebuddy/${PARITY_IDENTITY.spaceId}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "x-conversation-id": PARITY_IDENTITY.sessionId,
          "x-user-id": PARITY_IDENTITY.userId,
        },
        body: JSON.stringify({
          model: "fixture-model",
          stream: false,
          messages: [{ role: "user", content: USER_PROMPT }],
        }),
      },
    );

    expect(response.status).toBe(500);
  });

  it.each(PROXY_ROUND_INPUTS)(
    "$protocol proxy commits the full normalized tool-aware round to skill ingestion only after the final response",
    async (fixture) => {
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
        assistantMessage: fixture.protocol === "anthropic"
          ? {
              role: "assistant",
              content: [{ type: "tool_use", id: "still-running", name: "read", input: {} }],
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "still-running",
                type: "function",
                function: { name: "read", arguments: "{}" },
              }],
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
      expect(parseRequestBody(requests[0].init)).toMatchObject({
        session_id: PARITY_IDENTITY.sessionId,
        space_id: PARITY_IDENTITY.spaceId,
        user_id: PARITY_IDENTITY.userId,
        team_id: PARITY_IDENTITY.teamId,
        agent_id: PARITY_IDENTITY.agentId,
        task_id: PARITY_IDENTITY.taskId,
        messages: COMPLETED_ROUND_GOLDEN,
      });
    },
  );
});

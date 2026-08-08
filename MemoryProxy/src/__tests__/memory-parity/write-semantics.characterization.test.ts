import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { createApp } from "../../server.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
} from "../../session/store.js";
import type { ProxyConfig } from "../../types.js";
import {
  InMemoryMemoryRuntimeAdapters,
  MemoryRuntime,
  MemoryRuntimeAuthorizationError,
  MemoryRuntimeContextError,
  type CommitCompletedRoundInput,
  type MemoryRuntimeContract,
} from "../../runtime/index.js";
import { buildAnthropicCompletedRound } from "../../runtime/anthropic-adapter.js";
import { buildOpenAICompletedRound } from "../../runtime/openai-adapter.js";
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
  __resetSessionStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("memory parity: removed legacy orchestration", () => {
  it("does not run direct Anthropic writers without a MemoryRuntime", async () => {
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
        throw new Error("legacy skill writer must not be called");
      }
      if (url.endsWith("/v3/conversation/add")) {
        l0Requests.push(parseRequestBody(init));
        throw new Error("legacy L0 writer must not be called");
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
    expect(l0Requests).toHaveLength(0);
    expect(skillRequests).toHaveLength(0);
  });

  it("does not run direct OpenAI writers without a MemoryRuntime", async () => {
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
        throw new Error("legacy skill writer must not be called");
      }
      if (url.endsWith("/v3/conversation/add")) {
        l0Requests.push(parseRequestBody(init));
        throw new Error("legacy L0 writer must not be called");
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
    expect(l0Requests).toHaveLength(0);
    expect(skillRequests).toHaveLength(0);
  });

  it.each(PROXY_ROUND_INPUTS)(
    "does not commit a $protocol intermediate tool response",
    (fixture) => {
      const builder = fixture.protocol === "anthropic"
        ? buildAnthropicCompletedRound
        : buildOpenAICompletedRound;
      const intermediate = fixture.protocol === "anthropic"
        ? {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool-1", name: "shell", input: {} }],
          }
        : {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "tool-1", function: { name: "shell", arguments: "{}" } }],
          };
      expect(builder({
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          userId: PARITY_IDENTITY.userId,
          agentSource: fixture.agentSource,
          sessionId: PARITY_IDENTITY.sessionId,
        },
        turnSequence: 1,
        inputMessages: fixture.messages,
        assistantMessage: intermediate,
      })).toBeNull();
    },
  );
});

describe("memory parity: approved completed-round target", () => {
  it("commits one Anthropic completed human round through MemoryRuntime", async () => {
    const config = memoryParityConfig();
    config.injection.enabled = true;
    config.injection.assetReflection = { markerOptIn: true };
    await seedParitySession();
    const runtimeAdapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: PARITY_IDENTITY.agentSource,
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
      [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 1, output_tokens: 0 } },
        })}`,
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: FINAL_ASSISTANT },
        })}`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        })}`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
        "",
      ].join("\n\n"),
    ];
    const l0Requests: Array<Record<string, unknown>> = [];
    const upstreamRequests: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === config.upstream.url) {
        upstreamRequests.push(parseRequestBody(init));
        const next = upstreamResponses.shift();
        if (!next) throw new Error("unexpected third upstream request");
        return new Response(typeof next === "string" ? next : JSON.stringify(next), {
          status: 200,
          headers: {
            "content-type": typeof next === "string" ? "text/event-stream" : "application/json",
          },
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
      memoryRuntimeProvider: { forRequest: () => runtime },
    });
    const callProxy = (messages: Array<Record<string, unknown>>) => app.request(
      `/claude-code/${PARITY_IDENTITY.spaceId}/analyse/v1/messages`,
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
          system: [{
            type: "text",
            text: "base-system",
            cache_control: { type: "ephemeral" },
          }],
          messages,
        }),
      },
    );

    const intermediate = await callProxy([PROXY_ROUND_INPUTS[0].messages[1]]);
    const final = await callProxy(PROXY_ROUND_INPUTS[0].messages.slice(1));
    expect(intermediate.status).toBe(200);
    expect(final.status).toBe(200);
    const stream = await app.request(
      `/claude-code/${PARITY_IDENTITY.spaceId}/analyse/v1/messages`,
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
          stream: true,
          messages: PROXY_ROUND_INPUTS[0].messages.slice(1),
        }),
      },
    );
    const streamText = await stream.text();
    expect(streamText).toContain(`"text":"${FINAL_ASSISTANT}"`);
    expect(streamText).toContain("event: message_stop");
    expect(l0Requests).toHaveLength(0);
    expect(JSON.stringify(upstreamRequests[0].system)).toContain("runtime-prepared-context");
    expect(JSON.stringify(upstreamRequests[0].system)).toContain("<asset_reflection>");
    expect(upstreamRequests[0].system).toEqual(expect.arrayContaining([
      expect.objectContaining({ cache_control: { type: "ephemeral" } }),
    ]));
    expect(runtimeAdapters.enqueuedRounds).toHaveLength(2);
    expect(runtimeAdapters.enqueuedRounds[0]).toMatchObject({
      identity: { agentSource: "claude-code", turnId: "turn-1" },
      l0: { messages: [
        { role: "user", content: USER_PROMPT },
        { role: "assistant", content: FINAL_ASSISTANT },
      ] },
      skill: { messages: COMPLETED_ROUND_GOLDEN },
    });
    expect(runtimeAdapters.enqueuedRounds[1]).toEqual(runtimeAdapters.enqueuedRounds[0]);
  });

  it("keeps Anthropic fork reads read-only and bypasses sidequeries", async () => {
    const config = memoryParityConfig();
    config.ccRequestRouting = { enabled: true };
    config.injection.enabled = false;
    await seedParitySession();

    const prepareInputs: Array<{ readOnly?: boolean }> = [];
    const commits: CommitCompletedRoundInput[] = [];
    const runtime: MemoryRuntimeContract = {
      async prepareContext(input) {
        prepareInputs.push({ readOnly: input.readOnly });
        return {
          session: {
            identity: {
              serviceId: PARITY_IDENTITY.spaceId,
              teamId: PARITY_IDENTITY.teamId,
              userId: PARITY_IDENTITY.userId,
              agentId: PARITY_IDENTITY.agentId,
              taskId: PARITY_IDENTITY.taskId,
              agentSource: PARITY_IDENTITY.agentSource,
              sessionId: PARITY_IDENTITY.sessionId,
            },
            agent: PARITY_AGENT,
            task: PARITY_TASK,
          },
          blocks: [],
          capabilities: {
            memory: { enabled: true },
            skill: { enabled: true },
            knowledge: { wiki: { enabled: true }, codeGraph: { enabled: true } },
          },
          diagnostics: { binding: "cached", prewarmed: [], cacheHits: [], degraded: [] },
        };
      },
      async commitCompletedRound(input) {
        commits.push(input);
        return {
          status: "enqueued",
          record: {
            sourceEventId: input.sourceEventId,
            contentHash: "fixture-hash",
            state: "pending",
            attemptCount: 0,
            nextAttemptAt: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        };
      },
    };
    const forRequest = vi.fn(() => runtime);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === config.upstream.url) {
        return new Response(JSON.stringify({
          id: "message-final",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: FINAL_ASSISTANT }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const app = createApp(config, { memoryRuntimeProvider: { forRequest } });
    const request = (body: Record<string, unknown>) => app.request(
      `/claude-code/${PARITY_IDENTITY.spaceId}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "client-key",
          "x-conversation-id": PARITY_IDENTITY.sessionId,
          "x-user-id": PARITY_IDENTITY.userId,
        },
        body: JSON.stringify({ model: "fixture-model", max_tokens: 128, stream: false, ...body }),
      },
    );

    await request({
      tools: [{ name: "shell", input_schema: { type: "object" } }],
      messages: [{
        role: "user",
        content: [{ type: "text", text: USER_PROMPT, cache_control: { type: "ephemeral" } }],
      }],
    });
    await request({
      tools: [{ name: "shell", input_schema: { type: "object" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }],
        },
        { role: "user", content: [{ type: "text", text: "fork query" }] },
      ],
    });
    await request({
      tools: [],
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: [{ type: "text", text: "title query" }] }],
    });

    expect(forRequest).toHaveBeenCalledTimes(2);
    expect(prepareInputs).toEqual([{ readOnly: false }, { readOnly: true }]);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      identity: { turnId: "turn-1" },
      realPrompt: USER_PROMPT,
      finalResponse: FINAL_ASSISTANT,
    });
  });

  it("commits Anthropic no-space routes even when context preparation degrades", async () => {
    const config = memoryParityConfig();
    config.tdai.serviceId = PARITY_IDENTITY.spaceId;
    await seedParitySession();
    const committed: CommitCompletedRoundInput[] = [];
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => {
        throw new MemoryRuntimeContextError(new Error("context backend unavailable"));
      },
      commitCompletedRound: async (input) => {
        committed.push(input);
        return { status: "skipped", sourceEventId: input.sourceEventId, reason: "fixture" };
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === config.upstream.url) {
        return new Response(JSON.stringify({
          id: "message-no-space",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: FINAL_ASSISTANT }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

    const response = await app.request("/claude-code/v1/messages", {
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
        messages: [{ role: "user", content: [{ type: "text", text: USER_PROMPT }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      identity: { serviceId: PARITY_IDENTITY.spaceId },
      realPrompt: USER_PROMPT,
      finalResponse: FINAL_ASSISTANT,
    });
  });

  it("fails closed when Anthropic runtime read authorization is denied", async () => {
    const config = memoryParityConfig();
    await seedParitySession();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => {
        throw new MemoryRuntimeAuthorizationError("read", "fixture-denied");
      },
      commitCompletedRound: vi.fn(),
    };
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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
          messages: [{ role: "user", content: [{ type: "text", text: USER_PROMPT }] }],
        }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: { type: "permission_error", message: "Memory access denied" },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(runtime.commitCompletedRound).not.toHaveBeenCalled();
  });

  it("returns Anthropic service unavailable when runtime preparation fails unexpectedly", async () => {
    const config = memoryParityConfig();
    await seedParitySession();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => {
        throw new Error("capability backend unavailable");
      },
      commitCompletedRound: vi.fn(),
    };
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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
          messages: [{ role: "user", content: [{ type: "text", text: USER_PROMPT }] }],
        }),
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: { type: "api_error", message: "Memory service unavailable" },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(runtime.commitCompletedRound).not.toHaveBeenCalled();
  });

  it("binds and commits through runtime when legacy session recovery fails", async () => {
    const config = memoryParityConfig();
    await seedParitySession();
    vi.spyOn(getSessionStore(), "getOrRecover").mockRejectedValueOnce(
      new Error("legacy recovery unavailable"),
    );
    const prepareContext = vi.fn(async () => ({
      session: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: PARITY_IDENTITY.agentSource,
          sessionId: PARITY_IDENTITY.sessionId,
        },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
      },
      blocks: [],
      capabilities: {
        memory: { enabled: true },
        skill: { enabled: true },
        knowledge: { wiki: { enabled: true }, codeGraph: { enabled: true } },
      },
      diagnostics: { binding: "recovered" as const, prewarmed: [], cacheHits: [], degraded: [] },
    }));
    const committed: CommitCompletedRoundInput[] = [];
    const runtime: MemoryRuntimeContract = {
      prepareContext,
      async commitCompletedRound(input) {
        committed.push(input);
        return { status: "skipped", sourceEventId: input.sourceEventId, reason: "fixture" };
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === config.upstream.url) {
        return new Response(JSON.stringify({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: FINAL_ASSISTANT }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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
          messages: [{ role: "user", content: [{ type: "text", text: USER_PROMPT }] }],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(prepareContext).toHaveBeenCalledOnce();
    expect(committed).toHaveLength(1);
  });

  it("keeps Anthropic mem-command interception on the runtime commit path", async () => {
    const config = memoryParityConfig();
    config.memCommand = { enabled: true, allowedCommands: ["help"] };
    await seedParitySession();
    const runtimeAdapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: PARITY_IDENTITY.agentSource,
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
      throw new Error("mem:help must not call an upstream or legacy writer");
    });
    vi.stubGlobal("fetch", fetcher);
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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
          messages: [{ role: "user", content: [{ type: "text", text: "mem:help" }] }],
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

  it("does not complete an Anthropic stream when durable enqueue fails", async () => {
    const config = memoryParityConfig();
    await seedParitySession();
    const workingRuntime = new MemoryRuntime(new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: PARITY_IDENTITY.agentSource,
          sessionId: PARITY_IDENTITY.sessionId,
        },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        sessionInfo: PARITY_SESSION_INFO,
        resolution: "cached",
      },
    }));
    const runtime: MemoryRuntimeContract = {
      prepareContext: (input) => workingRuntime.prepareContext(input),
      commitCompletedRound: async () => { throw new Error("outbox disk unavailable"); },
    };
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 1, output_tokens: 0 } },
      })}`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: FINAL_ASSISTANT },
      })}`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === config.upstream.url) {
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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
          stream: true,
          messages: PROXY_ROUND_INPUTS[0].messages.slice(1),
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow("outbox disk unavailable");
  });

  it.each([
    {
      name: "interrupted",
      tail: `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      })}`,
      error: "before message_stop",
    },
    {
      name: "malformed",
      tail: [
        "event: content_block_delta\ndata: {not-json}",
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        })}`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      ].join("\n\n"),
      error: "Malformed Anthropic SSE event",
    },
  ])("does not commit a $name Anthropic stream", async ({ tail, error }) => {
    const config = memoryParityConfig();
    await seedParitySession();
    const workingRuntime = new MemoryRuntime(new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: PARITY_IDENTITY.agentSource,
          sessionId: PARITY_IDENTITY.sessionId,
        },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        sessionInfo: PARITY_SESSION_INFO,
        resolution: "cached",
      },
    }));
    const commitCompletedRound = vi.fn<MemoryRuntimeContract["commitCompletedRound"]>();
    const runtime: MemoryRuntimeContract = {
      prepareContext: (input) => workingRuntime.prepareContext(input),
      commitCompletedRound,
    };
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        content_block: { type: "text", text: "" },
      })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: FINAL_ASSISTANT },
      })}`,
      tail,
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === config.upstream.url) {
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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
          stream: true,
          messages: PROXY_ROUND_INPUTS[0].messages.slice(1),
        }),
      },
    );

    await expect(response.text()).rejects.toThrow(error);
    expect(commitCompletedRound).not.toHaveBeenCalled();
  });

  it("commits a completed Anthropic stream after the client disconnects", async () => {
    const config = memoryParityConfig();
    await seedParitySession();
    const workingRuntime = new MemoryRuntime(new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: PARITY_IDENTITY.agentSource,
          sessionId: PARITY_IDENTITY.sessionId,
        },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        sessionInfo: PARITY_SESSION_INFO,
        resolution: "cached",
      },
    }));
    const committed: CommitCompletedRoundInput[] = [];
    const runtime: MemoryRuntimeContract = {
      prepareContext: (input) => workingRuntime.prepareContext(input),
      async commitCompletedRound(input) {
        committed.push(input);
        return { status: "skipped", sourceEventId: input.sourceEventId, reason: "fixture" };
      },
    };
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        content_block: { type: "text", text: "foo" },
      })}`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        content_block: { type: "text", text: "bar" },
      })}`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === config.upstream.url) {
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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
          stream: true,
          messages: PROXY_ROUND_INPUTS[0].messages.slice(1),
        }),
      },
    );

    await response.body?.cancel();
    await vi.waitFor(() => expect(committed).toHaveLength(1));
    expect(committed[0].finalResponse).toBe("foo\nbar");
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
      memoryRuntimeProvider: { forRequest: () => runtime },
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
      memoryRuntimeProvider: { forRequest: () => runtime },
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
      prepareContext: async () => {
        throw new MemoryRuntimeContextError(new Error("context backend unavailable"));
      },
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
      memoryRuntimeProvider: { forRequest: () => runtime },
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

  it("fails closed when OpenAI runtime read authorization is denied", async () => {
    const config = memoryParityConfig();
    await seedParitySession("codebuddy");
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => {
        throw new MemoryRuntimeAuthorizationError("read", "fixture-denied");
      },
      commitCompletedRound: vi.fn(),
    };
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Memory access denied",
        type: "permission_error",
        code: "memory_access_denied",
      },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(runtime.commitCompletedRound).not.toHaveBeenCalled();
  });

  it("returns OpenAI service unavailable when runtime preparation fails unexpectedly", async () => {
    const config = memoryParityConfig();
    await seedParitySession("codebuddy");
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => {
        throw new Error("capability backend unavailable");
      },
      commitCompletedRound: vi.fn(),
    };
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Memory service unavailable",
        type: "service_unavailable_error",
        code: "memory_service_unavailable",
      },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(runtime.commitCompletedRound).not.toHaveBeenCalled();
  });

  it("commits through MemoryRuntime when session init is disabled", async () => {
    const config = memoryParityConfig();
    config.sessionInit.enabled = false;
    await seedParitySession("codebuddy");
    const committed: CommitCompletedRoundInput[] = [];
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => ({
        session: {
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
        },
        blocks: [],
        capabilities: {
          memory: { enabled: true },
          skill: { enabled: true },
          knowledge: { wiki: { enabled: false }, codeGraph: { enabled: false } },
        },
        diagnostics: {
          binding: "cached",
          prewarmed: [],
          cacheHits: [],
          degraded: [],
        },
      }),
      commitCompletedRound: async (input) => {
        committed.push(input);
        return { status: "skipped", sourceEventId: input.sourceEventId, reason: "fixture" };
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === config.upstream.url) {
        return new Response(JSON.stringify({
          id: "chatcmpl-session-init-disabled",
          choices: [{ message: { role: "assistant", content: FINAL_ASSISTANT } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const app = createApp(config, { memoryRuntimeProvider: { forRequest: () => runtime } });

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

    expect(response.status).toBe(200);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      identity: { serviceId: PARITY_IDENTITY.spaceId },
      realPrompt: USER_PROMPT,
      finalResponse: FINAL_ASSISTANT,
    });
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
      memoryRuntimeProvider: { forRequest: () => failingRuntime },
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
    "$protocol adapter produces the canonical completed round once",
    (fixture) => {
      const builder = fixture.protocol === "anthropic"
        ? buildAnthropicCompletedRound
        : buildOpenAICompletedRound;
      const completed = builder({
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          userId: PARITY_IDENTITY.userId,
          agentSource: fixture.agentSource,
          sessionId: PARITY_IDENTITY.sessionId,
        },
        turnSequence: 1,
        inputMessages: fixture.messages,
        assistantMessage: fixture.assistantMessage,
      });

      expect(completed).toMatchObject({
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          userId: PARITY_IDENTITY.userId,
          agentSource: fixture.agentSource,
          sessionId: PARITY_IDENTITY.sessionId,
          turnId: "turn-1",
        },
        realPrompt: USER_PROMPT,
        finalResponse: FINAL_ASSISTANT,
      });
    },
  );
});

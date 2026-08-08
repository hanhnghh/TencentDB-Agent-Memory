import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { createApp } from "../../server.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import type { AgentDetail, SessionInfo, TaskDetail } from "../../session/types.js";
import type { ProxyConfig } from "../../types.js";
import { flushPendingWrites } from "../pending-writes.js";

const identity = {
  spaceId: "memory-1",
  sessionId: "session-1",
  teamId: "team-1",
  userId: "user-1",
  agentId: "agent-1",
  taskId: "task-1",
} as const;

const sessionInfo: SessionInfo = {
  session_id: identity.sessionId,
  space_id: identity.spaceId,
  user_id: identity.userId,
  team_id: identity.teamId,
  agent_id: identity.agentId,
  task_id: identity.taskId,
  identity_verified: true,
  permissions: {
    user_in_team: true,
    user_in_task: true,
    agent_assigned_to_task: true,
    repo_in_team: true,
  },
};

const agent: AgentDetail = {
  id: identity.agentId,
  name: "Receipt Agent",
  description: "Exercises the proxy write boundary.",
  prompt: "Use duplicate-safe L0 writes.",
};

const task: TaskDetail = {
  id: identity.taskId,
  name: "Receipt Task",
  description: "Exercise source-event propagation.",
  goal: "Keep retries duplicate-safe.",
};

function config(): ProxyConfig {
  const value = structuredClone(DEFAULT_CONFIG);
  value.upstream = {
    url: "http://upstream.test/v1/messages",
    apiKey: "",
    agents: {},
  };
  value.rateLimit = { tpm: 0, qpm: 0 };
  value.creditReport.url = "http://credit.test/report";
  value.sessionInit.enabled = true;
  value.tdai = {
    enabled: true,
    endpoint: "http://memory.test",
    apiKey: "service-token",
    serviceId: identity.spaceId,
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
  return value;
}

async function seedSession(agentSource: "claude-code" | "codebuddy"): Promise<void> {
  await getSessionStore().set(`${agentSource}:${identity.sessionId}`, {
    status: "initialized",
    keyId: `${agentSource}:${identity.sessionId}`,
    startedAt: 1,
    attemptCount: 0,
    userId: identity.userId,
    sessionInfo,
    agentDetail: agent,
    taskDetail: task,
  });
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  __resetSessionStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("proxy routes propagate duplicate-safe L0 source identity", () => {
  it.each([
    {
      protocol: "Anthropic",
      agentSource: "claude-code" as const,
      path: `/claude-code/${identity.spaceId}/v1/messages`,
      headers: { "content-type": "application/json", "x-api-key": "client-key" },
      request: {
        model: "fixture-model",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      upstream: {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "fixture-model",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      protocol: "OpenAI",
      agentSource: "codebuddy" as const,
      path: `/codebuddy/${identity.spaceId}/v1/chat/completions`,
      headers: { "content-type": "application/json", authorization: "Bearer client-key" },
      request: {
        model: "fixture-model",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      upstream: {
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "done" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    },
  ])("$protocol route sends stable source identity to MemoryCore", async (fixture) => {
    const proxyConfig = config();
    await seedSession(fixture.agentSource);
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === proxyConfig.upstream.url) {
        return new Response(JSON.stringify(fixture.upstream), { status: 200 });
      }
      if (url === proxyConfig.creditReport.url) {
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }
      if (url.endsWith("/v3/meta/config/user/get")) {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      }
      if (url.endsWith("/v3/skill/conversation/add")) {
        return new Response(JSON.stringify({ code: 0, data: { status: "ok" } }), { status: 200 });
      }
      if (url.endsWith("/v3/conversation/add")) {
        const body = parseBody(init);
        writes.push(body);
        const messages = body.messages as unknown[];
        const acceptedIds = messages.map((_, index) => `msg-${index}`);
        return new Response(JSON.stringify({
          code: 0,
          data: {
            accepted_ids: acceptedIds,
            accepted_versions: acceptedIds.map(() => "v1"),
            total_count: acceptedIds.length,
            receipt: {
              source_event_id: body.source_event_id,
              content_hash: body.content_hash,
              status: "committed",
              committed_at: "2026-08-08T00:00:00.000Z",
            },
          },
        }), { status: 200 });
      }
      throw new Error(`unexpected fixture URL: ${url}`);
    }));

    const headers = new Headers();
    for (const [name, value] of Object.entries(fixture.headers)) {
      if (value !== undefined) headers.set(name, value);
    }
    headers.set("x-conversation-id", identity.sessionId);
    headers.set("x-user-id", identity.userId);
    const response = await createApp(proxyConfig).request(fixture.path, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.request),
    });

    expect(response.status).toBe(200);
    await expect(flushPendingWrites(1_000)).resolves.toEqual({ drained: true, remaining: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      team_id: identity.teamId,
      user_id: identity.userId,
      agent_id: identity.agentId,
      task_id: identity.taskId,
      session_id: identity.sessionId,
      source_event_id: expect.stringMatching(
        new RegExp(`^proxy:${identity.sessionId}:turn:\\d+:payload:[a-f0-9]{24}:batch:0-of-1$`),
      ),
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});

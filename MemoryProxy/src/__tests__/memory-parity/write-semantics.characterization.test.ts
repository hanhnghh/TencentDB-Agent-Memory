import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProxyConfig } from "../../types.js";
import { CoreSkillClient, setCoreSkillClient } from "../../skill/core-client.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import { extractLatestUserMessage, recordTdaiTurn } from "../../tdai/recorder.js";
import type { TdaiClient } from "../../tdai/client.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import {
  COMPLETED_ROUND_GOLDEN,
  FINAL_ASSISTANT,
  INTERMEDIATE_ASSISTANT,
  PARITY_IDENTITY,
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

afterEach(() => {
  setCoreSkillClient(null);
});

describe("memory parity: observed legacy intermediate L0 behavior", () => {
  it("records each proxy HTTP response independently, including an intermediate tool-loop response", async () => {
    const writes: Array<{ identity: TdaiIdentity; messages: TdaiMessage[] }> = [];
    const client = {
      addConversation: vi.fn(async (identity: TdaiIdentity, messages: TdaiMessage[]) => {
        writes.push({ identity, messages });
      }),
    } as unknown as TdaiClient;

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
      {
        identity: tdaiIdentity,
        messages: [
          { role: "user", content: USER_PROMPT },
          { role: "assistant", content: INTERMEDIATE_ASSISTANT },
        ],
      },
      {
        identity: tdaiIdentity,
        messages: [
          { role: "user", content: "xin chào\nexit: 0" },
          { role: "assistant", content: FINAL_ASSISTANT },
        ],
      },
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
  it("defines L0 as the real user prompt plus final assistant answer", () => {
    const targetL0: TdaiMessage[] = [
      { role: "user", content: USER_PROMPT },
      { role: "assistant", content: FINAL_ASSISTANT },
    ];

    expect(targetL0).toEqual([
      COMPLETED_ROUND_GOLDEN[0],
      COMPLETED_ROUND_GOLDEN[COMPLETED_ROUND_GOLDEN.length - 1],
    ]);
  });

  it("commits the full normalized tool-aware round to skill ingestion only after the final response", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new CoreSkillClient(
      {
        endpoint: "http://core.fixture",
        serviceToken: "fixture-token",
        serviceId: "fixture-service",
        timeoutMs: 1_000,
      },
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ code: 0, data: { status: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    );
    setCoreSkillClient(client);
    const fixture = PROXY_ROUND_INPUTS[0];
    const config = {
      coreSkill: {
        endpoint: "http://core.fixture",
        serviceToken: "fixture-token",
        serviceId: "fixture-service",
        timeoutMs: 1_000,
      },
    } as ProxyConfig;
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

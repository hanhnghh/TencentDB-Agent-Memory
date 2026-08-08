import { afterEach, describe, expect, it, vi } from "vitest";

import { TdaiL1RecallInjector } from "../../injection/injectors/tdai-l1-recall-injector.js";
import type { AgentContext } from "../../injection/types.js";
import { setMetadataClient } from "../../meta/client.js";
import { TdaiClient } from "../../tdai/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setMetadataClient(null);
});

describe("Codex prompt recall ACL parity", () => {
  it.each(["denied", "unavailable"] as const)(
    "never searches an imported memory asset when its ACL is %s",
    async (outcome) => {
      const searchedAgents: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const body = readJsonBody(init);
        if (path.endsWith("/agent-fixed-asset/list-with-detail")) {
          return jsonResponse({
            code: 0,
            data: {
              agent: {
                agent_id: "agt-self",
                team_id: "team-a",
                owner_user_id: "user-a",
                name: "Self",
              },
              items: [{
                asset_id: "chat_memory-team-a-agt-imported",
                asset_type: "chat_memory",
                name: "Imported",
              }],
              total: 1,
              limit: 100,
              offset: 0,
            },
          });
        }
        if (path.endsWith("/agent/get")) {
          return jsonResponse({
            code: 0,
            data: {
              agent_id: "agt-imported",
              team_id: "team-a",
              owner_user_id: "user-b",
              name: "Imported",
            },
          });
        }
        if (path.endsWith("/acl/check")) {
          if (body.agent_id === "agt-imported" && outcome === "unavailable") {
            return jsonResponse({ error: "acl unavailable" }, 503);
          }
          return jsonResponse({
            code: 0,
            data: {
              allowed: body.agent_id === "agt-self",
              reason: body.agent_id === "agt-self" ? "owner" : "revoked",
            },
          });
        }
        if (path.endsWith("/atomic/search")) {
          if (typeof body.agent_id === "string") searchedAgents.push(body.agent_id);
          return jsonResponse({
            code: 0,
            data: {
              items: [{
                id: `memory-${String(body.agent_id)}`,
                type: "memory",
                content: `memory from ${String(body.agent_id)}`,
                score: 1,
              }],
            },
          });
        }
        return jsonResponse({ error: `unexpected ${path}` }, 404);
      }));
      const client = new TdaiClient({
        enabled: true,
        endpoint: "http://memory.fixture",
        apiKey: "service-token",
        serviceId: "memory-a",
        writeL0: true,
        recallL1: true,
        injectL2L3: true,
        l1Limit: 5,
        l2Limit: 3,
        timeoutMs: 100,
      });
      const injector = new TdaiL1RecallInjector(client, {
        endpoint: "http://memory.fixture",
        serviceToken: "service-token",
        serviceId: "memory-a",
        timeoutMs: 100,
      }, 5, 5, client);

      const blocks = await injector.execute(promptContext());

      expect(searchedAgents).toEqual(["agt-self"]);
      expect(JSON.stringify(blocks)).toContain("memory from agt-self");
      expect(JSON.stringify(blocks)).not.toContain("memory from agt-imported");
    },
  );
});

function promptContext(): AgentContext {
  return {
    messages: [{ role: "user", blocks: [{ type: "text", content: "real prompt" }] }],
    requestParams: {},
    metadata: {
      protocol: "openai",
      traceId: "codex-prompt-recall",
      keyId: "codex-session",
      modelId: "codex-subscription",
      stream: false,
      agentSource: "codex",
      userId: "user-a",
      spaceId: "memory-a",
      sessionKey: "session-a",
      custom: {
        session: {
          session_id: "session-a",
          space_id: "memory-a",
          user_id: "user-a",
          team_id: "team-a",
          agent_id: "agt-self",
          task_id: "task-a",
          user_key: "user-key-secret",
        },
      },
    },
  };
}

function readJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new TypeError("request body is missing");
  const value: unknown = JSON.parse(init.body);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("request body is invalid");
  }
  return Object.fromEntries(Object.entries(value));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

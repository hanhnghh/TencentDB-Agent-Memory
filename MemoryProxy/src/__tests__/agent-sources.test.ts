import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { extractSpaceIdFromPath } from "../credit-reporter.js";
import { normalizeWhitelistRequestPath } from "../routes/whitelist.js";
import {
  canonicalizeAgentSource,
  createSessionNamespace,
  normalizeAgentSource,
} from "../agent-sources.js";
import { KvBindingRepo } from "../db/kv-binding-repo.js";
import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
  SessionStore,
} from "../session/store.js";
import { createSkillBridgeHandler } from "../skill/skill-bridge.js";
import { MemoryStorage } from "../storage/memory-storage.js";
import type { ProxyConfig } from "../types.js";

afterEach(() => {
  __resetSessionStoreForTests();
});

function bridgeConfig(): ProxyConfig {
  return {
    coreSkill: {
      endpoint: "https://memory.example",
      serviceId: "memory-1",
      serviceToken: "service-secret",
      timeoutMs: 5_000,
    },
  } as ProxyConfig;
}

async function seedCodexSession(sessionId: string): Promise<void> {
  await getSessionStore().set(`codex:${sessionId}`, {
    status: "initialized",
    keyId: `codex:${sessionId}`,
    startedAt: Date.now(),
    attemptCount: 0,
    sessionInfo: {
      session_id: sessionId,
      team_id: "team-codex",
      agent_id: "agent-codex",
      task_id: "task-codex",
      user_id: "user-codex",
      space_id: "memory-1",
    },
  });
}

describe("Codex agent source registry", () => {
  it("recognizes Codex without treating it as an unknown client", () => {
    expect(normalizeAgentSource("codex")).toBe("codex");
    expect(canonicalizeAgentSource("CoDeX")).toBe("codex");
    expect(resolveAgentAdapter("codex").agentKind).toBe("codex");
    expect(extractSpaceIdFromPath("/codex/memory-1/v1/messages")).toBe("memory-1");
    expect(normalizeWhitelistRequestPath("/codex/memory-1/v1/messages")).toBe("/v1/messages");
  });

  it("preserves legacy agent path recognition", () => {
    expect(extractSpaceIdFromPath("/claude-code/memory-1/v1/messages")).toBe("memory-1");
    expect(extractSpaceIdFromPath("/codebuddy/memory-1/v1/chat/completions")).toBe("memory-1");
    expect(resolveAgentAdapter("claude-code").agentKind).toBe("claude-code");
    expect(resolveAgentAdapter("codebuddy").agentKind).toBe("codebuddy");
    expect(resolveAgentAdapter("unregistered").agentKind).toBe("unknown");
  });

  it("isolates identical session identities for every client namespace", () => {
    const sessionId = "session-123";

    expect(new Set([
      createSessionNamespace("codex", sessionId),
      createSessionNamespace("claude-code", sessionId),
      createSessionNamespace("codebuddy", sessionId),
      createSessionNamespace("unknown", sessionId),
    ]).size).toBe(4);
    expect(createSessionNamespace("codex", sessionId)).toBe("codex:session-123");
  });

  it("preserves a legacy non-registry source namespace", () => {
    expect(createSessionNamespace("cursor", "session-123")).toBe("cursor:session-123");
    expect(createSessionNamespace("Cursor", "session-123")).toBe("Cursor:session-123");
  });

  it("rejects an empty session identity", () => {
    expect(() => createSessionNamespace("codex", "  ")).toThrow(
      "Codex session identity is required",
    );
  });

  it.each(["codex", "claude-code", "codebuddy", "unknown"])(
    "stores and reads a %s binding only in its matching namespace",
    async (source) => {
      const repo = new KvBindingRepo(new MemoryStorage());
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await repo.putBinding(
        "memory-1",
        "user-1",
        source,
        "shared-session-id",
        {
          outcome: "initialized",
          teamId: "team-1",
          agentId: "agent-1",
          taskId: `task-${source}`,
        },
      );

      await expect(repo.getBinding(
        "memory-1",
        "user-1",
        source,
        "shared-session-id",
      )).resolves.toMatchObject({ taskId: `task-${source}` });
      errorSpy.mockRestore();
    },
  );

  it.each(["claude-code", "codebuddy", "unknown"])(
    "does not recover %s state into the Codex lifecycle",
    async (foreignSource) => {
      const repo = new KvBindingRepo(new MemoryStorage());
      await repo.putBinding(
        "memory-1",
        "user-1",
        foreignSource,
        "shared-session-id",
        { outcome: "bypassed" },
      );
      const store = new SessionStore(undefined, undefined, repo);

      await expect(store.getOrRecover(
        createSessionNamespace("codex", "shared-session-id"),
        {
          spaceId: "memory-1",
          userId: "user-1",
          agentSource: "codex",
          sessionId: "shared-session-id",
        },
        {},
      )).resolves.toBeUndefined();
    },
  );

  it("recovers Codex state through the Codex lifecycle namespace", async () => {
    const repo = new KvBindingRepo(new MemoryStorage());
    await repo.putBinding(
      "memory-1",
      "user-1",
      "codex",
      "shared-session-id",
      { outcome: "bypassed" },
    );
    const store = new SessionStore(undefined, undefined, repo);

    await expect(store.getOrRecover(
      createSessionNamespace("codex", "shared-session-id"),
      {
        spaceId: "memory-1",
        userId: "user-1",
        agentSource: "codex",
        sessionId: "shared-session-id",
      },
      {},
    )).resolves.toMatchObject({ status: "initialized", bypassed: true });
  });

  it("resolves a Codex session through the published memory bridge", async () => {
    await seedCodexSession("shared-session-id");
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        user_id: "user-codex",
        team_id: "team-codex",
        agent_id: "agent-codex",
        task_id: "task-codex",
      });
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const app = new Hono();
    app.post("/memory-bridge/v3/atomic/search", createMemoryBridgeHandler(
      bridgeConfig(),
      { fetcher: upstream },
    ));

    const response = await app.request("/memory-bridge/v3/atomic/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": "shared-session-id",
      },
      body: JSON.stringify({ query: "binding" }),
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("resolves a Codex session through the published skill bridge", async () => {
    await seedCodexSession("shared-session-id");
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        user_id: "user-codex",
        team_id: "team-codex",
        agent_id: "agent-codex",
      });
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const app = new Hono();
    app.post("/skill-bridge/v3/skill/list", createSkillBridgeHandler(
      bridgeConfig(),
      { fetcher: upstream },
    ));

    const response = await app.request("/skill-bridge/v3/skill/list", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": "shared-session-id",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

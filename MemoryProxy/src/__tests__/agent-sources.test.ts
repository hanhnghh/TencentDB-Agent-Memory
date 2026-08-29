import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { extractSpaceIdFromPath } from "../credit-reporter.js";
import { normalizeWhitelistRequestPath } from "../routes/whitelist.js";
import {
  canonicalizeAgentSource,
  createSessionNamespace,
  createSessionNamespaceCandidates,
  normalizeAgentSource,
} from "../agent-sources.js";
import { KvBindingRepo } from "../db/kv-binding-repo.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import {
  renderTdaiMemoryToolsBlock,
  TdaiMemoryToolsInjector,
} from "../injection/injectors/tdai-tools-injector.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
  SessionStore,
} from "../session/store.js";
import { createSkillBridgeHandler } from "../skill/skill-bridge.js";
import {
  renderSkillToolsBlock,
  SkillToolsInjector,
} from "../injection/injectors/skill-tools-injector.js";
import {
  KnowledgeToolsInjector,
} from "../injection/injectors/knowledge-tools-injector.js";
import { CoreKnowledgeClient } from "../knowledge/core-client.js";
import { MemoryStorage } from "../storage/memory-storage.js";
import type { ProxyConfig } from "../types.js";

afterEach(() => {
  __resetSessionStoreForTests();
});

function bridgeConfig(): ProxyConfig {
  return {
    ...DEFAULT_CONFIG,
    coreSkill: {
      endpoint: "https://memory.example",
      serviceId: "memory-1",
      serviceToken: "service-secret",
      timeoutMs: 5_000,
    },
  };
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

  it("uses an explicit registered source as an exact bridge namespace", () => {
    expect(createSessionNamespaceCandidates("session-123", "codex")).toEqual([
      "codex:session-123",
    ]);
    expect(createSessionNamespaceCandidates("session-123", "not-registered")).toEqual([]);
  });

  it("includes the validated source in generated bridge calls", () => {
    expect(renderTdaiMemoryToolsBlock(
      "https://proxy.example",
      "session-123",
      "memory-1",
      "codex",
    )).toContain("x-agent-source: codex");
    expect(renderSkillToolsBlock(
      "https://proxy.example",
      false,
      "session-123",
      "memory-1",
      "codex",
    )).toContain("x-agent-source: codex");
  });

  it("prepares Codex tool instructions against the loopback sidecar", async () => {
    const input = {
      keyId: "codex:session-123",
      userId: "user-codex",
      agentSource: "codex",
      spaceId: "memory-1",
      sessionInfo: {
        session_id: "session-123",
        space_id: "memory-1",
        user_id: "user-codex",
        team_id: "team-codex",
        agent_id: "agent-codex",
        task_id: "task-codex",
      },
      agentDetail: { id: "agent-codex", name: "Codex Agent" },
      taskDetail: { id: "task-codex", name: "Codex Task" },
      callerUserKey: "user-key-secret",
      assetCapabilities: {
        chat_memory: true,
        skill: true,
        llm_wiki: true,
        code_graph: true,
      },
    };
    const sidecar = "http://127.0.0.1:8097";
    const skill = await new SkillToolsInjector({
      proxyBaseUrl: "https://gateway.example",
      codexSidecarBaseUrl: sidecar,
    }).prewarm(input);
    const memory = new TdaiMemoryToolsInjector({
      proxyBaseUrl: "https://gateway.example",
      codexSidecarBaseUrl: sidecar,
    }).prewarm(input);
    const knowledgeClient = new CoreKnowledgeClient(bridgeConfig().coreSkill, async (request) => {
      const path = new URL(String(request)).pathname;
      if (path.endsWith("/v3/meta/agent-fixed-asset/list-with-detail")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { items: [{ asset_id: "wiki-1", asset_type: "llm_wiki", status: "active" }] },
        }));
      }
      return new Response(JSON.stringify({
        code: 0,
        data: {
          items: [{
            knowledge_id: "wiki-1",
            type: "wiki",
            service_url: "https://wiki.example/v3",
            name: "Wiki",
            summary: null,
            team_id: "team-codex",
            user_id: "user-codex",
            created_at: "2026-08-08T00:00:00Z",
            updated_at: "2026-08-08T00:00:00Z",
          }],
          total: 1,
        },
      }));
    });
    const knowledge = await new KnowledgeToolsInjector({
      coreSkill: bridgeConfig().coreSkill,
      codexSidecarBaseUrl: sidecar,
    }, knowledgeClient).prewarm(input);

    for (const blocks of [skill, memory, knowledge]) {
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.content).toContain(sidecar);
      expect(blocks[0]?.content).toContain("x-agent-source: codex");
      expect(blocks[0]?.content).not.toContain("https://gateway.example");
      expect(blocks[0]?.content).not.toContain("https://wiki.example");
    }
    const rendered = [...skill, ...memory, ...knowledge].map((block) => block.content);
    expect(rendered.join("\n")).toContain("<skill_tools>");
    expect(rendered.join("\n")).toContain("<tdai_memory_tools>");
    expect(rendered.join("\n")).toContain("<knowledge_tools>");
    expect(rendered.reduce((total, content) => total + content.length, 0)).toBeLessThan(5_000);
  });

  it("does not advertise Codex bridge tools without a loopback endpoint", async () => {
    const input = {
      keyId: "codex:session-123",
      userId: "user-codex",
      agentSource: "codex",
      spaceId: "memory-1",
      sessionInfo: {
        session_id: "session-123",
        space_id: "memory-1",
        user_id: "user-codex",
        team_id: "team-codex",
        agent_id: "agent-codex",
        task_id: "task-codex",
      },
      agentDetail: { id: "agent-codex", name: "Codex Agent" },
      taskDetail: { id: "task-codex", name: "Codex Task" },
      callerUserKey: "user-key-secret",
      assetCapabilities: {
        chat_memory: true,
        skill: true,
        llm_wiki: true,
        code_graph: true,
      },
    };
    const knowledgeFetcher = vi.fn<typeof fetch>();

    await expect(new SkillToolsInjector({
      proxyBaseUrl: "https://gateway.example",
    }).prewarm(input)).resolves.toEqual([]);
    expect(new TdaiMemoryToolsInjector({
      proxyBaseUrl: "https://gateway.example",
    }).prewarm(input)).toEqual([]);
    await expect(new KnowledgeToolsInjector({
      coreSkill: bridgeConfig().coreSkill,
    }, new CoreKnowledgeClient(bridgeConfig().coreSkill, knowledgeFetcher)).prewarm(input))
      .resolves.toEqual([]);
    expect(knowledgeFetcher).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude-code", "codebuddy", "unknown"])(
    "stores and reads a %s source label in the flattened binding",
    async (source) => {
      const repo = new KvBindingRepo(new MemoryStorage());
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await repo.putBinding(
        "memory-1",
        "shared-session-id",
        {
          outcome: "initialized",
          userId: "user-1",
          agentSource: source,
          teamId: "team-1",
          agentId: "agent-1",
          taskId: `task-${source}`,
        },
      );

      await expect(repo.getBinding(
        "memory-1",
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
        "shared-session-id",
        { outcome: "bypassed", userId: "user-1", agentSource: foreignSource },
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
      "shared-session-id",
      { outcome: "bypassed", userId: "user-1", agentSource: "codex" },
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
    const upstream: typeof fetch = vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        user_id: "user-codex",
        team_id: "team-codex",
        agent_id: "agent-codex",
        task_id: "task-codex",
        session_id: "shared-session-id",
      });
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        headers: { "content-type": "application/json" },
      });
    });
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
        "x-agent-source": "codex",
        "x-tdai-service-id": "memory-1",
      },
      body: JSON.stringify({
        query: "binding",
        user_id: "caller-user",
        team_id: "caller-team",
        agent_id: "caller-agent",
        task_id: "caller-task",
        session_id: "caller-session",
      }),
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("resolves a Codex session through the published skill bridge", async () => {
    await seedCodexSession("shared-session-id");
    const upstream: typeof fetch = vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        user_id: "user-codex",
        team_id: "team-codex",
        agent_id: "agent-codex",
      });
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        headers: { "content-type": "application/json" },
      });
    });
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
        "x-agent-source": "codex",
        "x-tdai-service-id": "memory-1",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    { header: "codebuddy", status: 401 },
    { header: "not-registered", status: 401 },
  ])("fails closed for an explicit $header bridge namespace", async ({ header, status }) => {
    await seedCodexSession("shared-session-id");
    const upstream = vi.fn();
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
        "x-agent-source": header,
      },
      body: JSON.stringify({ query: "binding" }),
    });

    expect(response.status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a bridge service that differs from the validated session", async () => {
    await seedCodexSession("shared-session-id");
    const upstream = vi.fn();
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
        "x-agent-source": "codex",
        "x-tdai-service-id": "memory-other",
      },
      body: JSON.stringify({ query: "binding" }),
    });

    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not expose dependency errors or credentials through bridge responses", async () => {
    await seedCodexSession("shared-session-id");
    const upstream: typeof fetch = vi.fn(async () => {
      throw new Error("dependency exposed service-secret and user content");
    });
    const app = new Hono();
    app.post("/memory-bridge/v3/atomic/query", createMemoryBridgeHandler(
      bridgeConfig(),
      { fetcher: upstream },
    ));
    app.post("/skill-bridge/v3/skill/list", createSkillBridgeHandler(
      bridgeConfig(),
      { fetcher: upstream },
    ));
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": "shared-session-id",
        "x-agent-source": "codex",
        "x-tdai-service-id": "memory-1",
      },
      body: "{}",
    };

    for (const path of [
      "/memory-bridge/v3/atomic/query",
      "/skill-bridge/v3/skill/list",
    ]) {
      const response = await app.request(path, request);
      const text = await response.text();
      expect(response.status).toBe(502);
      expect(text).toContain("upstream unavailable");
      expect(text).not.toContain("service-secret");
      expect(text).not.toContain("user content");
    }
  });
});

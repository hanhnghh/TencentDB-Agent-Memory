import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import type { HookCacheEntry, HookCacheRepo } from "../../db/hookCacheRepo.js";
import { SessionStore } from "../../session/store.js";
import type { ProxyConfig } from "../../types.js";
import {
  AssetCapabilityHttpAdapter,
  ConfigExtractionAdapter,
  createRuntimeSessionKey,
  DurableRoundOutboxAdapter,
  HookCacheContextAdapter,
  MemoryCoreAuthorizationAdapter,
  MemoryRuntimeBindingError,
  MemoryRuntime,
  ProductionMemoryRuntimeAdapters,
  SessionStoreBindingAdapter,
  type MemoryRuntimeContract,
} from "../index.js";
import {
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_SESSION_INFO,
  PARITY_TASK,
} from "../../__tests__/memory-parity/fixtures.js";

describe("MemoryRuntime production adapters", () => {
  it("adds prompt-specific recall through the context port and degrades read failures", async () => {
    const promptRecall = vi.fn(async () => [{
      id: "tdai-l1-recall-injector:0",
      sourceHookId: "tdai-l1-recall-injector",
      kind: "memory" as const,
      order: 1_500_000,
      type: "text" as const,
      content: "prompt-specific memory",
    }]);
    const adapter = new HookCacheContextAdapter({
      cacheRepo: {
        put: vi.fn(),
        putMany: vi.fn(),
        get: vi.fn(async () => null),
        getAllForSession: vi.fn(async () => []),
        clearBySession: vi.fn(),
      },
      prewarm: vi.fn(async () => ({
        cachedHookIds: [], entries: [], skipped: [], durationMs: 0,
      })),
      promptRecall,
    });
    const request = {
      binding: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          teamId: PARITY_IDENTITY.teamId,
          userId: PARITY_IDENTITY.userId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: "codex",
          sessionId: PARITY_IDENTITY.sessionId,
        },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        sessionInfo: PARITY_SESSION_INFO,
        resolution: "cached" as const,
      },
      capabilities: { skill: true, llmWiki: true, codeGraph: true, chatMemory: true },
      query: "the real prompt",
    };

    await expect(adapter.prepareContext(request)).resolves.toMatchObject({
      blocks: [{ sourceHookId: "tdai-l1-recall-injector", content: "prompt-specific memory" }],
    });
    expect(promptRecall).toHaveBeenCalledWith(request);

    promptRecall.mockRejectedValueOnce(new Error("recall offline"));
    await expect(adapter.prepareContext(request)).resolves.toMatchObject({
      blocks: [],
      diagnostics: { degraded: ["prompt_recall:failed"] },
    });
  });

  it("returns fresh fork context without self-healing the shared cache", async () => {
    const putMany = vi.fn();
    const prewarm = vi.fn(async () => ({
      cachedHookIds: ["tdai-profile-memory-injector"],
      entries: [{
        hookId: "tdai-profile-memory-injector",
        blocks: [{ type: "text" as const, content: "fresh read-only context" }],
      }],
      skipped: [],
      durationMs: 1,
    }));
    const adapter = new HookCacheContextAdapter({
      cacheRepo: {
        put: vi.fn(),
        putMany,
        get: vi.fn(async () => null),
        getAllForSession: vi.fn(async () => []),
        clearBySession: vi.fn(),
      },
      prewarm,
    });

    const result = await adapter.prepareContext({
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
      capabilities: { skill: true, llmWiki: true, codeGraph: true, chatMemory: true },
      readOnly: true,
    });

    expect(result.blocks).toEqual([
      expect.objectContaining({ kind: "memory", content: "fresh read-only context" }),
    ]);
    expect(prewarm).toHaveBeenCalledOnce();
    expect(putMany).not.toHaveBeenCalled();
  });

  it("prepareContext uses the same public contract with session, HTTP, and hook-cache adapters", async () => {
    const runtimeIdentity = {
      serviceId: PARITY_IDENTITY.spaceId,
      userId: PARITY_IDENTITY.userId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    };
    const keyId = createRuntimeSessionKey(runtimeIdentity);
    const store = new SessionStore();
    store.bind(keyId, {
      spaceId: PARITY_IDENTITY.spaceId,
      userId: PARITY_IDENTITY.userId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    });
    await store.set(keyId, {
      status: "initialized",
      keyId,
      startedAt: 1,
      attemptCount: 0,
      userId: PARITY_IDENTITY.userId,
      sessionInfo: PARITY_SESSION_INFO,
      agentDetail: PARITY_AGENT,
      taskDetail: PARITY_TASK,
    });

    let capabilityCall = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => {
      capabilityCall += 1;
      return new Response(JSON.stringify({
      code: 0,
      data: {
        items: [
          { param_name: "skill.enabled", effective_value: capabilityCall === 1 ? "true" : "false" },
          { param_name: "llm_wiki.enabled", effective_value: "false" },
          { param_name: "code_graph.enabled", effective_value: "true" },
          { param_name: "chat_memory.enabled", effective_value: "true" },
        ],
      },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const cachedEntries: HookCacheEntry[] = [
      {
        hookId: "knowledge-tools-injector",
        blocks: [{ type: "text", content: "knowledge" }],
      },
      {
        hookId: "skill-injector",
        blocks: [{ type: "text", content: "skill" }],
      },
      {
        hookId: "tdai-profile-memory-injector",
        blocks: [{ type: "text", content: "memory" }],
      },
    ];
    const cache = new Map<string, HookCacheEntry[]>();
    const cacheRepo: HookCacheRepo = {
      put: vi.fn(),
      putMany: vi.fn((_spaceId, _userId, _agentSource, sessionId, entries) => {
        cache.set(sessionId, structuredClone(entries));
      }),
      get: vi.fn(async () => null),
      getAllForSession: vi.fn(async (_spaceId, _userId, _agentSource, sessionId) => (
        structuredClone(cache.get(sessionId) ?? [])
      )),
      clearBySession: vi.fn(),
    };
    const prewarm = vi.fn(async () => ({
      cachedHookIds: [
        "tdai-profile-memory-injector",
        "skill-injector",
        "knowledge-tools-injector",
      ],
      entries: cachedEntries,
      skipped: [],
      durationMs: 4,
    }));
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    const adapters = new ProductionMemoryRuntimeAdapters({
      binding: new SessionStoreBindingAdapter(store),
      authorization: new MemoryCoreAuthorizationAdapter(
        () => ({ checkAcl: async () => ({ allowed: true }) }),
        () => "private-user-key",
      ),
      capabilities: new AssetCapabilityHttpAdapter({
        endpoint: "http://metadata.fixture",
        apiKey: "private-service-token",
        serviceId: "configured-space",
        timeoutMs: 1_000,
        userKeyFor: () => "private-user-key",
        fetcher,
      }),
      context: new HookCacheContextAdapter({ cacheRepo, prewarm }),
      extraction: new ConfigExtractionAdapter(config),
      outbox: new DurableRoundOutboxAdapter({
        enqueue: vi.fn(async () => {
          throw new Error("prepare must not enqueue");
        }),
      }),
    });
    const runtime: MemoryRuntimeContract = new MemoryRuntime(adapters);

    const result = await runtime.prepareContext({ identity: runtimeIdentity });

    expect(result.blocks.map((block) => block.kind)).toEqual([
      "memory",
      "skill",
      "knowledge",
    ]);
    expect(result.capabilities.knowledge.wiki.enabled).toBe(false);
    expect(result.diagnostics).toMatchObject({
      binding: "cached",
      prewarmed: [
        "tdai-profile-memory-injector",
        "skill-injector",
        "knowledge-tools-injector",
      ],
      cacheHits: [],
    });
    const changedCapabilities = await runtime.prepareContext({ identity: runtimeIdentity });
    expect(changedCapabilities.blocks.map((block) => block.kind)).toEqual([
      "memory",
      "knowledge",
    ]);
    expect(changedCapabilities.capabilities.skill.enabled).toBe(false);
    expect(prewarm).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, init] = fetcher.mock.calls[0];
    expect(new Headers(init?.headers).get("x-tdai-user-key")).toBe("private-user-key");
    expect(JSON.stringify(result)).not.toContain("private-user-key");
    expect(JSON.stringify(result)).not.toContain("private-service-token");
  });

  it("commitCompletedRound reaches the durable outbox through the production composition", async () => {
    const boundIdentity = {
      serviceId: PARITY_IDENTITY.spaceId,
      teamId: PARITY_IDENTITY.teamId,
      userId: PARITY_IDENTITY.userId,
      agentId: PARITY_IDENTITY.agentId,
      taskId: PARITY_IDENTITY.taskId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    };
    const enqueue = vi.fn(async (round) => ({
      sourceEventId: round.sourceEventId,
      contentHash: "sha256:fixture",
      state: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    const adapters = new ProductionMemoryRuntimeAdapters({
      binding: {
        resolveBinding: async () => ({
          identity: boundIdentity,
          agent: PARITY_AGENT,
          task: PARITY_TASK,
          sessionInfo: PARITY_SESSION_INFO,
          resolution: "cached",
        }),
      },
      authorization: { authorize: async () => ({ allowed: true }) },
      capabilities: {
        resolveCapabilities: async () => ({
          skill: true,
          llmWiki: true,
          codeGraph: true,
          chatMemory: true,
        }),
      },
      context: {
        prepareContext: async () => ({
          blocks: [],
          diagnostics: { prewarmed: [], cacheHits: [], degraded: [] },
        }),
      },
      extraction: new ConfigExtractionAdapter(structuredClone(DEFAULT_CONFIG)),
      outbox: new DurableRoundOutboxAdapter({ enqueue }),
    });
    const runtime: MemoryRuntimeContract = new MemoryRuntime(adapters);

    await expect(runtime.commitCompletedRound({
      sourceEventId: "codex:round:production",
      identity: {
        serviceId: boundIdentity.serviceId,
        userId: boundIdentity.userId,
        agentSource: boundIdentity.agentSource,
        sessionId: boundIdentity.sessionId,
        turnId: "turn-production",
      },
      realPrompt: "Inspect the runtime",
      events: [],
      finalResponse: "Runtime inspected",
    })).resolves.toMatchObject({
      status: "enqueued",
      record: { state: "pending" },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "codex:round:production",
      channels: { l0: true, skill: true },
    }));
  });

  it("fails binding recovery closed when authoritative ownership flags are missing", async () => {
    const identity = {
      serviceId: PARITY_IDENTITY.spaceId,
      userId: PARITY_IDENTITY.userId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    };
    const keyId = createRuntimeSessionKey(identity);
    const store = new SessionStore();
    store.bind(keyId, {
      spaceId: identity.serviceId,
      userId: identity.userId,
      agentSource: identity.agentSource,
      sessionId: identity.sessionId,
    });
    await store.set(keyId, {
      status: "initialized",
      keyId,
      startedAt: 1,
      attemptCount: 0,
      userId: identity.userId,
      sessionInfo: { ...PARITY_SESSION_INFO, permissions: undefined },
      agentDetail: PARITY_AGENT,
      taskDetail: PARITY_TASK,
    });

    await expect(new SessionStoreBindingAdapter(store).resolveBinding(identity))
      .rejects.toBeInstanceOf(MemoryRuntimeBindingError);
  });
});

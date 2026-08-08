import { describe, expect, it, vi } from "vitest";

import type { HookCacheEntry, HookCacheRepo } from "../../db/hookCacheRepo.js";
import { OpenAIAdapter } from "../../injection/adapters/openai.js";
import { InjectionPipeline } from "../../injection/pipeline.js";
import { prewarmAll } from "../../injection/prewarm.js";
import { HookRegistryImpl } from "../../injection/registry.js";
import type { ContextBlock, InjectionHook } from "../../injection/types.js";
import {
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_SESSION_INFO,
  PARITY_TASK,
} from "./fixtures.js";

class InMemoryHookCacheRepo implements HookCacheRepo {
  private values = new Map<string, ContextBlock[]>();

  private key(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): string {
    return [spaceId, userId, agentSource, sessionId, hookId].join("/");
  }

  put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): void {
    this.values.set(this.key(spaceId, userId, agentSource, sessionId, hookId), blocks);
  }

  putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): void {
    for (const entry of entries) {
      this.put(spaceId, userId, agentSource, sessionId, entry.hookId, entry.blocks);
    }
  }

  async get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null> {
    return this.values.get(this.key(spaceId, userId, agentSource, sessionId, hookId)) ?? null;
  }

  async getAllForSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<HookCacheEntry[]> {
    const prefix = [spaceId, userId, agentSource, sessionId, ""].join("/");
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, blocks]) => ({ hookId: key.slice(prefix.length), blocks }));
  }

  clearBySession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void {
    const prefix = [spaceId, userId, agentSource, sessionId, ""].join("/");
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
  }
}

function cachedHook(id: string, priority: number, content: string): InjectionHook {
  return {
    id,
    point: "system.suffix",
    priority,
    description: id,
    cacheStrategy: "session_init",
    prewarm: () => [{ type: "text", content }],
    execute: vi.fn(() => [{ type: "text" as const, content: `unexpected-live-${id}` }]),
  };
}

describe("memory parity: prewarm, cache, and context order", () => {
  it("prewarms by full identity and reuses cached blocks in deterministic order", async () => {
    const registry = new HookRegistryImpl();
    const memoryHook = cachedHook("memory", 100, "memory-context");
    const skillHook = cachedHook("skills", 200, "skill-context");
    const wikiHook = cachedHook("wiki", 300, "wiki-context");
    // Register out of order so priority, rather than insertion order, defines output.
    registry.register(wikiHook);
    registry.register(memoryHook);
    registry.register(skillHook);
    const cache = new InMemoryHookCacheRepo();

    const prewarm = await prewarmAll(registry, cache, {
      keyId: `${PARITY_IDENTITY.agentSource}:${PARITY_IDENTITY.sessionId}`,
      spaceId: PARITY_IDENTITY.spaceId,
      userId: PARITY_IDENTITY.userId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionInfo: PARITY_SESSION_INFO,
      agentDetail: PARITY_AGENT,
      taskDetail: PARITY_TASK,
    });

    expect(prewarm.cachedHookIds).toEqual(["wiki", "memory", "skills"]);
    const pipeline = new InjectionPipeline(
      registry,
      new Map([["openai", new OpenAIAdapter()]]),
      { hookCacheRepo: cache },
    );
    const result = await pipeline.process(
      {
        model: "fixture-model",
        messages: [
          { role: "system", content: "base-system" },
          { role: "user", content: "real-user-prompt" },
        ],
      },
      {
        protocol: "openai",
        traceId: "trace-1",
        keyId: "key-1",
        modelId: "fixture-model",
        stream: false,
        spaceId: PARITY_IDENTITY.spaceId,
        userId: PARITY_IDENTITY.userId,
        agentSource: PARITY_IDENTITY.agentSource,
        custom: { session: PARITY_SESSION_INFO },
      },
    );

    expect(result.messages).toEqual([
      {
        role: "system",
        content: "base-system\nmemory-context\nskill-context\nwiki-context",
      },
      { role: "user", content: "real-user-prompt" },
    ]);
    expect(memoryHook.execute).not.toHaveBeenCalled();
    expect(skillHook.execute).not.toHaveBeenCalled();
    expect(wikiHook.execute).not.toHaveBeenCalled();
    await expect(cache.get(
      PARITY_IDENTITY.spaceId,
      "another-user",
      PARITY_IDENTITY.agentSource,
      PARITY_IDENTITY.sessionId,
      "memory",
    )).resolves.toBeNull();
  });
});

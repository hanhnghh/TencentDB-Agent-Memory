/**
 * KvHookCacheRepo —— HookCacheRepo backed by ProxyStorage.
 *
 * 见 docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.2 §3.6。
 *
 * Key 路径：
 *   ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/inj-hook/<hookId>.json
 *
 * spaceId 是 P4 (kernel-sts) 新增的隔离段。老 caller 传空字符串时用 `_default` 兜底。
 *
 * QPS 放大警告：`putMany` 从 1 次 HSET 变成 N 次并发 PUT；`getAllForSession`
 * 从 1 次 HGETALL 变成 1 次 LIST + N 次 GET。注入层通常 3–5 个 hookId/session，
 * 可接受；压测发现瓶颈可退化为整 session 打包。
 */
import type { HookCacheRepo, HookCacheEntry } from "./hookCacheRepo.js";
import type { ContextBlock } from "../injection/types.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { sessionDirOf, assertKeySegment } from "../storage/key-utils.js";

function hookDir(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sessionDirOf("ttl", sp, userId, agentSource, sessionId)}inj-hook/`;
}

function keyOf(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
  hookId: string,
): string {
  assertKeySegment("hookId", hookId);
  return `${hookDir(spaceId, userId, agentSource, sessionId)}${hookId}.json`;
}

export class KvHookCacheRepo implements HookCacheRepo {
  private readonly operationQueues = new Map<string, Promise<void>>();

  constructor(private readonly storage: ProxyStorage) {}

  private enqueue<T>(dir: string, execute: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(dir) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(execute);
    const tail = operation.then(() => undefined, () => undefined);
    this.operationQueues.set(dir, tail);
    void tail.then(() => {
      if (this.operationQueues.get(dir) === tail) this.operationQueues.delete(dir);
    });
    return operation;
  }

  async put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): Promise<void> {
    const dir = hookDir(spaceId, userId, agentSource, sessionId);
    await this.enqueue(dir, () => this.storage.putJSON(
      keyOf(spaceId, userId, agentSource, sessionId, hookId),
      blocks,
    )).catch(() => undefined);
  }

  async putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const dir = hookDir(spaceId, userId, agentSource, sessionId);
    await this.enqueue(dir, () => Promise.all(entries.map((entry) => this.storage.putJSON(
      keyOf(spaceId, userId, agentSource, sessionId, entry.hookId),
      entry.blocks,
    ))).then(() => undefined)).catch(() => undefined);
  }

  async replaceSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): Promise<void> {
    const dir = hookDir(spaceId, userId, agentSource, sessionId);
    await this.enqueue(dir, async () => {
      await this.storage.delPrefix(dir);
      try {
        await Promise.all(entries.map((entry) => this.storage.putJSON(
          keyOf(spaceId, userId, agentSource, sessionId, entry.hookId),
          entry.blocks,
        )));
      } catch (writeError) {
        try {
          await this.storage.delPrefix(dir);
        } catch (cleanupError) {
          throw new AggregateError(
            [writeError, cleanupError],
            "Hook-cache replacement and cleanup failed",
          );
        }
        throw writeError;
      }
    });
  }

  async get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null> {
    const dir = hookDir(spaceId, userId, agentSource, sessionId);
    try {
      return await this.enqueue(dir, () => this.storage.getJSON<ContextBlock[]>(
        keyOf(spaceId, userId, agentSource, sessionId, hookId),
      ));
    } catch {
      return null;
    }
  }

  async getAllForSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<HookCacheEntry[]> {
    const dir = hookDir(spaceId, userId, agentSource, sessionId);
    try {
      return await this.enqueue(dir, async () => {
        const names = await this.storage.listNames(dir);
        const out: HookCacheEntry[] = [];
        const settled = await Promise.all(
          names
            .filter((n) => n.endsWith(".json"))
            .map(async (n) => {
              const blocks = await this.storage
                .getJSON<ContextBlock[]>(dir + n)
                .catch(() => null);
              if (!Array.isArray(blocks)) return null;
              return { hookId: n.slice(0, -".json".length), blocks };
            }),
        );
        for (const entry of settled) if (entry) out.push(entry);
        return out;
      });
    } catch {
      return [];
    }
  }

  async clearBySession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<void> {
    const dir = hookDir(spaceId, userId, agentSource, sessionId);
    await this.enqueue(dir, () => this.storage.delPrefix(dir).then(() => undefined))
      .catch(() => undefined);
  }
}

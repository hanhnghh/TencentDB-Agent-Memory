import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../../storage/memory-storage.js";
import { KvHookCacheRepo } from "../kv-hook-cache-repo.js";

class DelayedFirstDeleteStorage extends MemoryStorage {
  private firstDelete = true;
  private releaseFirstDelete = (): void => {};
  private readonly firstDeleteGate = new Promise<void>((resolve) => {
    this.releaseFirstDelete = resolve;
  });

  release(): void {
    this.releaseFirstDelete();
  }

  override async delPrefix(prefix: string): Promise<number> {
    if (this.firstDelete) {
      this.firstDelete = false;
      await this.firstDeleteGate;
    }
    return super.delPrefix(prefix);
  }
}

class FailingHookWriteStorage extends MemoryStorage {
  private failNextBrokenWrite = true;

  override async putJSON(key: string, value: unknown): Promise<void> {
    if (this.failNextBrokenWrite && key.endsWith("/broken-injector.json")) {
      this.failNextBrokenWrite = false;
      throw new Error("injected hook-cache write failure");
    }
    await super.putJSON(key, value);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("KV hook-cache replacement", () => {
  it("serializes a second replacement behind a delayed session deletion", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new DelayedFirstDeleteStorage();
    const repo = new KvHookCacheRepo(storage);
    const identity: [string, string, string, string] = [
      "memory-1",
      "user-1",
      "codex",
      "context-key",
    ];

    const first = repo.replaceSession(...identity, [{
      hookId: "skill-injector",
      blocks: [{ type: "text", content: "first refresh" }],
    }]);
    const second = repo.replaceSession(...identity, [{
      hookId: "skill-injector",
      blocks: [{ type: "text", content: "second refresh" }],
    }]);
    storage.release();
    await Promise.all([first, second]);

    await expect(repo.getAllForSession(...identity)).resolves.toEqual([{
      hookId: "skill-injector",
      blocks: [{ type: "text", content: "second refresh" }],
    }]);
  });

  it("queues ordinary writes and reads behind a replacement", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new DelayedFirstDeleteStorage();
    const repo = new KvHookCacheRepo(storage);
    const identity: [string, string, string, string] = [
      "memory-1",
      "user-1",
      "codex",
      "context-key",
    ];
    const replacement = repo.replaceSession(...identity, [{
      hookId: "skill-injector",
      blocks: [{ type: "text", content: "fresh context" }],
    }]);
    let writeSettled = false;
    const write = repo.putMany(...identity, [{
      hookId: "knowledge-injector",
      blocks: [{ type: "text", content: "later write" }],
    }]).then(() => { writeSettled = true; });
    let readSettled = false;
    const read = repo.getAllForSession(...identity).then((entries) => {
      readSettled = true;
      return entries;
    });

    await Promise.resolve();
    expect(writeSettled).toBe(false);
    expect(readSettled).toBe(false);
    storage.release();
    await Promise.all([replacement, write]);
    await expect(read).resolves.toEqual(expect.arrayContaining([
      {
        hookId: "skill-injector",
        blocks: [{ type: "text", content: "fresh context" }],
      },
      {
        hookId: "knowledge-injector",
        blocks: [{ type: "text", content: "later write" }],
      },
    ]));
  });

  it("cleans a partial cache before reporting a replacement write failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new FailingHookWriteStorage();
    const repo = new KvHookCacheRepo(storage);
    const identity: [string, string, string, string] = [
      "memory-1",
      "user-1",
      "codex",
      "context-key",
    ];

    await expect(repo.replaceSession(...identity, [
      {
        hookId: "healthy-injector",
        blocks: [{ type: "text", content: "partial write" }],
      },
      {
        hookId: "broken-injector",
        blocks: [{ type: "text", content: "must fail" }],
      },
    ])).rejects.toThrow("injected hook-cache write failure");
    await expect(repo.getAllForSession(...identity)).resolves.toEqual([]);
  });
});

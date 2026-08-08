import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import { withProcessLock } from "../process-lock.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cross-process lock", () => {
  it("keeps concurrent stale-lock observers from removing the replacement owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-process-lock-"));
    roots.push(root);
    const lockDir = join(root, "lifecycle.lock");
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      token: "abandoned-generation",
    }));
    const options = {
      lockDir,
      retryMs: 1,
      timeoutMs: 2_000,
      malformedStaleMs: 30_000,
      busyError: () => new Error("busy"),
    };
    let active = 0;
    let maximumActive = 0;
    const action = async () => withProcessLock(options, async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await delay(20);
      active--;
    });

    await Promise.all([action(), action()]);

    expect(maximumActive).toBe(1);
  });
});

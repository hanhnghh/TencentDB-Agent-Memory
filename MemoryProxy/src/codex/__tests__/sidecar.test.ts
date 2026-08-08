import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startInstalledCodexSidecar } from "../sidecar.js";
import { resolveCodexInstallationPaths } from "../installation.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installed Codex sidecar", () => {
  it("forces hooks mode and places SQLite state in the protected user data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-sidecar-test-"));
    roots.push(root);
    const userConfigDir = join(root, "user state with spaces");
    const configFile = join(root, "config.yaml");
    await mkdir(userConfigDir);
    const projectDb = join(root, "project", "unsafe.db");
    await writeFile(configFile, [
      "runtime:",
      "  mode: proxy",
      "redis:",
      "  enabled: false",
      "storage:",
      "  enabled: true",
      "  backend: sqlite",
      "  sqlite:",
      `    dbPath: ${JSON.stringify(projectDb)}`,
      "",
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { MEMORY_CORE_SERVICE_TOKEN: "service-token-secret" };
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({
      health: {},
      connectivityChecked: Promise.resolve(),
      stop,
    }));

    const running = await startInstalledCodexSidecar({
      configFile,
      userConfigDir,
      env,
      start,
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ mode: "hooks" }),
      coreSkill: expect.objectContaining({ serviceToken: "service-token-secret" }),
      knowledge: expect.objectContaining({ serviceToken: "service-token-secret" }),
      storage: expect.objectContaining({
        sqlite: { dbPath: join(userConfigDir, "plugin-data", "data", "proxy.db") },
      }),
    }));
    expect(env.PROXY_DB_PATH).toBe(join(userConfigDir, "plugin-data", "data", "proxy.db"));
    expect(env.PROXY_OUTBOX_PATH).toBe(join(userConfigDir, "plugin-data", "data", "proxy.db"));
    const leaseFile = resolveCodexInstallationPaths(userConfigDir).sidecarLeaseFile;
    expect(JSON.parse(await readFile(leaseFile, "utf8"))).toMatchObject({ pid: process.pid });
    await running.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(stat(leaseFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains its authenticated lease and allows retry when durable drain fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-sidecar-retry-"));
    roots.push(root);
    const userConfigDir = join(root, "user-state");
    await mkdir(userConfigDir);
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error("outbox drain failed"))
      .mockResolvedValueOnce(undefined);
    const running = await startInstalledCodexSidecar({
      userConfigDir,
      env: {},
      start: async () => ({ stop }),
    });
    const leaseFile = resolveCodexInstallationPaths(userConfigDir).sidecarLeaseFile;

    await expect(running.stop()).rejects.toThrow("outbox drain failed");
    await expect(stat(leaseFile)).resolves.toBeDefined();
    await expect(running.stop()).resolves.toBeUndefined();
    await expect(stat(leaseFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

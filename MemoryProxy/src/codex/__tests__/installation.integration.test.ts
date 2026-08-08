import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  doctorCodexIntegration,
  installCodexIntegration,
  recordCodexHookTrust,
  resolveCodexInstallationPaths,
  uninstallCodexIntegration,
  upgradeCodexIntegration,
  type CodexCommandRunner,
  type CodexSidecarProcessManager,
} from "../installation.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  packageRoot: string;
  pluginRoot: string;
  projectDir: string;
  userConfigDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex package with spaces "));
  tempRoots.push(root);
  const packageRoot = join(root, "marketplace with spaces");
  const pluginRoot = join(packageRoot, "plugins", "tencentdb-agent-memory");
  const projectDir = join(root, "project");
  const userConfigDir = join(root, "protected user state");
  await Promise.all([
    mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true }),
    mkdir(join(pluginRoot, "scripts"), { recursive: true }),
    mkdir(projectDir),
  ]);
  await mkdir(join(packageRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(join(packageRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "tencentdb-agent-memory",
    interface: { displayName: "TencentDB Agent Memory" },
    plugins: [{
      name: "tencentdb-agent-memory",
      source: { source: "local", path: "./plugins/tencentdb-agent-memory" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }));
  await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "tencentdb-agent-memory",
    version: "1.2.3",
    description: "Memory hooks",
    author: { name: "TencentDB Agent Memory contributors" },
    interface: {
      displayName: "TencentDB Agent Memory",
      shortDescription: "Memory hooks",
      longDescription: "Memory hooks for Codex",
      developerName: "TencentDB Agent Memory contributors",
      category: "Productivity",
      capabilities: ["Session memory"],
      defaultPrompt: ["Use Agent Memory context."],
    },
  }));
  const thinHook = () => [{ hooks: [{
    type: "command",
    command: "node \"${PLUGIN_ROOT}/scripts/memory-hook.mjs\"",
  }] }];
  await writeFile(join(pluginRoot, "hooks.json"), JSON.stringify({ hooks: {
    SessionStart: thinHook(),
    UserPromptSubmit: thinHook(),
    PostToolUse: thinHook(),
    Stop: thinHook(),
    SessionEnd: thinHook(),
  } }));
  await writeFile(join(pluginRoot, "scripts", "memory-hook.mjs"), "#!/usr/bin/env node\n");
  return { packageRoot, pluginRoot, projectDir, userConfigDir };
}

class FakeCodex implements CodexCommandRunner {
  readonly calls: string[][] = [];
  readonly sidecar = new FakeSidecar();
  installed = false;
  enabled = true;

  constructor(private readonly packageRoot: string, private readonly pluginRoot: string) {}

  async run(args: string[]) {
    this.calls.push([...args]);
    if (args.join(" ") === "plugin marketplace list --json") {
      return {
        code: 0,
        stdout: JSON.stringify({ marketplaces: this.installed ? [{
          name: "tencentdb-agent-memory",
          root: this.packageRoot,
        }] : [] }),
        stderr: "",
      };
    }
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "plugin" && args[1] === "add") {
      this.installed = true;
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (args.join(" ") === "plugin list --json") {
      return {
        code: 0,
        stdout: JSON.stringify({ installed: this.installed ? [{
          pluginId: "tencentdb-agent-memory@tencentdb-agent-memory",
          name: "tencentdb-agent-memory",
          marketplaceName: "tencentdb-agent-memory",
          version: "1.2.3",
          installed: true,
          enabled: this.enabled,
          source: { source: "local", path: this.pluginRoot },
        }] : [] }),
        stderr: "",
      };
    }
    if (args[0] === "plugin" && args[1] === "remove") {
      this.installed = false;
      return { code: 0, stdout: "{}", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unsupported fake command" };
  }
}

class FakeSidecar implements CodexSidecarProcessManager {
  readonly calls: Array<{ operation: "start" | "stop"; value: unknown }> = [];
  running = false;
  failNextStart = false;

  async start(input: Parameters<CodexSidecarProcessManager["start"]>[0]): Promise<void> {
    this.calls.push({ operation: "start", value: input });
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("new sidecar failed");
    }
    this.running = true;
  }

  async stop(leaseFile: string): Promise<boolean> {
    this.calls.push({ operation: "stop", value: leaseFile });
    const wasRunning = this.running;
    this.running = false;
    return wasRunning;
  }
}

function bindingApi(taskPresent = true): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    const data = path === "/v3/meta/auth/verify"
      ? { valid: true, user: { user_id: "user-1" } }
      : path === "/v3/meta/team/list"
        ? { items: [{ team_id: "team-1" }], total: 1, limit: 100, offset: 0 }
        : path === "/v3/meta/agent/list"
          ? { items: [{ agent_id: "agent-1", team_id: "team-1" }], total: 1, limit: 100, offset: 0 }
          : path === "/v3/meta/task/list"
            ? {
                items: taskPresent ? [{ task_id: "task-1", team_id: "team-1" }] : [],
                total: taskPresent ? 1 : 0,
                limit: 100,
                offset: 0,
              }
            : null;
    if (!data) throw new Error(`unexpected binding path ${path}`);
    return new Response(JSON.stringify({ code: 0, data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("Codex integration installation", () => {
  it("installs a valid package from a path with spaces into protected user state without claiming trust", async () => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    const hooksBefore = await readFile(join(f.pluginRoot, "hooks.json"), "utf8");

    const result = await installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });

    expect(result).toMatchObject({
      installed: true,
      enabled: true,
      trusted: false,
      version: "1.2.3",
      sidecarRunning: true,
    });
    expect(result.review.hooksSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.review.instruction).toContain("/hooks");
    expect(codex.calls).toContainEqual([
      "plugin", "marketplace", "add", await realpath(f.packageRoot), "--json",
    ]);
    expect(codex.calls).toContainEqual([
      "plugin", "add", "tencentdb-agent-memory@tencentdb-agent-memory", "--json",
    ]);
    expect(await readFile(join(f.pluginRoot, "hooks.json"), "utf8")).toBe(hooksBefore);

    const paths = resolveCodexInstallationPaths(f.userConfigDir);
    expect((await stat(paths.rootDir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.stateFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.dataDir)).mode & 0o777).toBe(0o700);
    expect(paths.dataDir.startsWith(f.pluginRoot)).toBe(false);
    expect(codex.sidecar.calls.filter((call) => call.operation === "start")).toHaveLength(1);
  });

  it("rejects writable sidecar state inside the current project", async () => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);

    await expect(installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      projectDir: f.projectDir,
      userConfigDir: join(f.projectDir, ".codex", "agent-memory-data"),
      codex,
      sidecar: codex.sidecar,
    })).rejects.toMatchObject({ code: "state_in_project" });
    expect(codex.calls).toEqual([]);
  });

  it("uses a dedicated owned leaf without chmodding a broad user-config parent", async () => {
    const f = await fixture();
    const broadParent = join(f.projectDir, "..", "shared-config-parent");
    await mkdir(broadParent, { mode: 0o755 });
    await chmod(broadParent, 0o755);
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);

    await installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      projectDir: f.projectDir,
      userConfigDir: broadParent,
      codex,
      sidecar: codex.sidecar,
    });

    const paths = resolveCodexInstallationPaths(broadParent);
    expect(paths.rootDir).toBe(join(broadParent, "plugin-data"));
    expect((await stat(broadParent)).mode & 0o777).toBe(0o755);
    expect((await stat(paths.rootDir)).mode & 0o777).toBe(0o700);
  });

  it("reports installed, enabled, trusted, reachable, binding, MemoryCore, and outbox independently", async () => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    const installed = await installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });
    await recordCodexHookTrust({
      userConfigDir: f.userConfigDir,
      hooksSha256: installed.review.hooksSha256,
      codex,
    });
    await writeBinding(f.projectDir, f.userConfigDir);

    const diagnosis = await doctorCodexIntegration({
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      sidecarUrl: "http://127.0.0.1:8097",
      env: {
        MEMORY_CORE_ENDPOINT: "https://memory.example",
        MEMORY_CORE_SERVICE_TOKEN: "service-token-secret",
      },
      bindingFetcher: bindingApi(),
      fetcher: async () => new Response(JSON.stringify({
        status: "ok",
        connectivity: { memoryCore: "ok" },
        durableStore: {
          outbox: {
            pendingCount: 0,
            retryingCount: 0,
            deadCount: 0,
            workerErrorKind: null,
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    expect(diagnosis.ok).toBe(true);
    expect(Object.fromEntries(diagnosis.checks.map((check) => [check.name, check.status])))
      .toMatchObject({
        plugin_installed: "pass",
        plugin_enabled: "pass",
        hooks_trusted: "pass",
        sidecar_reachable: "pass",
        project_binding: "pass",
        binding_valid: "pass",
        memory_core_reachable: "pass",
        outbox_healthy: "pass",
      });
    expect(JSON.stringify(diagnosis)).not.toContain("user-key-secret");
    expect(JSON.stringify(diagnosis)).not.toContain("service-token-secret");
  });

  it("reports a syntactically valid binding as revoked when MemoryCore no longer lists its Task", async () => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    await writeBinding(f.projectDir, f.userConfigDir);

    const diagnosis = await doctorCodexIntegration({
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      env: {
        MEMORY_CORE_ENDPOINT: "https://memory.example",
        MEMORY_CORE_SERVICE_TOKEN: "service-token-secret",
      },
      bindingFetcher: bindingApi(false),
      fetcher: async () => new Response(JSON.stringify({
        connectivity: { memoryCore: "ok" },
        durableStore: { outbox: { deadCount: 0, retryingCount: 0 } },
      }), { status: 200 }),
    });

    expect(diagnosis.checks.find((check) => check.name === "project_binding"))
      .toMatchObject({ status: "pass" });
    expect(diagnosis.checks.find((check) => check.name === "binding_valid"))
      .toMatchObject({ status: "fail" });
    expect(diagnosis.checks.find((check) => check.name === "memory_core_reachable"))
      .toMatchObject({ status: "pass" });
    expect(JSON.stringify(diagnosis)).not.toContain("service-token-secret");
  });

  it("preserves live binding network failure classification without exposing credentials", async () => {
    const f = await fixture();
    await writeBinding(f.projectDir, f.userConfigDir);
    const diagnosis = await doctorCodexIntegration({
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex: new FakeCodex(f.packageRoot, f.pluginRoot),
      env: {
        MEMORY_CORE_ENDPOINT: "https://memory.example",
        MEMORY_CORE_SERVICE_TOKEN: "service-token-secret",
      },
      bindingFetcher: async () => { throw new TypeError("fetch failed"); },
      fetcher: async () => new Response("unavailable", { status: 500 }),
    });

    expect(diagnosis.checks.find((check) => check.name === "binding_valid")?.message)
      .toContain("could not be reached");
    expect(JSON.stringify(diagnosis)).not.toContain("service-token-secret");
    expect(JSON.stringify(diagnosis)).not.toContain("user-key-secret");
  });

  it("reports malformed installation state instead of crashing doctor", async () => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    const paths = resolveCodexInstallationPaths(f.userConfigDir);
    await mkdir(paths.rootDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.stateFile, "{broken-json", { mode: 0o600 });

    const diagnosis = await doctorCodexIntegration({
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      fetcher: async () => new Response("unavailable", { status: 503 }),
    });

    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.checks).toContainEqual({
      name: "installation_state",
      status: "fail",
      message: "Protected installation state is invalid",
    });
    expect(diagnosis.checks.map((check) => check.name)).toContain("project_binding");
    expect(diagnosis.checks.map((check) => check.name)).toContain("sidecar_reachable");
  });

  it.each([
    { status: 429, phrase: "throttled" },
    { status: 500, phrase: "server failure" },
    { status: 401, phrase: "client rejection" },
  ])("classifies sidecar HTTP $status without accepting a healthy-shaped body", async ({
    status,
    phrase,
  }) => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    await installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });

    const diagnosis = await doctorCodexIntegration({
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      fetcher: async () => new Response(JSON.stringify({
        status: "ok",
        connectivity: { memoryCore: "ok" },
        durableStore: { outbox: { deadCount: 0, retryingCount: 0 } },
      }), { status }),
    });
    const sidecar = diagnosis.checks.find((check) => check.name === "sidecar_reachable");
    expect(sidecar).toMatchObject({ status: "fail" });
    expect(sidecar?.message).toContain(phrase);
    expect(diagnosis.checks.find((check) => check.name === "memory_core_reachable"))
      .toMatchObject({ status: "fail" });
    expect(diagnosis.checks.find((check) => check.name === "outbox_healthy"))
      .toMatchObject({ status: "fail" });
  });

  it("keeps sidecar, MemoryCore, and outbox status independent for degraded HTTP 503 health", async () => {
    const f = await fixture();
    const diagnosis = await doctorCodexIntegration({
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex: new FakeCodex(f.packageRoot, f.pluginRoot),
      fetcher: async () => new Response(JSON.stringify({
        status: "degraded",
        listeners: { hooks: { ready: true } },
        connectivity: { memoryCore: "failed" },
        durableStore: {
          ready: true,
          outbox: { deadCount: 0, retryingCount: 0, workerErrorKind: null },
        },
      }), { status: 503 }),
    });

    expect(diagnosis.checks.find((check) => check.name === "sidecar_reachable"))
      .toMatchObject({ status: "pass" });
    expect(diagnosis.checks.find((check) => check.name === "memory_core_reachable"))
      .toMatchObject({ status: "fail" });
    expect(diagnosis.checks.find((check) => check.name === "outbox_healthy"))
      .toMatchObject({ status: "pass" });
  });

  it.each([
    {
      label: "timeout",
      failure: new DOMException("timed out", "TimeoutError"),
      phrase: "timed out",
    },
    { label: "network", failure: new TypeError("fetch failed"), phrase: "network failure" },
    { label: "malformed", failure: new SyntaxError("bad JSON"), phrase: "malformed" },
  ])("classifies a $label sidecar failure", async ({ failure, phrase }) => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    const diagnosis = await doctorCodexIntegration({
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      fetcher: async () => { throw failure; },
    });

    expect(diagnosis.checks.find((check) => check.name === "sidecar_reachable")?.message)
      .toContain(phrase);
  });

  it("invalidates recorded trust when an upgrade changes hook definitions", async () => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    const installed = await installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });
    await recordCodexHookTrust({
      userConfigDir: f.userConfigDir,
      hooksSha256: installed.review.hooksSha256,
      codex,
    });
    const updatedHook = (timeout?: number) => [{ hooks: [{
      type: "command",
      command: "node \"${PLUGIN_ROOT}/scripts/memory-hook.mjs\"",
      ...(timeout ? { timeout } : {}),
    }] }];
    await writeFile(join(f.pluginRoot, "hooks.json"), JSON.stringify({ hooks: {
      SessionStart: updatedHook(7),
      UserPromptSubmit: updatedHook(),
      PostToolUse: updatedHook(),
      Stop: updatedHook(),
      SessionEnd: updatedHook(),
    } }));

    const upgraded = await upgradeCodexIntegration({
      marketplaceRoot: f.packageRoot,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });

    expect(upgraded.trusted).toBe(false);
    expect(upgraded.review.hooksSha256).not.toBe(installed.review.hooksSha256);
    expect(upgraded.review.instruction).toContain("/hooks");
  });

  it("restarts the prior managed sidecar when an upgraded sidecar fails to start", async () => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    await installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });
    codex.sidecar.failNextStart = true;

    await expect(upgradeCodexIntegration({
      marketplaceRoot: f.packageRoot,
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    })).rejects.toThrow("new sidecar failed");

    expect(codex.sidecar.running).toBe(true);
    expect(codex.sidecar.calls.filter((call) => call.operation === "start")).toHaveLength(3);
  });

  it("uninstalls lifecycle hooks while retaining durable data unless purge is explicit", async () => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    await installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });
    const paths = resolveCodexInstallationPaths(f.userConfigDir);
    await writeFile(join(paths.dataDir, "durable.db"), "durable memory");

    const retained = await uninstallCodexIntegration({
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });

    expect(retained).toEqual({
      removed: true,
      dataDisposition: "retained",
      dataPath: paths.dataDir,
    });
    expect(codex.sidecar.calls.filter((call) => call.operation === "stop").length)
      .toBeGreaterThanOrEqual(2);
    expect(await readFile(join(paths.dataDir, "durable.db"), "utf8")).toBe("durable memory");

    await installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });
    const purged = await uninstallCodexIntegration({
      userConfigDir: f.userConfigDir,
      codex,
      purgeData: true,
      sidecar: codex.sidecar,
    });
    expect(purged.dataDisposition).toBe("purged");
    await expect(stat(paths.dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not purge an unowned data directory when installation state is absent", async () => {
    const f = await fixture();
    const codex = new FakeCodex(f.packageRoot, f.pluginRoot);
    const paths = resolveCodexInstallationPaths(f.userConfigDir);
    await mkdir(paths.dataDir, { recursive: true });
    await writeFile(join(paths.dataDir, "sentinel"), "keep");

    const result = await uninstallCodexIntegration({
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
      purgeData: true,
    });

    expect(result).toEqual({
      removed: false,
      dataDisposition: "retained",
      dataPath: paths.dataDir,
    });
    await expect(readFile(join(paths.dataDir, "sentinel"), "utf8")).resolves.toBe("keep");
  });

  it("serializes install and uninstall so a late install cannot resurrect lifecycle state", async () => {
    const f = await fixture();
    let releaseInstall: () => void = () => undefined;
    let notifyBlocked: () => void = () => undefined;
    const blocked = new Promise<void>((resolveBlocked) => { notifyBlocked = resolveBlocked; });
    const release = new Promise<void>((resolveRelease) => { releaseInstall = resolveRelease; });
    class BlockingCodex extends FakeCodex {
      override async run(args: string[]) {
        if (args[0] === "plugin" && args[1] === "add") {
          notifyBlocked();
          await release;
        }
        return super.run(args);
      }
    }
    const codex = new BlockingCodex(f.packageRoot, f.pluginRoot);
    const installing = installCodexIntegration({
      marketplaceRoot: f.packageRoot,
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });
    await blocked;
    const uninstalling = uninstallCodexIntegration({
      projectDir: f.projectDir,
      userConfigDir: f.userConfigDir,
      codex,
      sidecar: codex.sidecar,
    });
    releaseInstall();

    await installing;
    await expect(uninstalling).resolves.toMatchObject({ removed: true });
    await expect(stat(resolveCodexInstallationPaths(f.userConfigDir).stateFile))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function writeBinding(projectDir: string, userConfigDir: string): Promise<void> {
  await Promise.all([
    mkdir(join(projectDir, ".codex"), { recursive: true }),
    mkdir(userConfigDir, { recursive: true, mode: 0o700 }),
  ]);
  await chmod(userConfigDir, 0o700);
  await writeFile(join(projectDir, ".codex", "memory-binding.json"), JSON.stringify({
    version: 1,
    source: "codex",
    service_id: "memory-1",
    team_id: "team-1",
    agent_id: "agent-1",
    task_id: "task-1",
  }));
  await writeFile(join(userConfigDir, "credentials.json"), JSON.stringify({
    version: 1,
    user_keys: { "memory-1": "user-key-secret" },
  }), { mode: 0o600 });
  await chmod(join(userConfigDir, "credentials.json"), 0o600);
}

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_BINDING_RELATIVE_PATH,
  resolveCredentialPath,
} from "../binding.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "../../..");
const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ projectDir: string; userConfigDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-cli-integration-test-"));
  tempRoots.push(root);
  const projectDir = join(root, "project");
  const userConfigDir = join(root, "user-config");
  await mkdir(projectDir);
  return { projectDir, userConfigDir };
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx/esm", "src/codex/cli.ts", ...args],
    {
      cwd: packageRoot,
      env: { ...process.env, ...env },
    },
  );
}

async function runCliAllowFailure(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  try {
    return { ...(await runCli(args, env)), failed: false };
  } catch (error: unknown) {
    if (!error || typeof error !== "object") throw error;
    const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    return { stdout, stderr, failed: true };
  }
}

async function seedLocalBinding(projectDir: string, userConfigDir: string): Promise<void> {
  const projectPath = join(projectDir, PROJECT_BINDING_RELATIVE_PATH);
  const credentialPath = resolveCredentialPath(userConfigDir);
  await Promise.all([
    mkdir(dirname(projectPath), { recursive: true }),
    mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 }),
  ]);
  await chmod(dirname(credentialPath), 0o700);
  await Promise.all([
    writeFile(projectPath, `${JSON.stringify({
      version: 1,
      source: "codex",
      service_id: "memory-1",
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
    })}\n`, { mode: 0o644 }),
    writeFile(credentialPath, `${JSON.stringify({
      version: 1,
      user_keys: { "memory-1": "stored-user-key-secret" },
    })}\n`, { mode: 0o600 }),
  ]);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close((error) => (
    error ? reject(error) : resolveClose()
  )));
}

describe("Codex binding executable CLI", () => {
  it("binds through auth and Team/Agent/Task metadata before writing protected files", async () => {
    const dirs = await setup();
    const projectPath = join(dirs.projectDir, PROJECT_BINDING_RELATIVE_PATH);
    const credentialPath = resolveCredentialPath(dirs.userConfigDir);
    const requests: string[] = [];
    let persistedDuringValidation = false;
    const server = createServer(async (request, response) => {
      const path = request.url ?? "";
      requests.push(path);
      persistedDuringValidation ||= await access(projectPath).then(() => true, () => false);
      const data = path === "/v3/meta/auth/verify"
        ? { valid: true, user: { user_id: "user-1" } }
        : path === "/v3/meta/team/list"
          ? { items: [{ team_id: "team-1" }], total: 1, limit: 100, offset: 0 }
          : path === "/v3/meta/agent/list"
            ? { items: [{ agent_id: "agent-1", team_id: "team-1" }], total: 1, limit: 100, offset: 0 }
            : { items: [{ task_id: "task-1", team_id: "team-1" }], total: 1, limit: 100, offset: 0 };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ code: 0, data }));
    });
    const endpoint = await listen(server);

    let output: { stdout: string; stderr: string };
    try {
      output = await runCli([
        "bind",
        "--project", dirs.projectDir,
        "--user-config-dir", dirs.userConfigDir,
        "--endpoint", endpoint,
        "--service-id", "memory-1",
        "--team-id", "team-1",
        "--agent-id", "agent-1",
        "--task-id", "task-1",
      ], {
        MEMORY_CORE_SERVICE_TOKEN: "service-token-secret",
        MEMORY_HUB_USER_KEY: "user-key-secret",
      });
    } finally {
      await close(server);
    }

    expect(new Set(requests)).toEqual(new Set([
      "/v3/meta/auth/verify",
      "/v3/meta/team/list",
      "/v3/meta/agent/list",
      "/v3/meta/task/list",
    ]));
    expect(persistedDuringValidation).toBe(false);
    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      version: 1,
      source: "codex",
      service_id: "memory-1",
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
    });
    expect(await readFile(projectPath, "utf8")).not.toContain("user-key-secret");
    expect(await readFile(credentialPath, "utf8")).toContain("user-key-secret");
    expect((await stat(dirs.userConfigDir)).mode & 0o777).toBe(0o700);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    expect(`${output.stdout}\n${output.stderr}`).not.toContain("user-key-secret");
    expect(`${output.stdout}\n${output.stderr}`).not.toContain("service-token-secret");
  });

  it("runs binding-status locally without model or network interaction", async () => {
    const dirs = await setup();
    await seedLocalBinding(dirs.projectDir, dirs.userConfigDir);

    const output = await runCli([
      "binding-status",
      "--project", dirs.projectDir,
      "--user-config-dir", dirs.userConfigDir,
    ], { MEMORY_CORE_ENDPOINT: "http://127.0.0.1:1" });

    expect(output.stdout).toContain('"bound": true');
    expect(output.stdout).not.toContain("stored-user-key-secret");
  });

  it("runs the complete doctor without a model and reports inactive lifecycle components", async () => {
    const dirs = await setup();
    await seedLocalBinding(dirs.projectDir, dirs.userConfigDir);

    const output = await runCliAllowFailure([
      "doctor",
      "--project", dirs.projectDir,
      "--user-config-dir", dirs.userConfigDir,
      "--sidecar-url", "http://127.0.0.1:1",
    ], {
      CODEX_HOME: dirs.userConfigDir,
      MEMORY_CORE_ENDPOINT: "http://127.0.0.1:1",
    });

    expect(output.failed).toBe(true);
    expect(output.stdout).toContain("PASS project_binding");
    expect(output.stdout).toContain("FAIL plugin_installed");
    expect(output.stdout).toContain("FAIL sidecar_reachable");
    expect(output.stdout).not.toContain("stored-user-key-secret");
  });

  it("ships an executable package entrypoint for lifecycle commands", async () => {
    const output = await execFileAsync(process.execPath, [
      "scripts/tdai-codex-memory.mjs",
      "help",
    ], { cwd: packageRoot, env: process.env });

    expect(output.stdout).toContain("install");
    expect(output.stdout).toContain("sidecar");
    expect(output.stdout).toContain("trust");
    expect(output.stdout).toContain("uninstall");
  });

  it("runs unbind locally without model or network interaction", async () => {
    const dirs = await setup();
    await seedLocalBinding(dirs.projectDir, dirs.userConfigDir);

    const output = await runCli([
      "unbind",
      "--project", dirs.projectDir,
      "--user-config-dir", dirs.userConfigDir,
    ], { MEMORY_CORE_ENDPOINT: "http://127.0.0.1:1" });

    expect(output.stdout).toContain("Codex project binding removed");
    await expect(access(join(dirs.projectDir, PROJECT_BINDING_RELATIVE_PATH))).rejects.toBeDefined();
    await expect(readFile(resolveCredentialPath(dirs.userConfigDir), "utf8"))
      .resolves.toContain("stored-user-key-secret");
  });

  it("documents distinct binding, proxy-upstream, and memory-model credentials in both locales", async () => {
    const [english, chinese] = await Promise.all([
      readFile(join(packageRoot, "README.md"), "utf8"),
      readFile(join(packageRoot, "README_CN.md"), "utf8"),
    ]);

    for (const documentation of [english, chinese]) {
      expect(documentation).toContain("MEMORY_HUB_USER_KEY");
      expect(documentation).toContain("MEMORY_CORE_SERVICE_TOKEN");
      expect(documentation).toContain("PROXY_UPSTREAM_API_KEY");
      expect(documentation).toContain("MEMORY_LLM_API_KEY");
    }
  });
});

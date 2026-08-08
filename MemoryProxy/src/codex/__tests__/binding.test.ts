import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_BINDING_RELATIVE_PATH,
  bindCodexProject,
  resolveCredentialPath,
} from "../binding.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-binding-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulApi(): typeof fetch {
  return vi.fn(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

    if (path === "/v3/meta/auth/verify") {
      expect(body).toEqual({ user_key: "user-key-secret" });
      return jsonResponse({ code: 0, data: { valid: true, user: { user_id: "user-1" } } });
    }

    expect(new Headers(init?.headers).get("x-tdai-user-key")).toBe("user-key-secret");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service-secret");

    if (path === "/v3/meta/team/list") {
      return jsonResponse({ code: 0, data: { items: [{ team_id: "team-1", name: "Team" }], total: 1, limit: 100, offset: 0 } });
    }
    if (path === "/v3/meta/agent/list") {
      return jsonResponse({ code: 0, data: { items: [{ agent_id: "agent-1", team_id: "team-1", name: "Agent" }], total: 1, limit: 100, offset: 0 } });
    }
    if (path === "/v3/meta/task/list") {
      return jsonResponse({ code: 0, data: { items: [{ task_id: "task-1", team_id: "team-1", title: "Task" }], total: 1, limit: 100, offset: 0 } });
    }
    throw new Error(`unexpected path ${path}`);
  }) as typeof fetch;
}

describe("validated Codex project binding", () => {
  it("validates the user and complete Team/Agent/Task scope before persisting", async () => {
    const root = await makeTempRoot();
    const projectDir = join(root, "project");
    const userConfigDir = join(root, "user-config");
    await mkdir(projectDir);

    const result = await bindCodexProject({
      projectDir,
      userConfigDir,
      endpoint: "https://memory.example",
      authUrl: "https://auth.example",
      serviceId: "memory-1",
      serviceToken: "service-secret",
      userKey: "user-key-secret",
      teamId: "team-1",
      agentId: "agent-1",
      taskId: "task-1",
      fetcher: successfulApi(),
    });

    expect(result.userId).toBe("user-1");
    const projectText = await readFile(join(projectDir, PROJECT_BINDING_RELATIVE_PATH), "utf8");
    expect(JSON.parse(projectText)).toEqual({
      version: 1,
      source: "codex",
      service_id: "memory-1",
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
    });
    expect(projectText).not.toContain("user-key-secret");
    expect(projectText).not.toContain("service-secret");

    const credentialPath = resolveCredentialPath(userConfigDir);
    const credentialText = await readFile(credentialPath, "utf8");
    expect(credentialText).toContain("user-key-secret");
    expect(credentialText).not.toContain("service-secret");
    expect((await stat(userConfigDir)).mode & 0o777).toBe(0o700);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects an invalid user key before creating either config", async () => {
    const root = await makeTempRoot();
    const projectDir = join(root, "project");
    const userConfigDir = join(root, "user-config");
    await mkdir(projectDir);
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { valid: false } })) as typeof fetch;

    await expect(bindCodexProject({
      projectDir,
      userConfigDir,
      endpoint: "https://memory.example",
      authUrl: "https://auth.example",
      serviceId: "memory-1",
      serviceToken: "service-secret",
      userKey: "invalid-secret",
      teamId: "team-1",
      agentId: "agent-1",
      taskId: "task-1",
      fetcher,
    })).rejects.toThrow("User key is invalid or unauthorized");

    await expect(readFile(join(projectDir, PROJECT_BINDING_RELATIVE_PATH))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolveCredentialPath(userConfigDir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing, cross-team, or unauthorized IDs without persistence", async () => {
    const root = await makeTempRoot();
    const projectDir = join(root, "project");
    const userConfigDir = join(root, "user-config");
    await mkdir(projectDir);
    const fetcher = successfulApi();

    await expect(bindCodexProject({
      projectDir,
      userConfigDir,
      endpoint: "https://memory.example",
      authUrl: "https://auth.example",
      serviceId: "memory-1",
      serviceToken: "service-secret",
      userKey: "user-key-secret",
      teamId: "team-1",
      agentId: "agent-other",
      taskId: "task-1",
      fetcher,
    })).rejects.toThrow("Agent 'agent-other' is missing or unauthorized for Team 'team-1'");

    await expect(readFile(join(projectDir, PROJECT_BINDING_RELATIVE_PATH))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolveCredentialPath(userConfigDir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires Task for initial runtime parity", async () => {
    const root = await makeTempRoot();
    const projectDir = join(root, "project");
    await mkdir(projectDir);

    await expect(bindCodexProject({
      projectDir,
      userConfigDir: join(root, "user-config"),
      endpoint: "https://memory.example",
      authUrl: "https://auth.example",
      serviceId: "memory-1",
      serviceToken: "service-secret",
      userKey: "user-key-secret",
      teamId: "team-1",
      agentId: "agent-1",
      taskId: "",
      fetcher: successfulApi(),
    })).rejects.toThrow("Task ID is required");
  });

  it("redacts credentials from remote validation failures", async () => {
    const root = await makeTempRoot();
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const base = successfulApi();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v3/meta/team/list") {
        return new Response("user-key-secret service-secret", { status: 500 });
      }
      return base(input, init);
    }) as typeof fetch;

    let message = "";
    try {
      await bindCodexProject({
        projectDir,
        userConfigDir: join(root, "user-config"),
        endpoint: "https://memory.example",
        authUrl: "https://auth.example",
        serviceId: "memory-1",
        serviceToken: "service-secret",
        userKey: "user-key-secret",
        teamId: "team-1",
        agentId: "agent-1",
        taskId: "task-1",
        fetcher,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Unable to validate Team");
    expect(message).not.toContain("user-key-secret");
    expect(message).not.toContain("service-secret");
    expect(message).toContain("[REDACTED]");
  });

  it("refuses secret-like project preferences before validation or persistence", async () => {
    const root = await makeTempRoot();
    const projectDir = join(root, "project");
    const userConfigDir = join(root, "user-config");
    await mkdir(projectDir);
    const fetcher = successfulApi();

    await expect(bindCodexProject({
      projectDir,
      userConfigDir,
      endpoint: "https://memory.example",
      authUrl: "https://auth.example",
      serviceId: "memory-1",
      serviceToken: "service-secret",
      userKey: "user-key-secret",
      teamId: "team-1",
      agentId: "agent-1",
      taskId: "task-1",
      preferences: { apiKey: "must-not-be-local" },
      fetcher,
    })).rejects.toThrow("Project binding contains forbidden secret field 'apiKey'");

    expect(fetcher).not.toHaveBeenCalled();
    await expect(readFile(join(projectDir, PROJECT_BINDING_RELATIVE_PATH))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolveCredentialPath(userConfigDir))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

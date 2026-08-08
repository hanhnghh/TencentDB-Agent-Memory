import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_BINDING_RELATIVE_PATH,
  bindCodexProject,
  doctorCodexBinding,
  getCodexBindingStatus,
  resolveCredentialPath,
  unbindCodexProject,
} from "../binding.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ projectDir: string; userConfigDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-operations-test-"));
  tempRoots.push(root);
  const projectDir = join(root, "project");
  const userConfigDir = join(root, "user-config");
  await mkdir(projectDir);
  return { projectDir, userConfigDir };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

function api(): typeof fetch {
  return vi.fn(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/auth/verify")) {
      return jsonResponse({ code: 0, data: { valid: true, user: { user_id: "user-1" } } });
    }
    const items = path.endsWith("/team/list")
      ? [{ team_id: "team-1", name: "Team" }]
      : path.endsWith("/agent/list")
        ? [{ agent_id: "agent-1", team_id: "team-1", name: "Agent" }]
        : [{ task_id: "task-1", team_id: "team-1", title: "Task" }];
    return jsonResponse({ code: 0, data: { items, total: 1, limit: 100, offset: 0 } });
  }) as typeof fetch;
}

async function bind(projectDir: string, userConfigDir: string): Promise<void> {
  await bindCodexProject({
    projectDir,
    userConfigDir,
    endpoint: "https://memory.example",
    serviceId: "memory-1",
    serviceToken: "service-secret",
    userKey: "user-key-secret",
    teamId: "team-1",
    agentId: "agent-1",
    taskId: "task-1",
    fetcher: api(),
  });
}

describe("Codex binding operations", () => {
  it("reports binding and credential presence without returning the credential", async () => {
    const dirs = await setup();
    await bind(dirs.projectDir, dirs.userConfigDir);

    const status = await getCodexBindingStatus(dirs);

    expect(status.bound).toBe(true);
    expect(status.credentialConfigured).toBe(true);
    expect(status.binding?.task_id).toBe("task-1");
    expect(JSON.stringify(status)).not.toContain("user-key-secret");
  });

  it("diagnoses protected credential permissions locally", async () => {
    const dirs = await setup();
    await bind(dirs.projectDir, dirs.userConfigDir);

    expect((await doctorCodexBinding(dirs)).ok).toBe(true);

    await chmod(resolveCredentialPath(dirs.userConfigDir), 0o644);
    const diagnosis = await doctorCodexBinding(dirs);
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.checks).toContainEqual(expect.objectContaining({
      name: "credential_permissions",
      status: "fail",
    }));
    expect(JSON.stringify(diagnosis)).not.toContain("user-key-secret");
  });

  it("diagnoses broad protected credential directory permissions locally", async () => {
    const dirs = await setup();
    await bind(dirs.projectDir, dirs.userConfigDir);

    await chmod(dirs.userConfigDir, 0o755);
    const diagnosis = await doctorCodexBinding(dirs);
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.checks).toContainEqual(expect.objectContaining({
      name: "credential_directory_permissions",
      status: "fail",
    }));
    expect(JSON.stringify(diagnosis)).not.toContain("user-key-secret");
  });

  it("diagnoses a credential store placed inside the project", async () => {
    const dirs = await setup();
    await bind(dirs.projectDir, dirs.userConfigDir);
    const localConfigDir = join(dirs.projectDir, ".codex", "user-config");
    await mkdir(localConfigDir, { recursive: true, mode: 0o700 });
    await chmod(localConfigDir, 0o700);
    await writeFile(
      resolveCredentialPath(localConfigDir),
      `${JSON.stringify({ version: 1, user_keys: { "memory-1": "user-key-secret" } })}\n`,
      { mode: 0o600 },
    );

    const diagnosis = await doctorCodexBinding({
      projectDir: dirs.projectDir,
      userConfigDir: localConfigDir,
    });

    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.checks).toContainEqual(expect.objectContaining({
      name: "credential_location",
      status: "fail",
    }));
    expect(JSON.stringify(diagnosis)).not.toContain("user-key-secret");
  });

  it("unbinds without model or network interaction and optionally forgets the credential", async () => {
    const dirs = await setup();
    await bind(dirs.projectDir, dirs.userConfigDir);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const first = await unbindCodexProject(dirs);
    expect(first.removed).toBe(true);
    expect(first.credentialRemoved).toBe(false);
    expect((await getCodexBindingStatus(dirs)).bound).toBe(false);
    expect(await readFile(resolveCredentialPath(dirs.userConfigDir), "utf8")).toContain("user-key-secret");

    await bind(dirs.projectDir, dirs.userConfigDir);
    const second = await unbindCodexProject({ ...dirs, forgetCredential: true });
    expect(second).toEqual({ removed: true, credentialRemoved: true });
    await expect(stat(resolveCredentialPath(dirs.userConfigDir))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("removes an invalid project binding so unbind can recover local state", async () => {
    const dirs = await setup();
    const projectPath = join(dirs.projectDir, PROJECT_BINDING_RELATIVE_PATH);
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(projectPath, "{not-json");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(unbindCodexProject(dirs)).resolves.toEqual({
      removed: true,
      credentialRemoved: false,
    });
    await expect(stat(projectPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("removes an invalid project binding when credential cleanup was requested", async () => {
    const dirs = await setup();
    const projectPath = join(dirs.projectDir, PROJECT_BINDING_RELATIVE_PATH);
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(projectPath, "{not-json");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(unbindCodexProject({
      ...dirs,
      forgetCredential: true,
    })).resolves.toEqual({
      removed: true,
      credentialRemoved: false,
    });
    await expect(stat(projectPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not acknowledge unbind when requested credential cleanup fails", async () => {
    const dirs = await setup();
    await bind(dirs.projectDir, dirs.userConfigDir);
    await writeFile(resolveCredentialPath(dirs.userConfigDir), "{not-json", { mode: 0o600 });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(unbindCodexProject({
      ...dirs,
      forgetCredential: true,
    })).rejects.toMatchObject({ code: "credential_store_invalid" });
    await expect(stat(join(dirs.projectDir, PROJECT_BINDING_RELATIVE_PATH)))
      .resolves.toBeDefined();
    await expect(readFile(resolveCredentialPath(dirs.userConfigDir), "utf8"))
      .resolves.toBe("{not-json");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects secret fields in project-local configuration", async () => {
    const dirs = await setup();
    const projectPath = join(dirs.projectDir, PROJECT_BINDING_RELATIVE_PATH);
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(projectPath, JSON.stringify({
      version: 1,
      source: "codex",
      service_id: "memory-1",
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
      userKey: "must-not-be-here",
    }));

    await expect(getCodexBindingStatus(dirs)).rejects.toThrow(
      "Project binding contains forbidden secret field 'userKey'",
    );
    const diagnosis = await doctorCodexBinding(dirs);
    expect(diagnosis.ok).toBe(false);
    expect(JSON.stringify(diagnosis)).not.toContain("must-not-be-here");
  });

  it.each([
    {
      label: "malformed JSON",
      content: "{not-json",
      message: "Cannot read project binding",
    },
    {
      label: "unsupported version",
      content: JSON.stringify({
        version: 2,
        source: "codex",
        service_id: "memory-1",
        team_id: "team-1",
        agent_id: "agent-1",
        task_id: "task-1",
      }),
      message: "version 1 and source 'codex'",
    },
    {
      label: "non-Codex source",
      content: JSON.stringify({
        version: 1,
        source: "unknown",
        service_id: "memory-1",
        team_id: "team-1",
        agent_id: "agent-1",
        task_id: "task-1",
      }),
      message: "version 1 and source 'codex'",
    },
    {
      label: "missing Task ID",
      content: JSON.stringify({
        version: 1,
        source: "codex",
        service_id: "memory-1",
        team_id: "team-1",
        agent_id: "agent-1",
      }),
      message: "Task ID is required",
    },
    {
      label: "unsupported field",
      content: JSON.stringify({
        version: 1,
        source: "codex",
        service_id: "memory-1",
        team_id: "team-1",
        agent_id: "agent-1",
        task_id: "task-1",
        extra: true,
      }),
      message: "unsupported field 'extra'",
    },
  ])("rejects an invalid project binding with $label", async ({ content, message }) => {
    const dirs = await setup();
    const projectPath = join(dirs.projectDir, PROJECT_BINDING_RELATIVE_PATH);
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(projectPath, content);

    await expect(getCodexBindingStatus(dirs)).rejects.toThrow(message);
    const diagnosis = await doctorCodexBinding(dirs);
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.checks).toContainEqual(expect.objectContaining({
      name: "project_binding",
      status: "fail",
    }));
  });

  it.fails(
    "TARGET (deferred runtime validation): doctor rejects well-formed project IDs edited after bind",
    async () => {
      const dirs = await setup();
      await bind(dirs.projectDir, dirs.userConfigDir);
      const projectPath = join(dirs.projectDir, PROJECT_BINDING_RELATIVE_PATH);
      const edited = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
      edited.task_id = "task-not-authorized";
      await writeFile(projectPath, `${JSON.stringify(edited)}\n`);

      await expect(doctorCodexBinding(dirs)).resolves.toMatchObject({ ok: false });
    },
  );
});

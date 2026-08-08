import { describe, expect, it, vi } from "vitest";

import { runCodexBindingCli, type CodexBindingCliDependencies } from "../cli.js";

function harness(overrides: Partial<CodexBindingCliDependencies> = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const dependencies: CodexBindingCliDependencies = {
    bind: vi.fn(async (input) => ({
      binding: {
        version: 1 as const,
        source: "codex" as const,
        service_id: input.serviceId,
        team_id: input.teamId,
        agent_id: input.agentId,
        task_id: input.taskId,
      },
      projectConfigPath: "/project/.codex/memory-binding.json",
      credentialPath: "/user/credentials.json",
      userId: "user-1",
    })),
    status: vi.fn(async () => ({
      bound: true,
      credentialConfigured: true,
      binding: {
        version: 1 as const,
        source: "codex" as const,
        service_id: "memory-1",
        team_id: "team-1",
        agent_id: "agent-1",
        task_id: "task-1",
      },
      projectConfigPath: "/project/.codex/memory-binding.json",
      credentialPath: "/user/credentials.json",
    })),
    doctor: vi.fn(async () => ({ ok: true, checks: [] })),
    unbind: vi.fn(async () => ({ removed: true, credentialRemoved: false })),
    manage: vi.fn(async (input) => ({
      message: `${input.operation} completed`,
      data: { operation: input.operation },
    })),
    ...overrides,
  };
  return {
    output,
    errors,
    dependencies,
    io: {
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    },
  };
}

describe("Codex binding CLI", () => {
  it("binds from explicit IDs and environment credentials without printing secrets", async () => {
    const h = harness();
    const env = {
      MEMORY_CORE_ENDPOINT: "https://memory.example",
      MEMORY_CORE_SERVICE_TOKEN: "service-secret",
      MEMORY_HUB_USER_KEY: "user-key-secret",
    };

    const code = await runCodexBindingCli([
      "bind",
      "--project", "/project",
      "--service-id", "memory-1",
      "--team-id", "team-1",
      "--agent-id", "agent-1",
      "--task-id", "task-1",
    ], h.io, env, h.dependencies);

    expect(code).toBe(0);
    expect(h.dependencies.bind).toHaveBeenCalledWith(expect.objectContaining({
      userKey: "user-key-secret",
      serviceToken: "service-secret",
      taskId: "task-1",
    }));
    expect([...h.output, ...h.errors].join("\n")).not.toContain("user-key-secret");
    expect([...h.output, ...h.errors].join("\n")).not.toContain("service-secret");
  });

  it("rejects shell-visible credential options without echoing their values", async () => {
    const h = harness();
    const code = await runCodexBindingCli([
      "bind",
      "--endpoint", "https://memory.example",
      "--service-token=service-secret",
      "--user-key", "user-key-secret",
      "--service-id", "memory-1",
      "--team-id", "team-1",
      "--agent-id", "agent-1",
      "--task-id", "task-1",
    ], h.io, {}, h.dependencies);

    expect(code).toBe(2);
    expect(h.errors.join("\n")).toContain("MEMORY_CORE_SERVICE_TOKEN");
    expect([...h.output, ...h.errors].join("\n")).not.toContain("service-secret");
    expect([...h.output, ...h.errors].join("\n")).not.toContain("user-key-secret");
    expect(h.dependencies.bind).not.toHaveBeenCalled();
  });

  it("redacts environment credentials from bind failures", async () => {
    const h = harness({
      bind: vi.fn(async () => {
        throw new Error("dependency echoed user-key-secret and service-secret");
      }),
    });
    const code = await runCodexBindingCli([
      "bind",
      "--endpoint", "https://memory.example",
      "--service-id", "memory-1",
      "--team-id", "team-1",
      "--agent-id", "agent-1",
      "--task-id", "task-1",
    ], h.io, {
      MEMORY_CORE_SERVICE_TOKEN: "service-secret",
      MEMORY_HUB_USER_KEY: "user-key-secret",
    }, h.dependencies);

    expect(code).toBe(1);
    expect(h.errors.join("\n")).toContain("[REDACTED]");
    expect(h.errors.join("\n")).not.toContain("user-key-secret");
    expect(h.errors.join("\n")).not.toContain("service-secret");
  });

  it("supports binding-status, doctor, and unbind without model interaction", async () => {
    const h = harness();

    expect(await runCodexBindingCli(["binding-status", "--project", "/project"], h.io, {}, h.dependencies)).toBe(0);
    expect(await runCodexBindingCli(["doctor", "--project", "/project"], h.io, {}, h.dependencies)).toBe(0);
    expect(await runCodexBindingCli(["unbind", "--project", "/project"], h.io, {}, h.dependencies)).toBe(0);

    expect(h.dependencies.status).toHaveBeenCalledTimes(1);
    expect(h.dependencies.doctor).toHaveBeenCalledTimes(1);
    expect(h.dependencies.unbind).toHaveBeenCalledTimes(1);
  });

  it.each([
    { command: "sync", operation: "refresh" },
    { command: "refresh", operation: "refresh" },
    { command: "force-archive", operation: "force-archive" },
  ])("runs $command through the local sidecar", async ({ command, operation }) => {
    const h = harness();

    const code = await runCodexBindingCli([
      command,
      "--session-id", "session-1",
      "--sidecar-url", "http://127.0.0.1:8097",
      ...(command === "force-archive" ? ["--reason", "capture migration workflow"] : []),
    ], h.io, {}, h.dependencies);

    expect(code).toBe(0);
    expect(h.dependencies.manage).toHaveBeenCalledWith(expect.objectContaining({
      operation,
      sessionId: "session-1",
      sidecarUrl: "http://127.0.0.1:8097",
    }));
    expect(h.output.join("\n")).toContain(`${operation} completed`);
  });

  it("creates a skill through the local sidecar without model interception", async () => {
    const h = harness();

    const code = await runCodexBindingCli([
      "create-skill",
      "--session-id", "session-1",
      "--name", "migration-checklist",
      "--content-file", "/project/SKILL.md",
    ], h.io, {}, h.dependencies);

    expect(code).toBe(0);
    expect(h.dependencies.manage).toHaveBeenCalledWith(expect.objectContaining({
      operation: "create-skill",
      name: "migration-checklist",
      contentFile: "/project/SKILL.md",
    }));
  });

  it("documents proxy-only mem interception and the hooks-mode equivalents", async () => {
    const h = harness();

    expect(await runCodexBindingCli(["mem-help"], h.io, {}, h.dependencies)).toBe(0);
    expect(h.output.join("\n")).toContain("mem:* request interception is proxy-only");
    expect(h.output.join("\n")).toContain("sync");
    expect(h.output.join("\n")).toContain("force-archive");
    expect(h.output.join("\n")).toContain("create-skill");
    expect(h.dependencies.manage).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Team", args: ["--agent-id", "agent-1", "--task-id", "task-1"] },
    { label: "Agent", args: ["--team-id", "team-1", "--task-id", "task-1"] },
    { label: "Task", args: ["--team-id", "team-1", "--agent-id", "agent-1"] },
  ])("rejects a bind command without the required $label ID", async ({ label, args }) => {
    const h = harness();
    const code = await runCodexBindingCli([
      "bind",
      "--service-id", "memory-1",
      ...args,
    ], h.io, {
      MEMORY_CORE_ENDPOINT: "https://memory.example",
      MEMORY_CORE_SERVICE_TOKEN: "service-secret",
      MEMORY_HUB_USER_KEY: "user-key-secret",
    }, h.dependencies);

    expect(code).toBe(2);
    expect(h.errors.join("\n")).toContain(`--${label.toLowerCase()}-id is required`);
    expect(h.dependencies.bind).not.toHaveBeenCalled();
  });
});

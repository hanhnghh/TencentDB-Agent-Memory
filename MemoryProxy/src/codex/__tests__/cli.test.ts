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

  it("supports binding-status, doctor, and unbind without model interaction", async () => {
    const h = harness();

    expect(await runCodexBindingCli(["binding-status", "--project", "/project"], h.io, {}, h.dependencies)).toBe(0);
    expect(await runCodexBindingCli(["doctor", "--project", "/project"], h.io, {}, h.dependencies)).toBe(0);
    expect(await runCodexBindingCli(["unbind", "--project", "/project"], h.io, {}, h.dependencies)).toBe(0);

    expect(h.dependencies.status).toHaveBeenCalledTimes(1);
    expect(h.dependencies.doctor).toHaveBeenCalledTimes(1);
    expect(h.dependencies.unbind).toHaveBeenCalledTimes(1);
  });

  it("rejects a bind command without the parity-required Task ID", async () => {
    const h = harness();
    const code = await runCodexBindingCli([
      "bind",
      "--service-id", "memory-1",
      "--team-id", "team-1",
      "--agent-id", "agent-1",
    ], h.io, {
      MEMORY_CORE_ENDPOINT: "https://memory.example",
      MEMORY_CORE_SERVICE_TOKEN: "service-secret",
      MEMORY_HUB_USER_KEY: "user-key-secret",
    }, h.dependencies);

    expect(code).toBe(2);
    expect(h.errors.join("\n")).toContain("--task-id is required");
    expect(h.dependencies.bind).not.toHaveBeenCalled();
  });
});

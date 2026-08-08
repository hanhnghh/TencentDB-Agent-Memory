import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { createBoundRuntimeSessionKey } from "../../runtime/production-adapters.js";
import { SessionStore } from "../../session/store.js";
import type { ProxyConfig } from "../../types.js";
import { bindCodexProject } from "../binding.js";
import { createCodexHookAccessResolver } from "../hook-access.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex hook binding resolution", () => {
  it("revalidates the project scope and primes the shared runtime session", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-hook-access-"));
    roots.push(root);
    const projectDir = join(root, "project");
    const userConfigDir = join(root, "user-config");
    await mkdir(projectDir);
    const fetcher = memoryCoreFixture();
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
      preferences: { dynamicRecall: true, contextLimit: 3 },
      fetcher,
    });
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.coreSkill.endpoint = "https://memory.example";
    config.coreSkill.serviceToken = "service-secret";
    config.auth.url = "https://memory.example";
    const sessionStore = new SessionStore();
    const resolver = createCodexHookAccessResolver(config, {
      userConfigDir,
      fetcher,
      sessionStore,
    });

    const access = await resolver.resolve({ cwd: projectDir, sessionId: "session-codex" });

    expect(access).toEqual({
      identity: {
        serviceId: "memory-1",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        taskId: "task-1",
        agentSource: "codex",
        sessionId: "session-codex",
      },
      bindingCacheKey: createBoundRuntimeSessionKey(access.identity),
      userKey: "user-key-secret",
      preferences: { dynamicRecall: true, contextLimit: 3 },
    });
    const sessionKey = access.bindingCacheKey;
    expect(sessionStore.get(sessionKey)).toMatchObject({
      status: "initialized",
      bypassed: false,
      sessionInfo: {
        identity_verified: true,
        permissions: {
          user_in_team: true,
          user_in_task: true,
          agent_assigned_to_task: true,
        },
      },
      agentDetail: { id: "agent-1", name: "Agent One" },
      taskDetail: { id: "task-1", name: "Task One" },
    });
    expect(JSON.stringify(sessionStore.get(sessionKey)))
      .not.toContain("user-key-secret");
    expect(sessionKey).not.toBe(createBoundRuntimeSessionKey({
      ...access.identity,
      teamId: "team-2",
      agentId: "agent-2",
      taskId: "task-2",
    }));
  });

  it("reports an absent project binding without consulting transcript_path", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-hook-missing-binding-"));
    roots.push(root);
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const resolver = createCodexHookAccessResolver(structuredClone(DEFAULT_CONFIG), {
      userConfigDir: join(root, "user-config"),
      fetcher: memoryCoreFixture(),
    });

    await expect(resolver.resolve({ cwd: projectDir, sessionId: "session-codex" }))
      .rejects.toMatchObject({ reason: "missing_binding" });
  });

  it("classifies malformed authentication responses as dependency failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-hook-auth-outage-"));
    roots.push(root);
    const projectDir = join(root, "project");
    const userConfigDir = join(root, "user-config");
    await mkdir(projectDir);
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
      fetcher: memoryCoreFixture(),
    });
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.coreSkill.endpoint = "https://memory.example";
    config.auth.url = "https://memory.example";
    const resolver = createCodexHookAccessResolver(config, {
      userConfigDir,
      fetcher: async () => response({ code: 0, data: { valid: "unknown" } }),
      sessionStore: new SessionStore(),
    });

    await expect(resolver.resolve({ cwd: projectDir, sessionId: "session-codex" }))
      .rejects.toMatchObject({ reason: "binding_unavailable" });
  });
});

function memoryCoreFixture(): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/auth/verify")) {
      return response({ code: 0, data: { valid: true, user: { user_id: "user-1" } } });
    }
    if (path.endsWith("/team/list")) {
      return response({ code: 0, data: { items: [{ team_id: "team-1", name: "Team One" }], total: 1, limit: 100, offset: 0 } });
    }
    if (path.endsWith("/agent/list")) {
      return response({ code: 0, data: { items: [{ agent_id: "agent-1", team_id: "team-1", name: "Agent One", description: "Agent details" }], total: 1, limit: 100, offset: 0 } });
    }
    return response({ code: 0, data: { items: [{ task_id: "task-1", team_id: "team-1", title: "Task One", description: "Task details" }], total: 1, limit: 100, offset: 0 } });
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

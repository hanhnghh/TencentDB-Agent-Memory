import { verifyUserKeyWithConfig } from "../auth.js";
import { MetadataClient } from "../meta/client.js";
import type { BoundRuntimeIdentity } from "../runtime/index.js";
import { createBoundRuntimeSessionKey } from "../runtime/production-adapters.js";
import { getSessionStore, type SessionStore } from "../session/store.js";
import type { AgentDetail, SessionInfo, TaskDetail } from "../session/types.js";
import type { ProxyConfig } from "../types.js";
import {
  CodexBindingError,
  readCodexProjectBinding,
  resolveCodexRuntimeCredential,
} from "./binding.js";

export type CodexHookBindingFailure =
  | "missing_binding"
  | "missing_credential"
  | "invalid_binding"
  | "credential_rejected"
  | "binding_scope_denied"
  | "binding_unavailable";

export class CodexHookBindingError extends Error {
  constructor(readonly reason: CodexHookBindingFailure) {
    super(`Codex hook binding resolution failed: ${reason}`);
    this.name = "CodexHookBindingError";
  }
}

export interface CodexHookAccess {
  identity: BoundRuntimeIdentity & { agentSource: "codex" };
  bindingCacheKey: string;
  userKey: string;
  preferences: Record<string, string | number | boolean>;
}

export interface ResolveCodexHookAccessInput {
  cwd: string;
  sessionId: string;
}

export interface CodexHookAccessResolver {
  resolve(input: ResolveCodexHookAccessInput): Promise<CodexHookAccess>;
}

export interface CreateCodexHookAccessResolverOptions {
  userConfigDir?: string;
  fetcher?: typeof fetch;
  sessionStore?: SessionStore;
}

/** Revalidate local binding IDs, then prime the shared MemoryRuntime session. */
export function createCodexHookAccessResolver(
  config: ProxyConfig,
  options: CreateCodexHookAccessResolverOptions = {},
): CodexHookAccessResolver {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const store = options.sessionStore ?? getSessionStore();
  return {
    async resolve(input): Promise<CodexHookAccess> {
      const cwd = required(input.cwd, "cwd");
      const sessionId = required(input.sessionId, "sessionId");
      let credential;
      try {
        credential = await resolveCodexRuntimeCredential({
          projectDir: cwd,
          ...(options.userConfigDir ? { userConfigDir: options.userConfigDir } : {}),
        });
      } catch (error: unknown) {
        if (error instanceof CodexBindingError) {
          throw new CodexHookBindingError("invalid_binding");
        }
        throw new CodexHookBindingError("binding_unavailable");
      }
      if (!credential) {
        let bindingExists = false;
        try {
          bindingExists = await readCodexProjectBinding(cwd) !== null;
        } catch {
          throw new CodexHookBindingError("invalid_binding");
        }
        throw new CodexHookBindingError(
          bindingExists ? "missing_credential" : "missing_binding",
        );
      }

      const { binding, userKey } = credential;
      const verification = await verifyUserKeyWithConfig(
        {
          url: config.auth.url.trim() || config.coreSkill.endpoint,
          timeoutMs: config.auth.timeoutMs,
          serviceToken: config.coreSkill.serviceToken,
        },
        userKey,
        binding.service_id,
        fetcher,
      );
      if (verification.rejected || !verification.userId) {
        throw new CodexHookBindingError(
          verification.rejectReason === "invalid user_key"
            ? "credential_rejected"
            : "binding_unavailable",
        );
      }

      const metadata = new MetadataClient(
        config.coreSkill,
        binding.service_id,
        userKey,
        fetcher,
      );
      let teams;
      let agents;
      let tasks;
      try {
        [teams, agents, tasks] = await Promise.all([
          metadata.listTeams(verification.userId),
          metadata.listAgents(binding.team_id, verification.userId),
          metadata.listTasks(binding.team_id),
        ]);
      } catch {
        throw new CodexHookBindingError("binding_unavailable");
      }
      const teamAllowed = teams.some((team) => team.team_id === binding.team_id);
      const agent = agents.find((candidate) => (
        candidate.agent_id === binding.agent_id && candidate.team_id === binding.team_id
      ));
      const task = tasks.find((candidate) => (
        candidate.task_id === binding.task_id && candidate.team_id === binding.team_id
      ));
      if (!teamAllowed || !agent || !task) {
        throw new CodexHookBindingError("binding_scope_denied");
      }

      const identity: CodexHookAccess["identity"] = {
        serviceId: binding.service_id,
        teamId: binding.team_id,
        userId: verification.userId,
        agentId: binding.agent_id,
        taskId: binding.task_id,
        agentSource: "codex",
        sessionId,
      };
      const keyId = createBoundRuntimeSessionKey(identity);
      store.bind(keyId, {
        spaceId: identity.serviceId,
        userId: identity.userId,
        agentSource: identity.agentSource,
        sessionId: identity.sessionId,
      });
      await store.set(keyId, {
        status: "initialized",
        keyId,
        startedAt: Date.now(),
        attemptCount: 0,
        bypassed: false,
        userId: identity.userId,
        sessionInfo: sessionInfo(identity),
        agentDetail: agentDetail(agent),
        taskDetail: taskDetail(task),
      });
      return {
        identity,
        bindingCacheKey: keyId,
        userKey,
        preferences: { ...(binding.preferences ?? {}) },
      };
    },
  };
}

function sessionInfo(identity: CodexHookAccess["identity"]): SessionInfo {
  return {
    session_id: identity.sessionId,
    space_id: identity.serviceId,
    user_id: identity.userId,
    team_id: identity.teamId,
    agent_id: identity.agentId,
    task_id: identity.taskId,
    identity_verified: true,
    permissions: {
      user_in_team: true,
      user_in_task: true,
      agent_assigned_to_task: true,
      repo_in_team: true,
    },
  };
}

function agentDetail(agent: {
  agent_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
}): AgentDetail {
  return {
    id: agent.agent_id,
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.prompt ? { prompt: agent.prompt } : {}),
  };
}

function taskDetail(task: {
  task_id: string;
  title: string;
  description?: string | null;
}): TaskDetail {
  return {
    id: task.task_id,
    name: task.title,
    ...(task.description ? { description: task.description } : {}),
  };
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CodexHookBindingError(field === "cwd" ? "missing_binding" : "invalid_binding");
  }
  return value.trim();
}

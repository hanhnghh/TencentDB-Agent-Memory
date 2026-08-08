import type { Context } from "hono";

import type {
  BridgeSessionAccess,
  BridgeSessionAccessResolver,
} from "../bridge/session-access.js";
import { resolveHttpBridgeSession } from "../bridge/http-session-access.js";
import {
  forceArchiveSkill,
  type ForceArchiveInput,
  type ForceArchiveResult,
} from "../routes/session-force-archive.js";
import {
  refreshSessionCache,
  type RefreshInput,
  type RefreshResult,
} from "../routes/session-refresh.js";
import {
  MemoryRuntimeAuthorizationError,
  MemoryRuntimeBindingError,
  type PrepareContextResult,
} from "../runtime/index.js";
import type { MemoryRuntimeProvider } from "../runtime/production.js";
import type { ProxyConfig } from "../types.js";

type ManagementOperation = "refresh" | "force-archive";

export interface CodexManagementHandlerDeps {
  resolveSession: BridgeSessionAccessResolver;
  updateSession(access: BridgeSessionAccess): void;
  memoryRuntimeProvider?: MemoryRuntimeProvider;
  refresh?(input: RefreshInput): Promise<RefreshResult>;
  forceArchive?(input: ForceArchiveInput): Promise<ForceArchiveResult>;
}

export function createCodexManagementHandler(
  config: ProxyConfig,
  deps: CodexManagementHandlerDeps,
): (context: Context) => Promise<Response> {
  return async (context): Promise<Response> => {
    const operation = operationFromPath(new URL(context.req.url).pathname);
    if (!operation) return envelope(40401, "unknown management operation", 404);
    if (!(context.req.header("content-type") ?? "").toLowerCase().includes("application/json")) {
      return envelope(41501, "content-type must be application/json", 415);
    }
    const resolved = await resolveHttpBridgeSession(context, deps.resolveSession);
    if (!resolved.ok) {
      return envelope(resolved.code, resolved.message, resolved.httpStatus);
    }
    const { access } = resolved;
    if (operation === "force-archive" && access.capabilities.skill.enabled !== true) {
      return envelope(40301, "skill capability is disabled", 403);
    }

    const body = await managementBody(context, operation);
    if (body instanceof Response) return body;
    if (operation === "refresh") {
      const result = await (deps.refresh ?? refreshSessionCache)({
        sessionKey: access.identity.sessionId,
        sessionCacheKey: access.sessionCacheKey,
        agentSource: access.identity.agentSource,
        config,
        spaceId: access.identity.serviceId,
        callerUserKey: access.userKey,
        skipContextPrewarm: true,
      });
      if (!result.success) return envelope(50001, "session refresh failed", 500);
      const runtime = deps.memoryRuntimeProvider?.forRequest({
        userKey: access.userKey,
        bindingCacheKey: access.sessionCacheKey,
      });
      if (!runtime) return envelope(50302, "memory runtime unavailable", 503);
      let prepared: PrepareContextResult;
      try {
        prepared = await runtime.prepareContext({
          identity: access.identity,
          readOnly: false,
          refresh: true,
        });
      } catch (cause: unknown) {
        if (cause instanceof MemoryRuntimeAuthorizationError ||
            cause instanceof MemoryRuntimeBindingError) {
          return envelope(40302, "session refresh is not authorized", 403);
        }
        return envelope(50303, "session context refresh failed", 503);
      }
      deps.updateSession({
        ...access,
        identity: prepared.session.identity,
        capabilities: prepared.capabilities,
      });
      return success({
        refreshed: prepared.diagnostics.prewarmed,
        skipped: prepared.diagnostics.degraded,
        agent_refreshed: result.agentRefreshed,
        task_refreshed: result.taskRefreshed,
        took_ms: result.tookMs,
      });
    }

    const result = await (deps.forceArchive ?? forceArchiveSkill)({
      sessionKey: access.identity.sessionId,
      sessionCacheKey: access.sessionCacheKey,
      agentSource: access.identity.agentSource,
      config,
      spaceId: access.identity.serviceId,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    if (!result.success) return envelope(50001, "skill archive failed", 500);
    return success({
      status: result.status,
      task_id: result.taskId,
      archive_key: result.archiveKey,
      archived_at_ms: result.archivedAtMs,
    });
  };
}

async function managementBody(
  context: Context,
  operation: ManagementOperation,
): Promise<{ reason?: string } | Response> {
  let value: unknown;
  try {
    value = await context.req.json<unknown>();
  } catch {
    return envelope(40001, "invalid JSON body", 400);
  }
  if (!isRecord(value)) return envelope(40001, "body must be a JSON object", 400);
  const allowed = operation === "force-archive" ? new Set(["reason"]) : new Set<string>();
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return envelope(40001, "body contains unsupported fields", 400);
  }
  if ("reason" in value && (typeof value.reason !== "string" || !value.reason.trim())) {
    return envelope(40001, "reason must be a non-empty string", 400);
  }
  return typeof value.reason === "string" ? { reason: value.reason.trim() } : {};
}

function operationFromPath(path: string): ManagementOperation | null {
  if (path === "/codex/manage/refresh") return "refresh";
  if (path === "/codex/manage/force-archive") return "force-archive";
  return null;
}

function success(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    code: 0,
    message: "ok",
    request_id: `codex-management-${Date.now()}`,
    data,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function envelope(code: number, message: string, status: number): Response {
  return new Response(JSON.stringify({
    code,
    message,
    request_id: `codex-management-${Date.now()}`,
  }), { status, headers: { "content-type": "application/json" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

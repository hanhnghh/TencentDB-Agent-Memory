import type { SessionInfo } from "../session/types.js";
import {
  MemoryRuntimeAuthorizationError,
  MemoryRuntimeBindingError,
  MemoryRuntimeContextError,
  type PrepareContextResult,
} from "./index.js";

export type MemoryRuntimePrepareFailure =
  | { kind: "degraded"; error: MemoryRuntimeContextError }
  | {
    kind: "forbidden";
    error: MemoryRuntimeAuthorizationError | MemoryRuntimeBindingError;
  }
  | { kind: "unavailable"; error: unknown };

/** Keep runtime failure policy out of protocol-specific transport handlers. */
export function classifyMemoryRuntimePrepareError(
  error: unknown,
): MemoryRuntimePrepareFailure {
  if (error instanceof MemoryRuntimeContextError) {
    return { kind: "degraded", error };
  }
  if (error instanceof MemoryRuntimeAuthorizationError ||
      error instanceof MemoryRuntimeBindingError) {
    return { kind: "forbidden", error };
  }
  return { kind: "unavailable", error };
}

/** Expose verified runtime identity in the legacy transport metadata shape. */
export function sessionInfoFromRuntime(
  prepared: PrepareContextResult,
): SessionInfo & Record<string, unknown> {
  const identity = prepared.session.identity;
  return {
    session_id: identity.sessionId,
    space_id: identity.serviceId,
    user_id: identity.userId,
    team_id: identity.teamId,
    agent_id: identity.agentId,
    task_id: identity.taskId,
    identity_verified: true,
  };
}

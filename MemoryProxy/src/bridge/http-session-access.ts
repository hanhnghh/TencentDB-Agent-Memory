import type { Context } from "hono";

import type {
  BridgeSessionAccess,
  BridgeSessionAccessResolver,
} from "./session-access.js";

export type HttpBridgeSessionResult =
  | { ok: true; access: BridgeSessionAccess }
  | {
      ok: false;
      code: 40101 | 40301 | 50301;
      httpStatus: 401 | 403 | 503;
      message: string;
    };

/** Resolve loopback bridge identity once, without trusting caller identity fields. */
export async function resolveHttpBridgeSession(
  context: Context,
  resolver: BridgeSessionAccessResolver,
): Promise<HttpBridgeSessionResult> {
  const sessionId = firstHeader(context, [
    "x-conversation-id",
    "x-session-id",
    "x-chat-id",
    "x-thread-id",
    "x-claude-code-session-id",
  ]);
  if (!sessionId) {
    return { ok: false, code: 40101, httpStatus: 401, message: "session not initialized" };
  }
  let access: BridgeSessionAccess | null;
  try {
    access = await resolver({
      sessionId,
      agentSource: context.req.header("x-agent-source"),
    });
  } catch {
    return {
      ok: false,
      code: 50301,
      httpStatus: 503,
      message: "session authorization unavailable",
    };
  }
  if (!access) {
    return { ok: false, code: 40101, httpStatus: 401, message: "session not initialized" };
  }
  const serviceId = context.req.header("x-tdai-service-id")?.trim();
  if (serviceId && serviceId !== access.identity.serviceId) {
    return {
      ok: false,
      code: 40301,
      httpStatus: 403,
      message: "session does not belong to the requested service",
    };
  }
  return { ok: true, access };
}

function firstHeader(context: Context, names: string[]): string | null {
  for (const name of names) {
    const value = context.req.header(name)?.trim();
    if (value) return value;
  }
  return null;
}

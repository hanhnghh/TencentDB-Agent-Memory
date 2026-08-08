/**
 * Auth service client — verifies user_key and resolves user_id via auth/verify API.
 *
 * Features:
 * - Every call goes directly to the auth service (no caching)
 * - Returns structured result to allow caller to reject invalid keys
 * - x-tdai-service-id is derived from the request path's spaceId (not config)
 * - Configurable via YAML `auth` section
 */

import { log } from "./report/log.js";
import type { AuthConfig } from "./types.js";

export type { AuthConfig };

/** Result of verifyUserKey call. */
export interface VerifyUserResult {
  /** User ID if verified successfully; empty string otherwise. */
  userId: string;
  /** True when auth is enabled and verification did NOT return valid=true. */
  rejected: boolean;
  /** Error detail for logging/response when rejected. */
  rejectReason?: string;
}

export interface UserKeyVerifierConfig {
  url: string;
  timeoutMs: number;
  /** Optional MemoryCore gateway credential; omitted by the legacy proxy verifier. */
  serviceToken?: string;
}

interface UserKeyVerifierObserver {
  httpError?(status: number, serviceId: string): void;
  error?(reason: string, serviceId: string): void;
}

function redactVerifierSecrets(message: string, secrets: Array<string | undefined>): string {
  return secrets
    .filter((secret): secret is string => Boolean(secret))
    .sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join("[REDACTED]"), message);
}

// ── Module state ──────────────────────────────────────────────────────────────

let config: AuthConfig | null = null;

/**
 * Initialize the auth client.
 * Must be called once at startup. Idempotent.
 */
export function initAuth(cfg: AuthConfig): void {
  if (!cfg.enabled) {
    config = null;
    return;
  }
  if (!cfg.url) {
    log.warn("auth.init.skipped", { reason: "empty url" });
    config = null;
    return;
  }
  config = cfg;
  log.info("auth.init", { url: cfg.url });
}

/** Check if auth verification is enabled. */
export function isAuthEnabled(): boolean {
  return config != null;
}

/**
 * Verify a user_key (API key from the client request) and resolve to a user_id.
 *
 * When auth is enabled, the principle is:
 * **Any result that is NOT valid=true with a user_id → reject the request.**
 *
 * @param userKey - The client's API key (user_key)
 * @param serviceId - The service/instance ID from request path spaceId (used as x-tdai-service-id)
 *
 * Returns a structured result:
 * - `{ userId: "usr-xxx", rejected: false }` — verified successfully
 * - `{ userId: "", rejected: true, rejectReason }` — auth enabled but verification failed
 * - `{ userId: "", rejected: false }` — auth not enabled (passthrough)
 *
 * This function never throws.
 * Each call directly queries the auth service (no caching).
 */
export async function verifyUserKey(userKey: string, serviceId: string): Promise<VerifyUserResult> {
  if (!config) return { userId: "", rejected: false };
  return verifyUserKeyWithConfig(config, userKey, serviceId, globalThis.fetch.bind(globalThis), {
    httpError: (status, verifiedServiceId) => {
      log.warn("auth.verify.httpError", { status, serviceId: verifiedServiceId });
    },
    error: (reason, verifiedServiceId) => {
      log.warn("auth.verify.error", { error: reason, serviceId: verifiedServiceId });
    },
  });
}

/**
 * Verify a key with explicit configuration.
 *
 * Binding commands use this form because they are short-lived and must not
 * depend on the server process' module-global initialization.
 */
export async function verifyUserKeyWithConfig(
  verifier: UserKeyVerifierConfig,
  userKey: string,
  serviceId: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  observer?: UserKeyVerifierObserver,
): Promise<VerifyUserResult> {
  if (!serviceId) return { userId: "", rejected: true, rejectReason: "missing service_id (spaceId not in request path)" };
  if (!userKey) return { userId: "", rejected: true, rejectReason: "missing user_key" };

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-tdai-service-id": serviceId,
    };
    if (verifier.serviceToken) {
      headers.Authorization = `Bearer ${verifier.serviceToken}`;
    }
    const fetchOpts: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify({ user_key: userKey }),
    };
    if (verifier.timeoutMs > 0) {
      fetchOpts.signal = AbortSignal.timeout(verifier.timeoutMs);
    }

    const url = verifier.url.replace(/\/+$/, "") + "/v3/meta/auth/verify";
    const resp = await fetcher(url, fetchOpts);

    if (!resp.ok) {
      const reason = `auth service returned HTTP ${resp.status}`;
      observer?.httpError?.(resp.status, serviceId);
      return { userId: "", rejected: true, rejectReason: reason };
    }

    const body = await resp.json() as {
      code?: number;
      data?: { valid?: boolean; user?: { user_id?: unknown } };
    };

    // Only accept: code=0 AND valid=true AND user_id present
    const userId = body.data?.user?.user_id;
    if (
      body.code === 0 &&
      body.data?.valid === true &&
      typeof userId === "string" &&
      userId.trim()
    ) {
      return { userId, rejected: false };
    }

    // Everything else is a rejection
    const reason = body.data?.valid === false
      ? "invalid user_key"
      : `unexpected verify response (code=${body.code})`;
    return { userId: "", rejected: true, rejectReason: reason };
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const unsafeReason = isTimeout
      ? `auth service timeout (${verifier.timeoutMs}ms)`
      : `auth service error: ${err instanceof Error ? err.message : String(err)}`;
    const reason = redactVerifierSecrets(unsafeReason, [userKey, verifier.serviceToken]);
    observer?.error?.(reason, serviceId);
    return { userId: "", rejected: true, rejectReason: reason };
  }
}

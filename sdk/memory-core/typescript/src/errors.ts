/**
 * TencentDB Agent Memory SDK error types.
 */

export class ParamError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

export class TDAMError extends Error {
  readonly code: number;
  readonly requestId: string;
  readonly retryable: boolean;
  /**
   * Optional server-provided error details.
   *
   * Some endpoints put diagnostic fields into `data` even when `code !== 0`
   * (e.g. `/v3/skill/update` returns `{ current_version }` on 40901
   * SKILL_VERSION_STALE, `/v3/skill/files/read` returns `{ latest_version }`
   * on 41002 SKILL_VERSION_EXPIRED). This preserves them for callers doing
   * conflict recovery.
   */
  readonly details?: Record<string, unknown>;

  constructor(code: number, message: string, requestId = "", details?: Record<string, unknown>) {
    super(`[${code}] ${message} (request_id=${requestId})`);
    this.name = "TDAMError";
    this.code = code;
    this.requestId = requestId;
    this.details = details;
    const normalized = normalizeStatusCode(code);
    this.retryable = normalized === 408 || normalized === 429 || normalized >= 500;
  }
}

function normalizeStatusCode(code: number): number {
  const digits = String(Math.abs(Math.trunc(code)));
  return digits.length > 3 ? Number(digits.slice(0, 3)) : code;
}

export class TDAMTransportError extends TDAMError {
  readonly kind: "network" | "timeout";
  readonly retryable = true;

  constructor(kind: "network" | "timeout", message: string, options?: ErrorOptions) {
    super(kind === "timeout" ? 408 : -1, message);
    this.name = "TDAMTransportError";
    this.kind = kind;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class TDAMResponseError extends TDAMError {
  readonly kind = "malformed" as const;
  readonly retryable = true;

  constructor(message: string, requestId = "", options?: ErrorOptions) {
    super(-1, message, requestId);
    this.name = "TDAMResponseError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

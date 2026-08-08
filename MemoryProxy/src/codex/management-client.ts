import { readFile } from "node:fs/promises";

export type CodexManagementInput = {
  sessionId: string;
  sidecarUrl: string;
} & (
  | { operation: "refresh" }
  | { operation: "force-archive"; reason?: string }
  | { operation: "create-skill"; name: string; contentFile: string }
);

export interface CodexManagementResult {
  message: string;
  data?: Record<string, unknown>;
}

export type CodexManagementErrorKind =
  | "timeout"
  | "network"
  | "throttled"
  | "server"
  | "client"
  | "malformed";

export class CodexManagementError extends Error {
  constructor(
    readonly kind: CodexManagementErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CodexManagementError";
  }
}

export async function executeCodexManagement(
  input: CodexManagementInput,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<CodexManagementResult> {
  const base = loopbackSidecarUrl(input.sidecarUrl);
  const headers = {
    "content-type": "application/json",
    "x-agent-source": "codex",
    "x-conversation-id": required(input.sessionId, "session ID"),
  };
  let path: string;
  let body: Record<string, unknown>;
  if (input.operation === "refresh") {
    path = "/codex/manage/refresh";
    body = {};
  } else if (input.operation === "force-archive") {
    path = "/codex/manage/force-archive";
    body = input.reason?.trim() ? { reason: input.reason.trim() } : {};
  } else {
    path = "/skill-bridge/v3/skill/create";
    body = {
      name: required(input.name, "skill name"),
      content: await readFile(required(input.contentFile, "content file"), "utf8"),
    };
  }

  let response: Response;
  try {
    response = await fetcher(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause: unknown) {
    if (isTimeoutError(cause)) {
      throw new CodexManagementError("timeout", "Agent Memory sidecar timed out");
    }
    throw new CodexManagementError("network", "Agent Memory sidecar is unavailable");
  }
  if (!response.ok) throw classifyHttpFailure(response.status);
  const envelope = await readEnvelope(response);
  if (envelope.code !== 0) {
    throw classifyEnvelopeFailure(envelope.code);
  }
  return {
    message: operationSuccessMessage(input.operation),
    ...(isRecord(envelope.data) ? { data: envelope.data } : {}),
  };
}

function loopbackSidecarUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Sidecar URL must be a loopback HTTP URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.pathname !== "/") {
    throw new Error("Sidecar URL must be a loopback HTTP URL");
  }
  return url.toString().replace(/\/$/, "");
}

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (isRecord(value) && typeof value.code === "number") return value;
  } catch {
    // Classified below without exposing an upstream body.
  }
  throw new CodexManagementError("malformed", "Agent Memory sidecar returned malformed data");
}

function classifyHttpFailure(status: number): CodexManagementError {
  if (status === 408 || status === 504) {
    return new CodexManagementError("timeout", "Agent Memory sidecar timed out");
  }
  if (status === 429) {
    return new CodexManagementError("throttled", "Agent Memory sidecar is throttled");
  }
  if (status >= 500) {
    return new CodexManagementError("server", "Agent Memory sidecar failed");
  }
  return new CodexManagementError("client", "Agent Memory sidecar rejected the request");
}

function classifyEnvelopeFailure(code: unknown): CodexManagementError {
  const status = typeof code === "number" && Number.isInteger(code)
    ? (code >= 10_000 ? Math.floor(code / 100) : code)
    : 0;
  return status >= 400 && status <= 599
    ? classifyHttpFailure(status)
    : new CodexManagementError("malformed", "Agent Memory sidecar returned an invalid result");
}

function isTimeoutError(cause: unknown): boolean {
  return cause instanceof DOMException && ["AbortError", "TimeoutError"].includes(cause.name);
}

function operationSuccessMessage(operation: CodexManagementInput["operation"]): string {
  if (operation === "refresh") return "Agent Memory session context refreshed.";
  if (operation === "force-archive") return "Agent Memory skill archive requested.";
  return "Agent Memory skill created.";
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

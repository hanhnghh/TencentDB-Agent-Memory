import { createHash } from "node:crypto";

import type { CommitCompletedRoundInput, RuntimeRoundEvent } from "../runtime/index.js";
import type { CodexCompletedTurn, CodexTurnIdentity } from "./turn-store.js";

/** Remove non-user-visible context before a tool call enters the durable journal. */
export function normalizeCodexToolInput(value: unknown): unknown {
  const sanitized = sanitizeToolPayload(value);
  if (sanitized !== undefined) return sanitized;
  return typeof value === "string" ? "" : {};
}

/** Convert the documented Codex tool response into the shared completed-round shape. */
export function normalizeCodexToolResponse(value: unknown): { output: string; failed: boolean } {
  const original = typeof value === "string" ? value : canonicalJson(value);
  const sanitized = sanitizeToolPayload(value);
  const output = sanitized === undefined
    ? ""
    : typeof sanitized === "string" ? sanitized : canonicalJson(sanitized);
  return { output, failed: indicatesFailure(value, original) };
}

/** Convert the durable Codex journal into the transport-independent runtime contract. */
export function buildCodexCompletedRound(round: CodexCompletedTurn): CommitCompletedRoundInput {
  const calls: RuntimeRoundEvent[] = round.tools.map((tool) => ({
    type: "tool_call",
    toolCallId: tool.toolUseId,
    toolName: tool.toolName,
    input: normalizeCodexToolInput(tool.input),
  }));
  const results: RuntimeRoundEvent[] = round.tools.map((tool) => ({
    type: "tool_result",
    toolCallId: tool.toolUseId,
    content: tool.output,
    failed: tool.failed,
  }));
  return {
    sourceEventId: codexStopSourceEventId(round.identity),
    identity: round.identity,
    realPrompt: round.prompt,
    events: [...calls, ...results],
    finalResponse: round.finalResponse,
  };
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value));
  if (serialized === undefined) throw new TypeError("value must be JSON serializable");
  return serialized;
}

function codexStopSourceEventId(identity: CodexTurnIdentity): string {
  return `codex:stop:sha256:${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`;
}

function indicatesFailure(value: unknown, output: string): boolean {
  if (isRecord(value)) {
    if (value.is_error === true || value.isError === true || value.failed === true) return true;
    if (value.success === false) return true;
    const exitCode = value.exit_code ?? value.exitCode;
    if (typeof exitCode === "number" && exitCode !== 0) return true;
  }
  const exitMatch = output.match(/(?:process exited with code|exit(?:ed)?[_ ]code\s*[:=]?)\s*(-?\d+)/i);
  return exitMatch !== null && Number(exitMatch[1]) !== 0;
}

const EXCLUDED_BLOCK_TYPES = new Set([
  "image",
  "image_url",
  "input_image",
  "output_image",
  "thinking",
  "redacted_thinking",
]);

function sanitizeToolPayload(value: unknown): unknown {
  // A free-form string may be shell/apply-patch source that legitimately mentions
  // the delimiter. Only discard injected memory when its structured text-block
  // position establishes that semantic meaning.
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeToolPayload).filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return value;
  if (value.role === "system") return undefined;
  if (typeof value.type === "string" && EXCLUDED_BLOCK_TYPES.has(value.type)) return undefined;
  if (value.type === "text" && typeof value.text === "string" && isInjectedMemory(value.text)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, entry]) => {
      const sanitized = sanitizeToolPayload(entry);
      return sanitized === undefined ? [] : [[key, sanitized]];
    }));
}

function isInjectedMemory(value: string): boolean {
  const trimmed = value.trim();
  const xmlWrapper = /^<agent_memory_context\b(?=[^>]*\bcapture\s*=\s*["']exclude["'])[^>]*>[\s\S]*<\/agent_memory_context>$/i;
  const textWrapper = /^--- BEGIN AGENT MEMORY (?:SESSION|BLOCK)\b[^\n]*capture=exclude[^\n]*---[\s\S]*--- END AGENT MEMORY (?:SESSION|BLOCK)\b[^\n]*---$/i;
  return xmlWrapper.test(trimmed) || textWrapper.test(trimmed);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  throw new TypeError("value must be JSON serializable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

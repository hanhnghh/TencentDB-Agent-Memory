#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8097";
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const UNAVAILABLE_OUTPUT = {
  suppressOutput: true,
  systemMessage: "Agent Memory sidecar is unavailable; continuing without injected context.",
};

const ROUTES = {
  SessionStart: "/hooks/session-start",
  UserPromptSubmit: "/hooks/user-prompt-submit",
};

export async function runMemoryHook({
  input = process.stdin,
  output = process.stdout,
  diagnostics = process.stderr,
  env = process.env,
  fetcher = globalThis.fetch.bind(globalThis),
} = {}) {
  try {
    const raw = await readBounded(input, MAX_INPUT_BYTES);
    const event = parseEvent(raw);
    const route = ROUTES[event.hook_event_name];
    if (!route) throw new Error("unsupported hook event");
    const endpoint = sidecarEndpoint(env.TDAI_MEMORY_SIDECAR_URL, route);
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(timeoutMs(env.TDAI_MEMORY_HOOK_TIMEOUT_MS)),
    });
    if (!response.ok) throw new Error(`sidecar status ${response.status}`);
    const responseText = await readResponseBounded(response, MAX_RESPONSE_BYTES);
    const hookOutput = parseHookOutput(responseText, event.hook_event_name);
    output.write(`${JSON.stringify(hookOutput)}\n`);
  } catch (error) {
    diagnostics.write(`Agent Memory hook unavailable (${errorName(error)}).\n`);
    output.write(`${JSON.stringify(UNAVAILABLE_OUTPUT)}\n`);
  }
}

function parseEvent(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid hook input");
  }
  return value;
}

function parseHookOutput(raw, eventName) {
  const value = JSON.parse(raw);
  if (!isRecord(value) || value.suppressOutput !== true) {
    throw new Error("invalid sidecar output");
  }
  assertExactFields(value, ["suppressOutput", "hookSpecificOutput", "systemMessage"]);
  if (value.systemMessage !== undefined && typeof value.systemMessage !== "string") {
    throw new Error("invalid sidecar output");
  }
  const specific = value.hookSpecificOutput;
  if (
    !isRecord(specific) ||
    specific.hookEventName !== eventName
  ) {
    throw new Error("mismatched sidecar output");
  }
  assertExactFields(specific, ["hookEventName", "additionalContext"]);
  if (
    specific.additionalContext !== undefined &&
    (typeof specific.additionalContext !== "string" || specific.additionalContext.length === 0)
  ) {
    throw new Error("invalid sidecar context");
  }
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(value, allowed) {
  const allowedFields = new Set(allowed);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new Error("unsupported sidecar output field");
  }
}

function sidecarEndpoint(configured, route) {
  const url = new URL(configured?.trim() || DEFAULT_SIDECAR_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error("sidecar must use loopback HTTP");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}${route}`;
  url.search = "";
  url.hash = "";
  return url;
}

function timeoutMs(configured) {
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 50 || parsed > 30_000) {
    return DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

async function readBounded(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("hook input too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readResponseBounded(response, limit) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new Error("sidecar output too large");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > limit) throw new Error("sidecar output too large");
  return text;
}

function errorName(error) {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return error instanceof SyntaxError ? "invalid_json" : "connection_error";
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isMain) {
  await runMemoryHook();
}

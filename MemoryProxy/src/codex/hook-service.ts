import { log } from "../report/log.js";
import type { BridgeSessionAccessRegistry } from "../bridge/session-access.js";
import {
  MemoryRuntimeAuthorizationError,
  MemoryRuntimeBindingError,
  MemoryRuntimeContextError,
  type PrepareContextResult,
  type RuntimeContextBlock,
} from "../runtime/index.js";
import type { MemoryRuntimeProvider } from "../runtime/production.js";
import {
  CodexHookBindingError,
  type CodexHookAccess,
  type CodexHookAccessResolver,
} from "./hook-access.js";
import {
  CodexTurnConflictError,
  type RecordCodexStopResult,
  type CodexTurnIdentity,
  type CodexTurnStore,
} from "./turn-store.js";
import {
  buildCodexCompletedRound,
  normalizeCodexToolInput,
  normalizeCodexToolResponse,
} from "./round-normalizer.js";

type SessionStartSource = "startup" | "resume" | "clear" | "compact";
type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

interface SessionStartHookInput {
  cwd: string;
  hook_event_name: "SessionStart";
  model: string;
  permission_mode: PermissionMode;
  session_id: string;
  source: SessionStartSource;
  transcript_path: string | null;
}

interface UserPromptSubmitHookInput {
  cwd: string;
  hook_event_name: "UserPromptSubmit";
  model: string;
  permission_mode: PermissionMode;
  session_id: string;
  transcript_path: string | null;
  turn_id: string;
  prompt: string;
  agent_id?: string;
  agent_type?: string;
}

interface PostToolUseHookInput {
  cwd: string;
  hook_event_name: "PostToolUse";
  model: string;
  permission_mode: PermissionMode;
  session_id: string;
  transcript_path: string | null;
  turn_id: string;
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
  tool_response: unknown;
  agent_id?: string;
  agent_type?: string;
}

interface StopHookInput {
  cwd: string;
  hook_event_name: "Stop";
  last_assistant_message: string | null;
  model: string;
  permission_mode: PermissionMode;
  session_id: string;
  stop_hook_active: boolean;
  transcript_path: string | null;
  turn_id: string;
}

interface SessionEndHookInput {
  cwd: string;
  hook_event_name: "SessionEnd";
  session_id: string;
  transcript_path: string | null;
  turn_id: string;
}

interface HookSpecificOutput {
  hookEventName: "SessionStart" | "UserPromptSubmit";
  additionalContext?: string;
}

interface HookOutput {
  suppressOutput: true;
  hookSpecificOutput?: HookSpecificOutput;
  systemMessage?: string;
}

export interface CodexHookResponse {
  status: number;
  body: HookOutput | { error: string };
}

export interface CodexHookServiceOptions {
  memoryRuntimeProvider: MemoryRuntimeProvider;
  accessResolver: CodexHookAccessResolver;
  turnStore: CodexTurnStore;
  bridgeSessions?: BridgeSessionAccessRegistry;
}

// These are the same limits declared in plugins/tencentdb-agent-memory/hooks.json.
// Keep the sidecar output within the host budget so Codex never truncates a block.
export const CODEX_HOOK_CONTEXT_LIMITS = {
  SessionStart: 5_000,
  UserPromptSubmit: 2_500,
} as const;
const DEFAULT_CONTEXT_BLOCK_LIMIT = 25;
const MAX_CONTEXT_BLOCK_LIMIT = 50;
const PROMPT_RECALL_HOOK = "tdai-l1-recall-injector";
const SESSION_START_FIELDS = new Set([
  "cwd",
  "hook_event_name",
  "model",
  "permission_mode",
  "session_id",
  "source",
  "transcript_path",
]);
const USER_PROMPT_SUBMIT_FIELDS = new Set([
  "agent_id",
  "agent_type",
  "cwd",
  "hook_event_name",
  "model",
  "permission_mode",
  "prompt",
  "session_id",
  "transcript_path",
  "turn_id",
]);
const POST_TOOL_USE_FIELDS = new Set([
  "agent_id",
  "agent_type",
  "cwd",
  "hook_event_name",
  "model",
  "permission_mode",
  "session_id",
  "tool_input",
  "tool_name",
  "tool_response",
  "tool_use_id",
  "transcript_path",
  "turn_id",
]);
const STOP_FIELDS = new Set([
  "cwd",
  "hook_event_name",
  "last_assistant_message",
  "model",
  "permission_mode",
  "session_id",
  "stop_hook_active",
  "transcript_path",
  "turn_id",
]);
const SESSION_END_FIELDS = new Set([
  "cwd",
  "hook_event_name",
  "session_id",
  "transcript_path",
  "turn_id",
]);

/** Thin Codex transport adapter over the shared MemoryRuntime contract. */
export class CodexHookService {
  constructor(private readonly options: CodexHookServiceOptions) {}

  async sessionStart(raw: unknown): Promise<CodexHookResponse> {
    let input: SessionStartHookInput;
    try {
      input = parseSessionStart(raw);
    } catch {
      return error(400, "invalid_session_start");
    }
    let access: CodexHookAccess;
    try {
      access = await this.options.accessResolver.resolve({
        cwd: input.cwd,
        sessionId: input.session_id,
      });
    } catch (cause: unknown) {
      return bindingFailure(cause);
    }
    const runtime = this.options.memoryRuntimeProvider.forRequest({
      userKey: access.userKey,
      bindingCacheKey: access.bindingCacheKey,
    });
    try {
      const prepared = await runtime.prepareContext({ identity: access.identity, readOnly: false });
      this.options.bridgeSessions?.register({
        identity: prepared.session.identity,
        sessionCacheKey: access.bindingCacheKey,
        userKey: access.userKey,
        capabilities: prepared.capabilities,
      });
      const additionalContext = renderAdditionalContext(prepared, {
        includeSession: true,
        maxBlocks: contextBlockLimit(access),
        maxChars: CODEX_HOOK_CONTEXT_LIMITS.SessionStart,
      });
      log.info("codex_hook.session_start", {
        source: input.source,
        sessionId: input.session_id,
        blockCount: prepared.blocks.length,
        binding: prepared.diagnostics.binding,
      });
      return success("SessionStart", additionalContext);
    } catch (cause: unknown) {
      return runtimeFailure(cause, "SessionStart");
    }
  }

  async userPromptSubmit(raw: unknown): Promise<CodexHookResponse> {
    let input: UserPromptSubmitHookInput;
    try {
      input = parseUserPromptSubmit(raw);
    } catch {
      return error(400, "invalid_user_prompt_submit");
    }
    let access: CodexHookAccess;
    try {
      access = await this.options.accessResolver.resolve({
        cwd: input.cwd,
        sessionId: input.session_id,
      });
    } catch (cause: unknown) {
      return bindingFailure(cause);
    }
    try {
      await this.options.turnStore.beginTurn({
        identity: { ...access.identity, agentSource: "codex", turnId: input.turn_id },
        prompt: input.prompt,
      });
    } catch (cause: unknown) {
      log.error("codex_hook.prompt_persistence_failed", {
        sessionId: input.session_id,
        turnId: input.turn_id,
        errorType: cause instanceof Error ? cause.name : "unknown",
      });
      return error(cause instanceof CodexTurnConflictError ? 409 : 503, "prompt_persistence_failed");
    }

    if (access.preferences.dynamicRecall !== true) {
      log.info("codex_hook.prompt_persisted", {
        sessionId: input.session_id,
        turnId: input.turn_id,
        dynamicRecall: false,
      });
      return success("UserPromptSubmit");
    }
    const runtime = this.options.memoryRuntimeProvider.forRequest({
      userKey: access.userKey,
      bindingCacheKey: access.bindingCacheKey,
    });
    try {
      const prepared = await runtime.prepareContext({
        identity: access.identity,
        query: input.prompt,
        readOnly: false,
      });
      const promptPrepared: PrepareContextResult = {
        ...prepared,
        blocks: prepared.blocks.filter((block) => block.sourceHookId === PROMPT_RECALL_HOOK),
      };
      const additionalContext = renderAdditionalContext(promptPrepared, {
        includeSession: false,
        maxBlocks: contextBlockLimit(access),
        maxChars: CODEX_HOOK_CONTEXT_LIMITS.UserPromptSubmit,
      });
      log.info("codex_hook.prompt_persisted", {
        sessionId: input.session_id,
        turnId: input.turn_id,
        dynamicRecall: true,
        blockCount: promptPrepared.blocks.length,
      });
      return success("UserPromptSubmit", additionalContext);
    } catch (cause: unknown) {
      return runtimeFailure(cause, "UserPromptSubmit");
    }
  }

  async postToolUse(raw: unknown): Promise<CodexHookResponse> {
    let input: PostToolUseHookInput;
    try {
      input = parsePostToolUse(raw);
    } catch {
      return error(400, "invalid_post_tool_use");
    }
    // Thread-spawned subagents have their own turns and no root UserPromptSubmit.
    // They are outside the completed human-round contract.
    if (input.agent_id !== undefined || input.agent_type !== undefined) return acknowledged();
    let access: CodexHookAccess;
    try {
      access = await this.options.accessResolver.resolve({
        cwd: input.cwd,
        sessionId: input.session_id,
      });
    } catch (cause: unknown) {
      return bindingFailure(cause);
    }
    const result = normalizeCodexToolResponse(input.tool_response);
    try {
      await this.options.turnStore.appendToolEvent({
        identity: turnIdentity(access, input.turn_id),
        toolUseId: input.tool_use_id,
        toolName: input.tool_name,
        input: normalizeCodexToolInput(input.tool_input),
        output: result.output,
        failed: result.failed,
      });
      return acknowledged();
    } catch (cause: unknown) {
      return persistenceFailure(cause, "tool_persistence_failed");
    }
  }

  async stop(raw: unknown): Promise<CodexHookResponse> {
    let input: StopHookInput;
    try {
      input = parseStop(raw);
    } catch {
      return error(400, "invalid_stop");
    }
    let access: CodexHookAccess;
    try {
      access = await this.options.accessResolver.resolve({
        cwd: input.cwd,
        sessionId: input.session_id,
      });
    } catch (cause: unknown) {
      return bindingFailure(cause);
    }
    if (input.last_assistant_message === null) return acknowledged();
    const identity = turnIdentity(access, input.turn_id);
    let stopped: RecordCodexStopResult;
    try {
      stopped = await this.options.turnStore.recordStop({
        identity,
        finalResponse: input.last_assistant_message,
      });
    } catch (cause: unknown) {
      return persistenceFailure(cause, "stop_persistence_failed");
    }
    if (stopped.committed) return acknowledged();

    const runtime = this.options.memoryRuntimeProvider.forRequest({
      userKey: access.userKey,
      bindingCacheKey: access.bindingCacheKey,
    });
    try {
      const completedRound = buildCodexCompletedRound(stopped.round);
      await runtime.commitCompletedRound(completedRound);
      await this.options.turnStore.markCommitted(identity);
      log.info("codex_hook.round_committed", {
        sessionId: input.session_id,
        turnId: input.turn_id,
        sourceEventId: completedRound.sourceEventId,
        toolCount: stopped.round.tools.length,
      });
      return acknowledged();
    } catch (cause: unknown) {
      return commitFailure(cause);
    }
  }

  async sessionEnd(raw: unknown): Promise<CodexHookResponse> {
    let input: SessionEndHookInput;
    try {
      input = parseSessionEnd(raw);
    } catch {
      return error(400, "invalid_session_end");
    }
    log.info("codex_hook.session_end", {
      sessionId: input.session_id,
      turnId: input.turn_id,
    });
    this.options.bridgeSessions?.remove("codex", input.session_id);
    try {
      this.options.memoryRuntimeProvider.signalDrain?.();
    } catch (cause: unknown) {
      log.warn("codex_hook.session_end_signal_failed", {
        sessionId: input.session_id,
        errorType: cause instanceof Error ? cause.name : "unknown",
      });
    }
    return acknowledged();
  }
}

function success(
  eventName: HookSpecificOutput["hookEventName"],
  additionalContext?: string,
): CodexHookResponse {
  return {
    status: 200,
    body: {
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: eventName,
        ...(additionalContext ? { additionalContext } : {}),
      },
    },
  };
}

function acknowledged(): CodexHookResponse {
  return { status: 200, body: { suppressOutput: true } };
}

function error(status: number, code: string): CodexHookResponse {
  return { status, body: { error: code } };
}

function bindingFailure(cause: unknown): CodexHookResponse {
  if (!(cause instanceof CodexHookBindingError)) return error(503, "binding_unavailable");
  switch (cause.reason) {
  case "missing_binding":
    return error(412, "missing_binding");
  case "missing_credential":
    return error(401, "missing_credential");
  case "binding_unavailable":
    return error(503, "binding_unavailable");
  default:
    return error(403, "binding_denied");
  }
}

function persistenceFailure(cause: unknown, code: string): CodexHookResponse {
  return error(cause instanceof CodexTurnConflictError ? 409 : 503, code);
}

function commitFailure(cause: unknown): CodexHookResponse {
  if (cause instanceof MemoryRuntimeAuthorizationError || cause instanceof MemoryRuntimeBindingError) {
    return error(403, "memory_access_denied");
  }
  return error(503, "round_commit_failed");
}

function runtimeFailure(
  cause: unknown,
  eventName: HookSpecificOutput["hookEventName"],
): CodexHookResponse {
  if (cause instanceof MemoryRuntimeContextError) {
    return {
      status: 200,
      body: {
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: eventName },
        systemMessage: "Agent Memory context is temporarily unavailable.",
      },
    };
  }
  if (cause instanceof MemoryRuntimeAuthorizationError || cause instanceof MemoryRuntimeBindingError) {
    return error(403, "memory_access_denied");
  }
  return error(503, "memory_runtime_unavailable");
}

function parseSessionStart(value: unknown): SessionStartHookInput {
  const input = record(value);
  assertAllowedFields(input, SESSION_START_FIELDS);
  if (input.hook_event_name !== "SessionStart") throw new TypeError("invalid event");
  const source = input.source;
  if (source !== "startup" && source !== "resume" && source !== "clear" && source !== "compact") {
    throw new TypeError("invalid source");
  }
  return {
    cwd: text(input.cwd),
    hook_event_name: "SessionStart",
    model: text(input.model),
    permission_mode: permissionMode(input.permission_mode),
    session_id: text(input.session_id),
    source,
    transcript_path: nullableText(input.transcript_path),
  };
}

function parseUserPromptSubmit(value: unknown): UserPromptSubmitHookInput {
  const input = record(value);
  assertAllowedFields(input, USER_PROMPT_SUBMIT_FIELDS);
  if (input.hook_event_name !== "UserPromptSubmit") throw new TypeError("invalid event");
  return {
    cwd: text(input.cwd),
    hook_event_name: "UserPromptSubmit",
    model: text(input.model),
    permission_mode: permissionMode(input.permission_mode),
    session_id: text(input.session_id),
    transcript_path: nullableText(input.transcript_path),
    turn_id: text(input.turn_id),
    prompt: text(input.prompt),
    ...optionalAgentFields(input),
  };
}

function parsePostToolUse(value: unknown): PostToolUseHookInput {
  const input = record(value);
  assertAllowedFields(input, POST_TOOL_USE_FIELDS);
  if (input.hook_event_name !== "PostToolUse") throw new TypeError("invalid event");
  if (!("tool_input" in input) || !("tool_response" in input)) {
    throw new TypeError("tool input and response required");
  }
  return {
    cwd: text(input.cwd),
    hook_event_name: "PostToolUse",
    model: text(input.model),
    permission_mode: permissionMode(input.permission_mode),
    session_id: text(input.session_id),
    transcript_path: nullableText(input.transcript_path),
    turn_id: text(input.turn_id),
    tool_name: text(input.tool_name),
    tool_use_id: text(input.tool_use_id),
    tool_input: input.tool_input,
    tool_response: input.tool_response,
    ...optionalAgentFields(input),
  };
}

function parseStop(value: unknown): StopHookInput {
  const input = record(value);
  assertAllowedFields(input, STOP_FIELDS);
  if (input.hook_event_name !== "Stop") throw new TypeError("invalid event");
  if (typeof input.stop_hook_active !== "boolean") throw new TypeError("invalid active state");
  return {
    cwd: text(input.cwd),
    hook_event_name: "Stop",
    last_assistant_message: nullableText(input.last_assistant_message),
    model: text(input.model),
    permission_mode: permissionMode(input.permission_mode),
    session_id: text(input.session_id),
    stop_hook_active: input.stop_hook_active,
    transcript_path: nullableText(input.transcript_path),
    turn_id: text(input.turn_id),
  };
}

function parseSessionEnd(value: unknown): SessionEndHookInput {
  const input = record(value);
  assertAllowedFields(input, SESSION_END_FIELDS);
  if (input.hook_event_name !== "SessionEnd") throw new TypeError("invalid event");
  return {
    cwd: text(input.cwd),
    hook_event_name: "SessionEnd",
    session_id: text(input.session_id),
    transcript_path: nullableText(input.transcript_path),
    turn_id: text(input.turn_id),
  };
}

function turnIdentity(access: CodexHookAccess, turnId: string): CodexTurnIdentity {
  return { ...access.identity, agentSource: "codex", turnId };
}

function optionalAgentFields(input: Record<string, unknown>): {
  agent_id?: string;
  agent_type?: string;
} {
  const fields: { agent_id?: string; agent_type?: string } = {};
  if ("agent_id" in input) fields.agent_id = text(input.agent_id);
  if ("agent_type" in input) fields.agent_type = text(input.agent_type);
  return fields;
}

function renderAdditionalContext(
  prepared: PrepareContextResult,
  options: { includeSession: boolean; maxBlocks: number; maxChars: number },
): string | undefined {
  const units: string[] = [];
  if (options.includeSession) units.push(renderSession(prepared));
  const orderedBlocks = [...prepared.blocks]
    .filter((block) => block.type === "text" || block.type === "custom")
    .sort(compareBlocks)
    .slice(0, options.maxBlocks);
  units.push(...orderedBlocks.map(renderBlock));
  if (units.length === 0) return undefined;

  const opening = '<agent_memory_context injected="true" capture="exclude">\n';
  const closing = "\n</agent_memory_context>";
  const included: string[] = [];
  let omitted = prepared.blocks.length - orderedBlocks.length;
  for (const unit of units) {
    const separator = included.length === 0 ? "" : "\n\n";
    const reserve = closing.length + 80;
    const candidateLength = opening.length + included.join("\n\n").length + separator.length + unit.length + reserve;
    if (candidateLength <= options.maxChars) included.push(unit);
    else omitted++;
  }
  if (included.length === 0) return undefined;
  const omission = omitted > 0 ? `\n\n[${omitted} context block(s) omitted by deterministic limits]` : "";
  return `${opening}${included.join("\n\n")}${omission}${closing}`;
}

function renderSession(prepared: PrepareContextResult): string {
  const { identity, agent, task } = prepared.session;
  const fields = [
    "--- BEGIN AGENT MEMORY SESSION (capture=exclude) ---",
    `Service: ${identity.serviceId}`,
    `Team: ${identity.teamId}`,
    `Agent: ${agent.name} (${identity.agentId})`,
    ...(agent.description ? [`Agent description: ${agent.description}`] : []),
    ...(agent.prompt ? [`Agent guidance: ${agent.prompt}`] : []),
    `Task: ${task.name} (${identity.taskId})`,
    ...(task.description ? [`Task description: ${task.description}`] : []),
    ...(task.goal ? [`Task goal: ${task.goal}`] : []),
    "--- END AGENT MEMORY SESSION ---",
  ];
  return redact(fields.join("\n"));
}

function renderBlock(block: RuntimeContextBlock): string {
  const id = block.id.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return [
    `--- BEGIN AGENT MEMORY BLOCK id=${id} kind=${block.kind} capture=exclude ---`,
    redact(block.content),
    `--- END AGENT MEMORY BLOCK id=${id} ---`,
  ].join("\n");
}

function redact(value: string): string {
  return value
    .replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+={0,2}/gi, "$1[REDACTED]")
    .replace(
      /((?:["'`])?(?:x[_-]?)?api[_-]?key(?:["'`])?|(?:["'`])?(?:user[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)(?:["'`])?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /\bsk-(?:mem-)?[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    );
}

function compareBlocks(left: RuntimeContextBlock, right: RuntimeContextBlock): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function contextBlockLimit(access: CodexHookAccess): number {
  const value = access.preferences.contextLimit;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return DEFAULT_CONTEXT_BLOCK_LIMIT;
  }
  return Math.max(1, Math.min(MAX_CONTEXT_BLOCK_LIMIT, value));
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("hook input must be an object");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new TypeError("unsupported hook input field");
  }
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("text required");
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function permissionMode(value: unknown): PermissionMode {
  if (
    value !== "default" && value !== "acceptEdits" && value !== "plan" &&
    value !== "dontAsk" && value !== "bypassPermissions"
  ) {
    throw new TypeError("invalid permission mode");
  }
  return value;
}

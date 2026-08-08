import type { ContextBlock } from "../injection/types.js";
import type { OutboxRecord } from "../outbox/index.js";
import type { AgentDetail, TaskDetail } from "../session/types.js";
import type { SessionInfo } from "../session/types.js";

export interface RuntimeIdentity {
  serviceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
}

export interface BoundRuntimeIdentity extends RuntimeIdentity {
  teamId: string;
  agentId: string;
  taskId: string;
}

export type BindingResolution = "cached" | "recovered";

export interface ResolvedRuntimeBinding {
  identity: BoundRuntimeIdentity;
  agent: AgentDetail;
  task: TaskDetail;
  sessionInfo?: SessionInfo;
  resolution: BindingResolution;
}

export interface RuntimeCapabilityFlags {
  skill: boolean;
  llmWiki: boolean;
  codeGraph: boolean;
  chatMemory: boolean;
}

export interface RuntimeCapabilityDecisions {
  memory: { enabled: boolean };
  skill: { enabled: boolean };
  knowledge: {
    wiki: { enabled: boolean };
    codeGraph: { enabled: boolean };
  };
}

export type RuntimeContextKind = "memory" | "skill" | "knowledge";

export interface RuntimeContextBlock extends ContextBlock {
  id: string;
  kind: RuntimeContextKind;
  order: number;
}

export interface RuntimeContextDiagnostics {
  prewarmed: string[];
  cacheHits: string[];
  degraded: string[];
}

export interface PrepareContextInput {
  identity: RuntimeIdentity;
}

export interface PrepareContextResult {
  session: {
    identity: BoundRuntimeIdentity;
    agent: AgentDetail;
    task: TaskDetail;
  };
  blocks: RuntimeContextBlock[];
  capabilities: RuntimeCapabilityDecisions;
  diagnostics: RuntimeContextDiagnostics & { binding: BindingResolution };
}

export interface RuntimeAuthorizationRequest {
  identity: BoundRuntimeIdentity;
  action: "read" | "write";
}

export type RuntimeAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface RuntimeContextRequest {
  binding: ResolvedRuntimeBinding;
  capabilities: RuntimeCapabilityFlags;
}

export interface RuntimeContextPreparation {
  blocks: RuntimeContextBlock[];
  diagnostics: RuntimeContextDiagnostics;
}

export interface MemoryRuntimeAdapters {
  resolveBinding(identity: RuntimeIdentity): Promise<ResolvedRuntimeBinding>;
  authorize(request: RuntimeAuthorizationRequest): Promise<RuntimeAuthorizationDecision>;
  resolveCapabilities(identity: BoundRuntimeIdentity): Promise<RuntimeCapabilityFlags>;
  prepareContext(request: RuntimeContextRequest): Promise<RuntimeContextPreparation>;
  decideExtraction(identity: BoundRuntimeIdentity, capabilities: RuntimeCapabilityFlags): RuntimeExtractionDecision;
  enqueue(round: RuntimeOutboxRound): Promise<OutboxRecord>;
}

export interface RuntimeExtractionDecision {
  l0: boolean;
  skill: boolean;
  reason?: string;
}

export interface RuntimeOutboxRound {
  sourceEventId: string;
  identity: BoundRuntimeIdentity & { turnId: string };
  l0: { messages: Array<{ role: "user" | "assistant"; content: string }> };
  skill: { messages: RuntimeRoundMessage[] };
  channels: { l0: boolean; skill: boolean };
}

export type RuntimeRoundMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "tool_call"; content: string; tool_call_id: string; tool_name: string }
  | { role: "tool_result"; content: string; tool_call_id: string };

export type RuntimeRoundEvent =
  | { type: "assistant"; content: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; failed: boolean };

export interface CommitCompletedRoundInput {
  sourceEventId: string;
  identity: RuntimeIdentity & { turnId: string };
  realPrompt: string;
  events: RuntimeRoundEvent[];
  finalResponse: string;
}

export type CommitCompletedRoundResult =
  | { status: "enqueued"; record: OutboxRecord }
  | { status: "skipped"; sourceEventId: string; reason: string };

export interface MemoryRuntimeContract {
  prepareContext(input: PrepareContextInput): Promise<PrepareContextResult>;
  commitCompletedRound(input: CommitCompletedRoundInput): Promise<CommitCompletedRoundResult>;
}

export class MemoryRuntimeAuthorizationError extends Error {
  constructor(readonly action: "read" | "write", readonly reason: string) {
    super(`Memory runtime ${action} authorization denied: ${reason}`);
    this.name = "MemoryRuntimeAuthorizationError";
  }
}

export class MemoryRuntimeBindingError extends Error {
  constructor(readonly reason: string) {
    super(`Memory runtime binding is invalid: ${reason}`);
    this.name = "MemoryRuntimeBindingError";
  }
}

export class MemoryRuntime implements MemoryRuntimeContract {
  constructor(private readonly adapters: MemoryRuntimeAdapters) {}

  async prepareContext(input: PrepareContextInput): Promise<PrepareContextResult> {
    const identity = validateRuntimeIdentity(input.identity);
    const binding = await this.adapters.resolveBinding(identity);
    validateResolvedBinding(identity, binding);
    await this.authorize(binding.identity, "read");
    const capabilities = await this.adapters.resolveCapabilities(binding.identity);
    const context = await this.adapters.prepareContext({ binding, capabilities });

    return {
      session: {
        identity: binding.identity,
        agent: binding.agent,
        task: binding.task,
      },
      blocks: [...context.blocks].sort(compareContextBlocks),
      capabilities: capabilityDecisions(capabilities),
      diagnostics: {
        binding: binding.resolution,
        prewarmed: [...context.diagnostics.prewarmed],
        cacheHits: [...context.diagnostics.cacheHits],
        degraded: [...context.diagnostics.degraded],
      },
    };
  }

  async commitCompletedRound(input: CommitCompletedRoundInput): Promise<CommitCompletedRoundResult> {
    const identity = validateRuntimeIdentity(input.identity);
    requireText(input.sourceEventId, "sourceEventId");
    requireText(input.identity.turnId, "turnId");
    requireText(input.realPrompt, "realPrompt");
    requireText(input.finalResponse, "finalResponse");

    const binding = await this.adapters.resolveBinding(identity);
    validateResolvedBinding(identity, binding);
    await this.authorize(binding.identity, "write");
    const capabilities = await this.adapters.resolveCapabilities(binding.identity);
    const extraction = this.adapters.decideExtraction(binding.identity, capabilities);
    const channels = {
      l0: extraction.l0 && capabilities.chatMemory,
      skill: extraction.skill && capabilities.skill,
    };
    if (!channels.l0 && !channels.skill) {
      return {
        status: "skipped",
        sourceEventId: input.sourceEventId,
        reason: extraction.reason ?? "extraction_disabled",
      };
    }

    const round: RuntimeOutboxRound = {
      sourceEventId: input.sourceEventId,
      identity: { ...binding.identity, turnId: input.identity.turnId },
      l0: {
        messages: [
          { role: "user", content: input.realPrompt },
          { role: "assistant", content: input.finalResponse },
        ],
      },
      skill: {
        messages: [
          { role: "user", content: input.realPrompt },
          ...normalizeRoundEvents(input.events),
          { role: "assistant", content: input.finalResponse },
        ],
      },
      channels,
    };
    const record = await this.adapters.enqueue(round);
    return { status: "enqueued", record };
  }

  private async authorize(identity: BoundRuntimeIdentity, action: "read" | "write"): Promise<void> {
    const decision = await this.adapters.authorize({ identity, action });
    if (!decision.allowed) {
      throw new MemoryRuntimeAuthorizationError(action, decision.reason ?? "denied");
    }
  }
}

export interface InMemoryMemoryRuntimeOptions {
  binding: ResolvedRuntimeBinding;
  capabilities?: RuntimeCapabilityFlags;
  context?: RuntimeContextPreparation;
  authorization?: Partial<Record<"read" | "write", RuntimeAuthorizationDecision>>;
  extraction?: RuntimeExtractionDecision;
}

export class InMemoryMemoryRuntimeAdapters implements MemoryRuntimeAdapters {
  readonly authorizationChecks: RuntimeAuthorizationRequest[] = [];
  readonly enqueuedRounds: RuntimeOutboxRound[] = [];

  constructor(private readonly options: InMemoryMemoryRuntimeOptions) {}

  async resolveBinding(_identity: RuntimeIdentity): Promise<ResolvedRuntimeBinding> {
    return structuredClone(this.options.binding);
  }

  async authorize(request: RuntimeAuthorizationRequest): Promise<RuntimeAuthorizationDecision> {
    this.authorizationChecks.push(structuredClone(request));
    return this.options.authorization?.[request.action] ?? { allowed: true };
  }

  async resolveCapabilities(_identity: BoundRuntimeIdentity): Promise<RuntimeCapabilityFlags> {
    return structuredClone(this.options.capabilities ?? {
      skill: true,
      llmWiki: true,
      codeGraph: true,
      chatMemory: true,
    });
  }

  async prepareContext(_request: RuntimeContextRequest): Promise<RuntimeContextPreparation> {
    return structuredClone(this.options.context ?? {
      blocks: [],
      diagnostics: { prewarmed: [], cacheHits: [], degraded: [] },
    });
  }

  decideExtraction(_identity: BoundRuntimeIdentity, _capabilities: RuntimeCapabilityFlags): RuntimeExtractionDecision {
    return structuredClone(this.options.extraction ?? { l0: true, skill: true });
  }

  async enqueue(round: RuntimeOutboxRound): Promise<OutboxRecord> {
    this.enqueuedRounds.push(structuredClone(round));
    return {
      sourceEventId: round.sourceEventId,
      contentHash: "in-memory",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };
  }
}

function validateRuntimeIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  return {
    serviceId: requireIdentityField(identity.serviceId, "serviceId"),
    userId: requireIdentityField(identity.userId, "userId"),
    agentSource: requireIdentityField(identity.agentSource, "agentSource"),
    sessionId: requireIdentityField(identity.sessionId, "sessionId"),
  };
}

function validateResolvedBinding(
  requested: RuntimeIdentity,
  binding: ResolvedRuntimeBinding,
): void {
  const resolved = binding.identity;
  for (const key of ["serviceId", "userId", "agentSource", "sessionId"] as const) {
    if (resolved[key] !== requested[key]) {
      throw new MemoryRuntimeBindingError(`${key}_mismatch`);
    }
  }
  if (!resolved.teamId.trim() || !resolved.agentId.trim() || !resolved.taskId.trim()) {
    throw new MemoryRuntimeBindingError("team_agent_task_required");
  }
  if (binding.agent.id !== resolved.agentId) {
    throw new MemoryRuntimeBindingError("agent_detail_mismatch");
  }
  if (binding.task.id !== resolved.taskId) {
    throw new MemoryRuntimeBindingError("task_detail_mismatch");
  }
}

function compareContextBlocks(left: RuntimeContextBlock, right: RuntimeContextBlock): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function capabilityDecisions(flags: RuntimeCapabilityFlags): RuntimeCapabilityDecisions {
  return {
    memory: { enabled: flags.chatMemory },
    skill: { enabled: flags.skill },
    knowledge: {
      wiki: { enabled: flags.llmWiki },
      codeGraph: { enabled: flags.codeGraph },
    },
  };
}

function normalizeRoundEvents(events: RuntimeRoundEvent[]): RuntimeRoundMessage[] {
  if (!Array.isArray(events)) {
    throw new TypeError("Completed-round events must be an array");
  }
  const toolCalls = new Set<string>();
  const toolResults = new Set<string>();
  const messages: RuntimeRoundMessage[] = [];

  for (const rawEvent of events) {
    const event: unknown = rawEvent;
    if (!isUnknownRecord(event) || typeof event.type !== "string") {
      throw new TypeError("Completed-round event has an invalid shape");
    }
    switch (event.type) {
    case "assistant":
      messages.push({
        role: "assistant",
        content: requireRuntimeText(event.content, "assistant event content"),
      });
      break;
    case "tool_call":
      {
        const toolCallId = requireRuntimeText(event.toolCallId, "toolCallId");
        if (toolCalls.has(toolCallId)) {
          throw new TypeError(`Completed round contains duplicate tool call ${toolCallId}`);
        }
        toolCalls.add(toolCallId);
        messages.push({
        role: "tool_call",
        content: serializeToolInput(event.input),
          tool_call_id: toolCallId,
          tool_name: requireRuntimeText(event.toolName, "toolName"),
        });
      }
      break;
    case "tool_result":
      {
        const toolCallId = requireRuntimeText(event.toolCallId, "toolCallId");
        if (!toolCalls.has(toolCallId)) {
          throw new TypeError(`Tool result ${toolCallId} has no matching tool call`);
        }
        if (toolResults.has(toolCallId)) {
          throw new TypeError(`Completed round contains duplicate tool result ${toolCallId}`);
        }
        if (typeof event.content !== "string" || typeof event.failed !== "boolean") {
          throw new TypeError("Tool result content and failure outcome are required");
        }
        toolResults.add(toolCallId);
        messages.push({
          role: "tool_result",
          content: event.content,
          tool_call_id: toolCallId,
        });
      }
      break;
    default:
      throw new TypeError(`Unsupported completed-round event type: ${event.type}`);
    }
  }
  for (const toolCallId of toolCalls) {
    if (!toolResults.has(toolCallId)) {
      throw new TypeError(`Tool call ${toolCallId} has no matching tool result`);
    }
  }
  return messages;
}

function serializeToolInput(input: unknown): string {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch (error) {
    throw new TypeError("Tool input is not serializable", { cause: error });
  }
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
}

function requireIdentityField(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryRuntimeBindingError(`${field}_required`);
  }
  return value;
}

function requireRuntimeText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export {
  AssetCapabilityHttpAdapter,
  ConfigExtractionAdapter,
  createRuntimeSessionKey,
  DurableRoundOutboxAdapter,
  HookCacheContextAdapter,
  MemoryCoreAuthorizationAdapter,
  ProductionMemoryRuntimeAdapters,
  SessionStoreBindingAdapter,
} from "./production-adapters.js";
export type {
  AssetCapabilityHttpAdapterOptions,
  HookCacheContextAdapterOptions,
  ProductionMemoryRuntimePorts,
  RuntimeAuthorizationAdapter,
  RuntimeBindingAdapter,
  RuntimeCapabilityAdapter,
  RuntimeContextAdapter,
  RuntimeExtractionAdapter,
  RuntimeOutboxAdapter,
} from "./production-adapters.js";

import { createHash } from "node:crypto";

import type { HookCacheRepo } from "../db/hookCacheRepo.js";
import type { ContextBlock, PrewarmInput } from "../injection/types.js";
import type { PrewarmOptions, PrewarmResult } from "../injection/prewarm.js";
import type { MetadataClient } from "../meta/client.js";
import type { CompletedRound, DurableRoundOutbox, OutboxRecord } from "../outbox/index.js";
import type { SessionStore } from "../session/store.js";
import type { SessionInfo } from "../session/types.js";
import { fetchAssetCapabilities } from "../tdai/capabilities.js";
import type { AclCheckResult, TdaiClient } from "../tdai/client.js";
import type { ProxyConfig } from "../types.js";
import { isExtractionAllowed } from "../extraction-gate.js";
import {
  MemoryRuntimeBindingError,
  type BoundRuntimeIdentity,
  type MemoryRuntimeAdapters,
  type ResolvedRuntimeBinding,
  type RuntimeAuthorizationDecision,
  type RuntimeAuthorizationRequest,
  type RuntimeCapabilityFlags,
  type RuntimeContextBlock,
  type RuntimeContextKind,
  type RuntimeContextPreparation,
  type RuntimeContextRequest,
  type RuntimeExtractionDecision,
  type RuntimeIdentity,
  type RuntimeOutboxRound,
} from "./index.js";

export interface RuntimeBindingAdapter {
  resolveBinding(identity: RuntimeIdentity): Promise<ResolvedRuntimeBinding>;
}

export interface RuntimeAuthorizationAdapter {
  authorize(request: RuntimeAuthorizationRequest): Promise<RuntimeAuthorizationDecision>;
}

export interface RuntimeCapabilityAdapter {
  resolveCapabilities(identity: BoundRuntimeIdentity): Promise<RuntimeCapabilityFlags>;
}

export interface RuntimeContextAdapter {
  prepareContext(request: RuntimeContextRequest): Promise<RuntimeContextPreparation>;
}

export interface RuntimeExtractionAdapter {
  decideExtraction(
    identity: BoundRuntimeIdentity,
    capabilities: RuntimeCapabilityFlags,
  ): RuntimeExtractionDecision;
}

export interface RuntimeOutboxAdapter {
  enqueue(round: RuntimeOutboxRound): Promise<OutboxRecord>;
}

export interface ProductionMemoryRuntimePorts {
  binding: RuntimeBindingAdapter;
  authorization: RuntimeAuthorizationAdapter;
  capabilities: RuntimeCapabilityAdapter;
  context: RuntimeContextAdapter;
  extraction: RuntimeExtractionAdapter;
  outbox: RuntimeOutboxAdapter;
}

/** Production composition boundary. Transport adapters delegate through the same runtime contract as tests. */
export class ProductionMemoryRuntimeAdapters implements MemoryRuntimeAdapters {
  constructor(private readonly ports: ProductionMemoryRuntimePorts) {}

  resolveBinding(identity: RuntimeIdentity): Promise<ResolvedRuntimeBinding> {
    return this.ports.binding.resolveBinding(identity);
  }

  authorize(request: RuntimeAuthorizationRequest): Promise<RuntimeAuthorizationDecision> {
    return this.ports.authorization.authorize(request);
  }

  resolveCapabilities(identity: BoundRuntimeIdentity): Promise<RuntimeCapabilityFlags> {
    return this.ports.capabilities.resolveCapabilities(identity);
  }

  prepareContext(request: RuntimeContextRequest): Promise<RuntimeContextPreparation> {
    return this.ports.context.prepareContext(request);
  }

  decideExtraction(
    identity: BoundRuntimeIdentity,
    capabilities: RuntimeCapabilityFlags,
  ): RuntimeExtractionDecision {
    return this.ports.extraction.decideExtraction(identity, capabilities);
  }

  enqueue(round: RuntimeOutboxRound): Promise<OutboxRecord> {
    return this.ports.outbox.enqueue(round);
  }
}

export class SessionStoreBindingAdapter implements RuntimeBindingAdapter {
  constructor(
    private readonly store: SessionStore,
    private readonly metadataClientFor?: (identity: RuntimeIdentity) => MetadataClient | undefined,
  ) {}

  async resolveBinding(identity: RuntimeIdentity): Promise<ResolvedRuntimeBinding> {
    const keyId = createRuntimeSessionKey(identity);
    const cached = this.store.get(keyId)?.status === "initialized";
    const state = await this.store.getOrRecover(
      keyId,
      {
        spaceId: identity.serviceId,
        userId: identity.userId,
        agentSource: identity.agentSource,
        sessionId: identity.sessionId,
      },
      { metadataClient: this.metadataClientFor?.(identity) },
    );
    if (
      state?.status !== "initialized" ||
      state.bypassed ||
      !state.sessionInfo ||
      !state.agentDetail ||
      !state.taskDetail
    ) {
      throw new MemoryRuntimeBindingError("binding_not_initialized");
    }
    const session = state.sessionInfo;
    validateSessionBinding(session);
    const teamId = requiredSessionField(session.team_id, "team_id");
    const agentId = requiredSessionField(session.agent_id, "agent_id");
    const taskId = requiredSessionField(session.task_id, "task_id");
    const resolved: BoundRuntimeIdentity = {
      serviceId: session.space_id ?? identity.serviceId,
      teamId,
      userId: requiredSessionField(session.user_id, "user_id"),
      agentId,
      taskId,
      agentSource: identity.agentSource,
      sessionId: requiredSessionField(session.session_id, "session_id"),
    };
    return {
      identity: resolved,
      agent: state.agentDetail,
      task: state.taskDetail,
      sessionInfo: session,
      resolution: cached ? "cached" : "recovered",
    };
  }
}

type AclClient = Pick<TdaiClient, "checkAcl">;

export class MemoryCoreAuthorizationAdapter implements RuntimeAuthorizationAdapter {
  constructor(
    private readonly clientFor: (identity: BoundRuntimeIdentity) => AclClient,
    private readonly userKeyFor: (identity: BoundRuntimeIdentity) => string | undefined,
  ) {}

  async authorize(request: RuntimeAuthorizationRequest): Promise<RuntimeAuthorizationDecision> {
    const userKey = this.userKeyFor(request.identity)?.trim();
    if (!userKey) return { allowed: false, reason: "missing_user_key" };
    let result: AclCheckResult;
    try {
      result = await this.clientFor(request.identity).checkAcl({
        user_key: userKey,
        asset_id: `chat_memory-${request.identity.teamId}-${request.identity.agentId}`,
        action: request.action,
        agent_id: request.identity.agentId,
      });
    } catch {
      return { allowed: false, reason: "acl_check_error" };
    }
    return result.allowed
      ? { allowed: true }
      : { allowed: false, reason: result.reason ?? "denied" };
  }
}

export interface AssetCapabilityHttpAdapterOptions {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  timeoutMs?: number;
  userKeyFor: (identity: BoundRuntimeIdentity) => string | undefined;
  fetcher?: typeof fetch;
}

export class AssetCapabilityHttpAdapter implements RuntimeCapabilityAdapter {
  constructor(private readonly options: AssetCapabilityHttpAdapterOptions) {}

  async resolveCapabilities(identity: BoundRuntimeIdentity): Promise<RuntimeCapabilityFlags> {
    const flags = await fetchAssetCapabilities({
      endpoint: this.options.endpoint,
      apiKey: this.options.apiKey,
      serviceId: this.options.serviceId,
      serviceIdOverride: identity.serviceId,
      userId: identity.userId,
      userKey: this.options.userKeyFor(identity),
      timeoutMs: this.options.timeoutMs,
      fetcher: this.options.fetcher,
    });
    return {
      skill: flags.skill,
      llmWiki: flags.llm_wiki,
      codeGraph: flags.code_graph,
      chatMemory: flags.chat_memory,
    };
  }
}

export interface HookCacheContextAdapterOptions {
  cacheRepo: HookCacheRepo;
  prewarm(input: PrewarmInput, options?: PrewarmOptions): Promise<PrewarmResult>;
  callerUserKeyFor?: (identity: BoundRuntimeIdentity) => string | undefined;
  classifyHook?: (hookId: string) => RuntimeContextKind | null;
}

export class HookCacheContextAdapter implements RuntimeContextAdapter {
  constructor(private readonly options: HookCacheContextAdapterOptions) {}

  async prepareContext(request: RuntimeContextRequest): Promise<RuntimeContextPreparation> {
    const { binding, capabilities } = request;
    const sessionInfo = binding.sessionInfo ?? sessionInfoFrom(binding.identity);
    const scopedCacheKey = createRuntimeContextCacheKey(binding.identity, capabilities);
    let entries = await this.options.cacheRepo.getAllForSession(
      binding.identity.serviceId,
      binding.identity.userId,
      binding.identity.agentSource,
      scopedCacheKey,
    );
    let prewarmed: string[] = [];
    const degraded: string[] = [];
    const cacheHits = entries.map((entry) => entry.hookId);
    if (entries.length === 0) {
      const prewarmResult = await this.options.prewarm({
        keyId: createRuntimeSessionKey(binding.identity),
        spaceId: binding.identity.serviceId,
        userId: binding.identity.userId,
        agentSource: binding.identity.agentSource,
        sessionInfo,
        agentDetail: binding.agent,
        taskDetail: binding.task,
        assetCapabilities: {
          skill: capabilities.skill,
          llm_wiki: capabilities.llmWiki,
          code_graph: capabilities.codeGraph,
          chat_memory: capabilities.chatMemory,
        },
        callerUserKey: this.options.callerUserKeyFor?.(binding.identity),
      }, { persist: false });
      prewarmed = [...prewarmResult.cachedHookIds];
      degraded.push(...prewarmResult.skipped.map((entry) => `prewarm:${entry.hookId}:skipped`));
      entries = prewarmResult.entries;
      this.options.cacheRepo.putMany(
        binding.identity.serviceId,
        binding.identity.userId,
        binding.identity.agentSource,
        scopedCacheKey,
        entries,
      );
    }
    const prewarmOrder = new Map(
      prewarmed.map((hookId, index) => [hookId, index]),
    );
    const orderedEntries = [...entries].sort((left, right) => {
      const leftOrder = prewarmOrder.get(left.hookId) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = prewarmOrder.get(right.hookId) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.hookId.localeCompare(right.hookId);
    });
    const blocks: RuntimeContextBlock[] = [];
    for (const [entryIndex, entry] of orderedEntries.entries()) {
      const kind = (this.options.classifyHook ?? classifyHook)(entry.hookId);
      if (!kind) {
        degraded.push(`unclassified_hook:${entry.hookId}`);
        continue;
      }
      if (!isContextKindEnabled(kind, capabilities)) continue;
      entry.blocks.forEach((block, index) => {
        blocks.push(toRuntimeBlock(entry.hookId, kind, block, entryIndex, index));
      });
    }
    return {
      blocks,
      diagnostics: {
        prewarmed,
        cacheHits,
        degraded,
      },
    };
  }
}

export class ConfigExtractionAdapter implements RuntimeExtractionAdapter {
  constructor(private readonly config: ProxyConfig) {}

  decideExtraction(
    _identity: BoundRuntimeIdentity,
    _capabilities: RuntimeCapabilityFlags,
  ): RuntimeExtractionDecision {
    return {
      l0: isExtractionAllowed(this.config, "tdai-memory"),
      skill: isExtractionAllowed(this.config, "skill"),
    };
  }
}

export class DurableRoundOutboxAdapter implements RuntimeOutboxAdapter {
  constructor(private readonly outbox: Pick<DurableRoundOutbox, "enqueue">) {}

  enqueue(round: RuntimeOutboxRound): Promise<OutboxRecord> {
    const durableRound: CompletedRound = {
      sourceEventId: round.sourceEventId,
      identity: round.identity,
      l0: round.l0,
      skill: round.skill,
      channels: round.channels,
    };
    return this.outbox.enqueue(durableRound);
  }
}

function sessionInfoFrom(identity: BoundRuntimeIdentity): SessionInfo {
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

function requiredSessionField(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryRuntimeBindingError(`${field}_required`);
  }
  return value;
}

function validateSessionBinding(session: SessionInfo): void {
  if (session.identity_verified !== true) {
    throw new MemoryRuntimeBindingError("identity_not_verified");
  }
  const permissions = session.permissions;
  if (!permissions || permissions.user_in_team !== true ||
      permissions.user_in_task !== true || permissions.agent_assigned_to_task !== true) {
    throw new MemoryRuntimeBindingError("binding_permission_denied");
  }
}

function classifyHook(hookId: string): RuntimeContextKind | null {
  return HOOK_CONTEXT_KINDS[hookId] ?? null;
}

const HOOK_CONTEXT_KINDS: Readonly<Record<string, RuntimeContextKind>> = {
  "tdai-profile-memory-injector": "memory",
  "tdai-memory-tools-injector": "memory",
  "tdai-l1-recall-injector": "memory",
  "skill-injector": "skill",
  "skill-tools-injector": "skill",
  "knowledge-tools-injector": "knowledge",
  "asset-reflection-injector": "knowledge",
};

function isContextKindEnabled(
  kind: RuntimeContextKind,
  capabilities: RuntimeCapabilityFlags,
): boolean {
  if (kind === "memory") return capabilities.chatMemory;
  if (kind === "skill") return capabilities.skill;
  return capabilities.llmWiki || capabilities.codeGraph;
}

export function createRuntimeSessionKey(identity: RuntimeIdentity): string {
  return `memory-runtime:${hashTuple([
    identity.serviceId,
    identity.userId,
    identity.agentSource,
    identity.sessionId,
  ])}`;
}

function createRuntimeContextCacheKey(
  identity: BoundRuntimeIdentity,
  capabilities: RuntimeCapabilityFlags,
): string {
  return `memory-runtime-context:${hashTuple([
    identity.serviceId,
    identity.teamId,
    identity.userId,
    identity.agentId,
    identity.taskId,
    identity.agentSource,
    identity.sessionId,
    capabilities.chatMemory,
    capabilities.skill,
    capabilities.llmWiki,
    capabilities.codeGraph,
  ])}`;
}

function hashTuple(tuple: Array<string | boolean>): string {
  return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}

function toRuntimeBlock(
  hookId: string,
  kind: RuntimeContextKind,
  block: ContextBlock,
  hookIndex: number,
  index: number,
): RuntimeContextBlock {
  const kindOrder: Record<RuntimeContextKind, number> = {
    memory: 100,
    skill: 200,
    knowledge: 300,
  };
  return {
    id: `${hookId}:${index}`,
    kind,
    order: kindOrder[kind] * 10_000 + hookIndex * 100 + index,
    type: block.type,
    content: block.content,
    ...(block.metadata === undefined ? {} : { metadata: block.metadata }),
  };
}

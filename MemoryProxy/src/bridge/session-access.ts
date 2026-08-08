import { createSessionNamespace, normalizeAgentSource } from "../agent-sources.js";
import type { BoundRuntimeIdentity, RuntimeCapabilityDecisions } from "../runtime/index.js";

export interface BridgeSessionAccess {
  identity: BoundRuntimeIdentity;
  /** Full-tuple SessionStore key; never exposed in context or HTTP responses. */
  sessionCacheKey: string;
  userKey: string;
  capabilities: RuntimeCapabilityDecisions;
}

export interface BridgeSessionLookup {
  sessionId: string;
  agentSource?: string;
}

export type BridgeSessionAccessResolver = (
  lookup: BridgeSessionLookup,
) => Promise<BridgeSessionAccess | null>;

/** Process-local authorization state populated only by a successful lifecycle prepare. */
export class BridgeSessionAccessRegistry {
  private readonly sessions = new Map<string, BridgeSessionAccess>();

  register(access: BridgeSessionAccess): void {
    this.sessions.set(
      createSessionNamespace(access.identity.agentSource, access.identity.sessionId),
      access,
    );
  }

  resolve(lookup: BridgeSessionLookup): BridgeSessionAccess | null {
    if (normalizeAgentSource(lookup.agentSource) !== "codex") return null;
    return this.sessions.get(createSessionNamespace("codex", lookup.sessionId)) ?? null;
  }

  remove(agentSource: string, sessionId: string): void {
    this.sessions.delete(createSessionNamespace(agentSource, sessionId));
  }
}

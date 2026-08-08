/** Stable source identifiers used to isolate state belonging to agent clients. */
export const AGENT_SOURCES = ["claude-code", "codebuddy", "codex"] as const;

export type KnownAgentSource = (typeof AGENT_SOURCES)[number];
export type AgentSource = KnownAgentSource | "unknown";

const knownSources = new Set<string>(AGENT_SOURCES);

/** Map external source labels onto the bounded registry used by persistence. */
export function normalizeAgentSource(value: string | null | undefined): AgentSource {
  const normalized = value?.trim().toLowerCase() ?? "";
  return knownSources.has(normalized) ? normalized as KnownAgentSource : "unknown";
}

/** Canonicalize registered labels while preserving legacy custom namespaces. */
export function canonicalizeAgentSource(
  value: string | null | undefined,
  fallback = "unknown",
): string {
  const sourceLabel = value?.trim() || fallback;
  const registeredSource = normalizeAgentSource(sourceLabel);
  return registeredSource === "unknown" ? sourceLabel : registeredSource;
}

/**
 * Build the in-process session key used by caches and recovery.
 *
 * A Codex session id is only unique within Codex. Prefixing every identity with
 * its registered source prevents the same opaque id from recovering another
 * client's state.
 */
export function createSessionNamespace(
  source: string | null | undefined,
  sessionIdentity: string,
): string {
  const identity = sessionIdentity.trim();
  if (!identity) {
    const label = normalizeAgentSource(source) === "codex" ? "Codex" : "Agent";
    throw new Error(`${label} session identity is required`);
  }
  return `${canonicalizeAgentSource(source)}:${identity}`;
}

/**
 * Lookup order for bridge calls that only carry a bare session identity.
 * Keep the two legacy namespaces in their established order, then include
 * every newer registered source so capability lookups cannot drift from the
 * source registry.
 */
export function createSessionNamespaceCandidates(sessionIdentity: string): string[] {
  const legacyOrder: KnownAgentSource[] = ["codebuddy", "claude-code"];
  const remainingSources = AGENT_SOURCES.filter((source) => !legacyOrder.includes(source));
  return [
    sessionIdentity,
    ...[...legacyOrder, ...remainingSources].map((source) => (
      createSessionNamespace(source, sessionIdentity)
    )),
  ];
}

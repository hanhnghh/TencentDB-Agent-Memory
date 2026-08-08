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
  return `${normalizeAgentSource(source)}:${identity}`;
}

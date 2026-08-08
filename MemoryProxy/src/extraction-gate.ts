/**
 * extraction-gate — the single semantic gate for every write-side
 * (extraction) call site.
 *
 * Motivation:
 *   The read side (injection) has a first-class pipeline + hook registry +
 *   yaml whitelist (`injection.injectors: [...]`). MemoryRuntime uses this
 *   gate when deciding which durable completed-round channels to enqueue.
 *
 * Design (intentionally minimal — keep the stable version stable):
 *   - Add ONE yaml section: `extraction: { enabled, extractors: [...] }`.
 *   - Add ONE pure predicate: `isExtractionAllowed(config, asset)`.
 *   - Evaluate it once behind the MemoryRuntime extraction port.
 *
 * Backwards compatibility is preserved by making the gate PERMISSIVE when
 * the config section is missing or malformed:
 *   - `config.extraction` absent          → allow all (defensive fallback)
 *   - `extractors` field missing          → allow all (partial config)
 *   - `extractors` not an array           → allow all (yaml typo tolerance)
 *   - `enabled: false`                    → deny everything
 *   - `extractors: []`                    → deny everything
 *   - `extractors: ["skill"]`             → allow only "skill"
 *
 * Adding a new extractor asset later means registering it under a stable name
 * and mapping it once in the runtime extraction adapter.
 */

import type { ProxyConfig } from "./types.js";

export function isExtractionAllowed(config: ProxyConfig, asset: string): boolean {
  const ext = config.extraction;
  // Defensive: missing extraction block → keep historical "always on" behavior.
  if (!ext) return true;
  if (ext.enabled === false) return false;
  // Defensive: missing / non-array extractors → treat as unrestricted whitelist
  // so a partial or misconfigured yaml never silently disables writes.
  if (!Array.isArray(ext.extractors)) return true;
  return ext.extractors.includes(asset);
}

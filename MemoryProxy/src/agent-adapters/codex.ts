import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

/**
 * Codex hooks do not use the proxy request classifier, but registering an
 * adapter keeps capability/source lookup explicit and prevents Codex from
 * falling through to the unknown client namespace.
 */
export const codexAdapter: AgentAdapter = {
  agentKind: "codex",
  classifyRequest: defaultAdapter.classifyRequest,
  extractUserText: defaultAdapter.extractUserText,
};

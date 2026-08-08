import { describe, expect, it } from "vitest";

import { normalizeConversation } from "../../skill/normalize-conversation.js";
import {
  COMPLETED_ROUND_GOLDEN,
  HOOK_ROUND_INPUT,
  PROXY_ROUND_INPUTS,
  normalizedHookRound,
} from "./fixtures.js";

describe("memory parity: completed-round normalization", () => {
  it.each(PROXY_ROUND_INPUTS)(
    "normalizes $protocol proxy input to the shared golden round",
    ({ messages, protocol, assistantMessage, agentSource }) => {
      expect(normalizeConversation(messages, protocol, assistantMessage, agentSource))
        .toEqual(COMPLETED_ROUND_GOLDEN);
    },
  );

  it("keeps the hook-derived fixture independent of proxy request shapes", () => {
    expect(normalizedHookRound(HOOK_ROUND_INPUT)).toEqual(COMPLETED_ROUND_GOLDEN);
  });

  it("does not retain system, thinking, or image payloads in the golden output", () => {
    const serialized = JSON.stringify(COMPLETED_ROUND_GOLDEN);

    expect(serialized).not.toContain("secret system instruction");
    expect(serialized).not.toContain("hidden reasoning");
    expect(serialized).not.toContain("not-memory");
  });
});

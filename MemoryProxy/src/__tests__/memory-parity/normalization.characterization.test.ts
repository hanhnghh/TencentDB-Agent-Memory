import { describe, expect, it } from "vitest";

import { normalizeConversation } from "../../skill/normalize-conversation.js";
import {
  COMPLETED_ROUND_GOLDEN,
  HOOK_ROUND_INPUT,
  LARGE_TOOL_RESULT,
  NORMALIZATION_SCENARIOS,
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

  it("keeps the required normalization scenario inventory executable", () => {
    expect(NORMALIZATION_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "unicode-code",
      "multiple-tools",
      "failed-tool",
      "empty-result",
      "large-result-boundary",
    ]);
  });

  it.each(NORMALIZATION_SCENARIOS)(
    "normalizes $id through both proxy protocols and hook-derived input",
    ({ proxyInputs, hookInput, golden }) => {
      for (const { messages, protocol, assistantMessage, agentSource } of proxyInputs) {
        expect(normalizeConversation(messages, protocol, assistantMessage, agentSource))
          .toEqual(golden);
      }
      expect(normalizedHookRound(hookInput)).toEqual(golden);
    },
  );

  it("preserves the large tool result beyond the 40 KiB extraction boundary", () => {
    const scenario = NORMALIZATION_SCENARIOS.find(
      ({ id }) => id === "large-result-boundary",
    );

    expect(scenario).toBeDefined();
    expect(LARGE_TOOL_RESULT.length).toBeGreaterThan(40 * 1024);
    expect(scenario?.golden.find(({ role }) => role === "tool_result")?.content)
      .toBe(LARGE_TOOL_RESULT);
  });
});

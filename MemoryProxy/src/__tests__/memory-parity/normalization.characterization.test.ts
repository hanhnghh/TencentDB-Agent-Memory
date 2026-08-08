import { describe, expect, it } from "vitest";

import { normalizeConversation } from "../../skill/normalize-conversation.js";
import {
  COMPLETED_ROUND_GOLDEN,
  HOSTED_TOOL_VISIBILITY_FIXTURE,
  HOOK_ROUND_INPUT,
  INJECTED_MEMORY_CONTEXT,
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

  it("excludes injected memory while retaining the real user code block", () => {
    const user = COMPLETED_ROUND_GOLDEN.find(({ role }) => role === "user");

    expect(user?.content).toBe("Giữ Unicode 🧠 và code:\n```ts\nconst café = true;\n```");
    expect(JSON.stringify(COMPLETED_ROUND_GOLDEN)).not.toContain(INJECTED_MEMORY_CONTEXT);
  });

  it("keeps the required normalization scenario inventory executable", () => {
    expect(NORMALIZATION_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "unicode-code",
      "multiple-tools",
      "failed-tool",
      "empty-result",
      "large-result-boundary",
      "local-exec",
      "apply-patch",
      "mcp-tool",
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

  it("keeps hosted-tool omission explicit at the proxy/hook visibility boundary", () => {
    const { proxyInput, hookInput, proxyGolden, hookGolden } =
      HOSTED_TOOL_VISIBILITY_FIXTURE;

    expect(normalizeConversation(
      proxyInput.messages,
      proxyInput.protocol,
      proxyInput.assistantMessage,
      proxyInput.agentSource,
    )).toEqual(proxyGolden);
    expect(normalizedHookRound(hookInput)).toEqual(hookGolden);
    expect(proxyGolden.some(({ role }) => role === "tool_call")).toBe(true);
    expect(hookGolden.some(({ role }) => role === "tool_call")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  HOSTED_TOOL_VISIBILITY_FIXTURE,
  NORMALIZATION_SCENARIOS,
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_TASK,
  type HookRoundInput,
} from "../../__tests__/memory-parity/fixtures.js";
import { InMemoryMemoryRuntimeAdapters, MemoryRuntime } from "../../runtime/index.js";
import {
  buildCodexCompletedRound,
  normalizeCodexToolInput,
  normalizeCodexToolResponse,
} from "../round-normalizer.js";

describe("Codex completed-round adapter", () => {
  it.each(NORMALIZATION_SCENARIOS)(
    "commits $id as the shared L0 pair and full normalized skill round",
    async ({ hookInput, golden }) => {
      const adapters = adaptersFor(hookInput);
      const runtime = new MemoryRuntime(adapters);

      await runtime.commitCompletedRound(completedRound(hookInput));

      expect(adapters.enqueuedRounds).toHaveLength(1);
      expect(adapters.enqueuedRounds[0]?.l0.messages).toEqual([
        { role: "user", content: hookInput.prompt.prompt },
        { role: "assistant", content: hookInput.stop.assistant },
      ]);
      expect(adapters.enqueuedRounds[0]?.skill.messages).toEqual(golden);
    },
  );

  it("documents hosted-tool omission without inferring transcript events", async () => {
    const { hookInput, hookGolden } = HOSTED_TOOL_VISIBILITY_FIXTURE;
    const adapters = adaptersFor(hookInput);

    await new MemoryRuntime(adapters).commitCompletedRound(completedRound(hookInput));

    expect(adapters.enqueuedRounds[0]?.skill.messages).toEqual(hookGolden);
    expect(adapters.enqueuedRounds[0]?.skill.messages.some(({ role }) => role === "tool_call"))
      .toBe(false);
  });

  it("excludes private blocks from structured tool calls and results", () => {
    expect(normalizeCodexToolInput({
      query: "visible user code",
      patch: "const delimiter = '<agent_memory_context>';",
      context: [
        { type: "text", text: "visible input evidence" },
        { type: "input_image", image_url: "base64-private-image" },
        { type: "thinking", thinking: "hidden reasoning" },
        { role: "system", content: "hidden system instruction" },
        {
          type: "text",
          text: '<agent_memory_context injected="true" capture="exclude">private memory</agent_memory_context>',
        },
      ],
    })).toEqual({
      context: [{ text: "visible input evidence", type: "text" }],
      patch: "const delimiter = '<agent_memory_context>';",
      query: "visible user code",
    });

    expect(normalizeCodexToolResponse({
      content: [
        { type: "text", text: "visible tool evidence" },
        { type: "text", text: "const delimiter = '<agent_memory_context>';" },
        { type: "image", data: "base64-private-image" },
        { type: "thinking", thinking: "hidden reasoning" },
        { role: "system", content: "hidden system instruction" },
        {
          type: "text",
          text: '<agent_memory_context injected="true" capture="exclude">private memory</agent_memory_context>',
        },
      ],
      structuredContent: {
        result: "visible structured evidence",
        hidden: { type: "redacted_thinking", data: "private reasoning" },
      },
    })).toEqual({
      output: "{\"content\":[{\"text\":\"visible tool evidence\",\"type\":\"text\"},{\"text\":\"const delimiter = '<agent_memory_context>';\",\"type\":\"text\"}],\"structuredContent\":{\"result\":\"visible structured evidence\"}}",
      failed: false,
    });
  });
});

function adaptersFor(hookInput: HookRoundInput): InMemoryMemoryRuntimeAdapters {
  return new InMemoryMemoryRuntimeAdapters({
    binding: {
      identity: runtimeIdentity(hookInput),
      resolution: "recovered",
      agent: PARITY_AGENT,
      task: PARITY_TASK,
    },
    extraction: { l0: true, skill: true },
  });
}

function completedRound(hookInput: HookRoundInput) {
  return buildCodexCompletedRound({
    identity: { ...runtimeIdentity(hookInput), turnId: hookInput.prompt.turn_id },
    prompt: hookInput.prompt.prompt,
    tools: hookInput.tools.map((tool) => ({
      toolUseId: tool.tool_call_id,
      toolName: tool.tool_name,
      input: tool.input,
      output: tool.result,
      failed: tool.failed,
    })),
    finalResponse: hookInput.stop.assistant,
  });
}

function runtimeIdentity(hookInput: HookRoundInput) {
  return {
    serviceId: PARITY_IDENTITY.spaceId,
    userId: PARITY_IDENTITY.userId,
    teamId: PARITY_IDENTITY.teamId,
    agentId: PARITY_IDENTITY.agentId,
    taskId: PARITY_IDENTITY.taskId,
    agentSource: "codex" as const,
    sessionId: hookInput.prompt.session_id,
  };
}

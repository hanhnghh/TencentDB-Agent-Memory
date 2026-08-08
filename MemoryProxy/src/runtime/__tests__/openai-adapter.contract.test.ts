import { describe, expect, it } from "vitest";

import {
  FINAL_ASSISTANT,
  INTERMEDIATE_ASSISTANT,
  NORMALIZATION_SCENARIOS,
  PARITY_IDENTITY,
  PROXY_ROUND_INPUTS,
  USER_PROMPT,
} from "../../__tests__/memory-parity/fixtures.js";
import { buildOpenAICompletedRound } from "../openai-adapter.js";

describe("OpenAI MemoryRuntime adapter", () => {
  const fixture = PROXY_ROUND_INPUTS.find((entry) => entry.protocol === "openai");
  if (!fixture) throw new Error("OpenAI completed-round fixture is required");
  const identity = {
    serviceId: PARITY_IDENTITY.spaceId,
    userId: PARITY_IDENTITY.userId,
    agentSource: fixture.agentSource,
    sessionId: PARITY_IDENTITY.sessionId,
  };

  it("does not commit an intermediate tool-call HTTP response", () => {
    expect(buildOpenAICompletedRound({
      identity,
      turnSequence: 1,
      inputMessages: [fixture.messages[1]],
      assistantMessage: fixture.messages[2],
    })).toBeNull();
  });

  it("builds one canonical completed round without recapturing injected context", () => {
    expect(buildOpenAICompletedRound({
      identity,
      turnSequence: 1,
      inputMessages: fixture.messages,
      assistantMessage: fixture.assistantMessage,
    })).toEqual({
      sourceEventId: expect.stringMatching(/^proxy:openai:sha256:[a-f0-9]{64}$/),
      identity: { ...identity, turnId: "turn-1" },
      realPrompt: USER_PROMPT,
      events: [
        { type: "tool_call", toolCallId: "tool-1", toolName: "shell", input: { cmd: "printf 'xin chào'" } },
        { type: "tool_result", toolCallId: "tool-1", content: "xin chào\nexit: 0", failed: false },
      ],
      finalResponse: FINAL_ASSISTANT,
    });
  });

  it("derives the same identity for stream and non-stream final responses", () => {
    const nonStream = buildOpenAICompletedRound({
      identity,
      turnSequence: 1,
      inputMessages: fixture.messages,
      assistantMessage: fixture.assistantMessage,
    });
    const stream = buildOpenAICompletedRound({
      identity,
      turnSequence: 1,
      inputMessages: fixture.messages,
      assistantMessage: { role: "assistant", content: FINAL_ASSISTANT },
    });

    expect(stream).toEqual(nonStream);
    expect(stream?.events).not.toContainEqual({ type: "assistant", content: INTERMEDIATE_ASSISTANT });
  });

  it.each(NORMALIZATION_SCENARIOS)(
    "preserves the $id shared normalization contract at the runtime seam",
    ({ proxyInputs, golden }) => {
      const input = proxyInputs.find((entry) => entry.protocol === "openai");
      if (!input) throw new Error("OpenAI normalization fixture is required");

      const round = buildOpenAICompletedRound({
        identity,
        turnSequence: 1,
        inputMessages: input.messages,
        assistantMessage: input.assistantMessage,
      });

      expect(toNormalizedRound(round)).toEqual(golden);
    },
  );
});

function toNormalizedRound(round: ReturnType<typeof buildOpenAICompletedRound>): unknown[] | null {
  if (!round) return null;
  return [
    { role: "user", content: round.realPrompt },
    ...round.events.map((event) => {
      if (event.type === "tool_call") return {
        role: "tool_call",
        content: JSON.stringify(event.input),
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
      };
      if (event.type === "tool_result") return {
        role: "tool_result",
        content: event.content,
        tool_call_id: event.toolCallId,
      };
      return { role: "assistant", content: event.content };
    }),
    { role: "assistant", content: round.finalResponse },
  ];
}

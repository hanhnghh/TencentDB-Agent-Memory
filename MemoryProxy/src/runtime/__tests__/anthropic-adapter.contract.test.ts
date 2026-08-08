import { describe, expect, it } from "vitest";

import {
  COMPLETED_ROUND_GOLDEN,
  FINAL_ASSISTANT,
  NORMALIZATION_SCENARIOS,
  PARITY_IDENTITY,
  PROXY_ROUND_INPUTS,
  USER_PROMPT,
} from "../../__tests__/memory-parity/fixtures.js";
import {
  AnthropicStreamAccumulator,
  buildAnthropicCompletedRound,
} from "../anthropic-adapter.js";

describe("Anthropic MemoryRuntime adapter", () => {
  const fixture = PROXY_ROUND_INPUTS.find((entry) => entry.protocol === "anthropic");
  if (!fixture) throw new Error("Anthropic completed-round fixture is required");
  const identity = {
    serviceId: PARITY_IDENTITY.spaceId,
    userId: PARITY_IDENTITY.userId,
    agentSource: fixture.agentSource,
    sessionId: PARITY_IDENTITY.sessionId,
  };

  it("does not commit an intermediate tool-use HTTP response", () => {
    expect(buildAnthropicCompletedRound({
      identity,
      turnSequence: 1,
      inputMessages: [fixture.messages[1]],
      assistantMessage: fixture.messages[2],
    })).toBeNull();
  });

  it("builds the shared tool-aware completed round without injected context", () => {
    expect(buildAnthropicCompletedRound({
      identity,
      turnSequence: 1,
      inputMessages: fixture.messages,
      assistantMessage: fixture.assistantMessage,
    })).toEqual({
      sourceEventId: expect.stringMatching(/^proxy:anthropic:sha256:[a-f0-9]{64}$/),
      identity: { ...identity, turnId: "turn-1" },
      realPrompt: USER_PROMPT,
      events: [
        { type: "tool_call", toolCallId: "tool-1", toolName: "shell", input: { cmd: "printf 'xin chào'" } },
        { type: "tool_result", toolCallId: "tool-1", content: "xin chào\nexit: 0", failed: false },
      ],
      finalResponse: FINAL_ASSISTANT,
    });
  });

  it("normalizes stream and non-stream final responses identically", () => {
    const nonStream = buildAnthropicCompletedRound({
      identity,
      turnSequence: 1,
      inputMessages: fixture.messages,
      assistantMessage: fixture.assistantMessage,
    });
    const stream = buildAnthropicCompletedRound({
      identity,
      turnSequence: 1,
      inputMessages: fixture.messages,
      assistantMessage: { role: "assistant", content: [{ type: "text", text: FINAL_ASSISTANT }] },
      toolCallCountOverride: 0,
    });

    expect(stream).toEqual(nonStream);
    expect(nonStream && [
      { role: "user", content: nonStream.realPrompt },
      ...nonStream.events.map((event) => {
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
      { role: "assistant", content: nonStream.finalResponse },
    ]).toEqual(COMPLETED_ROUND_GOLDEN);
  });

  it("joins multiple streamed text blocks like a non-stream response", () => {
    const accumulator = new AnthropicStreamAccumulator();
    accumulator.push([
      'data: {"type":"content_block_start","content_block":{"type":"text","text":"foo"}}',
      'data: {"type":"content_block_start","content_block":{"type":"text","text":"bar"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      'data: {"type":"message_stop"}',
      "",
    ].join("\n\n"));

    expect(accumulator.finish()).toMatchObject({
      outputText: "foo\nbar",
      messageStopped: true,
      stopReason: "end_turn",
      malformedEventCount: 0,
    });
  });

  it.each(NORMALIZATION_SCENARIOS)(
    "preserves the $id shared normalization contract at the runtime seam",
    ({ proxyInputs, golden }) => {
      const input = proxyInputs.find((entry) => entry.protocol === "anthropic");
      if (!input) throw new Error("Anthropic normalization fixture is required");

      const round = buildAnthropicCompletedRound({
        identity,
        turnSequence: 1,
        inputMessages: input.messages,
        assistantMessage: input.assistantMessage,
      });

      expect(toNormalizedRound(round)).toEqual(golden);
    },
  );
});

function toNormalizedRound(round: ReturnType<typeof buildAnthropicCompletedRound>): unknown[] | null {
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

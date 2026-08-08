import { describe, expect, it } from "vitest";

import { normalizeConversation } from "../normalize-conversation.js";

describe("observed legacy skill conversation normalization", () => {
  it("preserves Unicode and real user code blocks", () => {
    const output = normalizeConversation(
      [{ role: "user", content: "Xin chào 世界\n```ts\nconst answer = 42;\n```" }],
      "openai",
      { role: "assistant", content: "Đã hiểu ✓" },
      "unknown",
    );

    expect(output).toEqual([
      { role: "user", content: "Xin chào 世界\n```ts\nconst answer = 42;\n```" },
      { role: "assistant", content: "Đã hiểu ✓" },
    ]);
  });

  it("keeps multiple tool calls paired with their results", () => {
    const output = normalizeConversation(
      [
        { role: "user", content: "run both" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call-a", function: { name: "read", arguments: "{\"path\":\"a\"}" } },
            { id: "call-b", function: { name: "write", arguments: "{\"path\":\"b\"}" } },
          ],
        },
        { role: "tool", tool_call_id: "call-a", content: "a contents" },
        { role: "tool", tool_call_id: "call-b", content: "b contents" },
      ],
      "openai",
      { role: "assistant", content: "done" },
      "unknown",
    );

    expect(output).toEqual([
      { role: "user", content: "run both" },
      { role: "tool_call", content: "{\"path\":\"a\"}", tool_call_id: "call-a", tool_name: "read" },
      { role: "tool_call", content: "{\"path\":\"b\"}", tool_call_id: "call-b", tool_name: "write" },
      { role: "tool_result", content: "a contents", tool_call_id: "call-a" },
      { role: "tool_result", content: "b contents", tool_call_id: "call-b" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("retains a failed tool result as paired extraction evidence", () => {
    const output = normalizeConversation(
      [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call-failed",
          is_error: true,
          content: "exit status 1: permission denied",
        }],
      }],
      "anthropic",
      { role: "assistant", content: [{ type: "text", text: "I will recover" }] },
      "claude-code",
    );

    expect(output).toEqual([
      {
        role: "tool_result",
        content: "exit status 1: permission denied",
        tool_call_id: "call-failed",
      },
      { role: "assistant", content: "I will recover" },
    ]);
  });

  it("retains an empty tool result with its pairing identity", () => {
    const output = normalizeConversation(
      [{ role: "tool", tool_call_id: "call-empty", content: "" }],
      "openai",
      { role: "assistant", content: "no output" },
      "unknown",
    );

    expect(output).toContainEqual({
      role: "tool_result",
      content: "",
      tool_call_id: "call-empty",
    });
  });

  it("excludes system instructions", () => {
    const output = normalizeConversation(
      [
        { role: "system", content: "secret system instruction" },
        { role: "user", content: "real prompt" },
      ],
      "openai",
      { role: "assistant", content: "answer" },
      "unknown",
    );

    expect(output.map((message) => message.content)).not.toContain("secret system instruction");
    expect(output).toContainEqual({ role: "user", content: "real prompt" });
  });

  it("excludes thinking and hidden-reasoning blocks", () => {
    const output = normalizeConversation(
      [],
      "anthropic",
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden thought" },
          { type: "redacted_thinking", data: "hidden signature" },
          { type: "text", text: "public answer" },
        ],
      },
      "claude-code",
    );

    expect(output).toEqual([{ role: "assistant", content: "public answer" }]);
  });

  it("excludes image blocks", () => {
    const output = normalizeConversation(
      [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "private-image-data" } },
          { type: "text", text: "describe the attachment" },
        ],
      }],
      "anthropic",
      {
        role: "assistant",
        content: [
          { type: "image", source: { type: "base64", data: "generated-image-data" } },
          { type: "text", text: "description" },
        ],
      },
      "claude-code",
    );

    expect(output).toEqual([
      { role: "user", content: "describe the attachment" },
      { role: "assistant", content: "description" },
    ]);
  });

  it("does not recapture injected memory context as the real prompt", () => {
    const output = normalizeConversation(
      [{
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>injected durable memory</system-reminder>" },
          { type: "text", text: "the real user prompt" },
        ],
      }],
      "anthropic",
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      "claude-code",
    );

    expect(output).toEqual([
      { role: "user", content: "the real user prompt" },
      { role: "assistant", content: "answer" },
    ]);
  });
});

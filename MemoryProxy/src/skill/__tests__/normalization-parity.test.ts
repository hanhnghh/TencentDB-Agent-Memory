import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { CoreSkillClient, setCoreSkillClient } from "../core-client.js";
import { triggerSkillExtractIfReady } from "../handler-glue.js";

afterEach(() => {
  setCoreSkillClient(null);
  vi.restoreAllMocks();
});

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  coreSkill: {
    endpoint: "https://core.example",
    serviceToken: "token",
    serviceId: "space-1",
    timeoutMs: 1_000,
  },
};

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error("captured request body must be an object");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function captureCompletedRound(
  inputMessages: unknown[],
  protocol: "openai" | "anthropic",
  assistantMessage: Record<string, unknown>,
  agentSource = "unknown",
): Promise<Array<Record<string, unknown>>> {
  let captured: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    captured = parseRecord(String(init?.body));
    return new Response(JSON.stringify({
      code: 0,
      data: {
        status: "ok",
        receipt: {
          receipt_id: "receipt-1",
          source_event_id: captured.source_event_id,
          content_hash: captured.content_hash,
          accepted_at_ms: 42,
        },
      },
    }), { status: 200 });
  });
  setCoreSkillClient(new CoreSkillClient(TEST_CONFIG.coreSkill, fetcher));
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  await triggerSkillExtractIfReady({
    config: TEST_CONFIG,
    sessionKey: "session-normalization",
    agentSource,
    sessionInfo: {
      space_id: "space-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
    },
    inputMessages,
    assistantMessage,
    protocol,
    turnSequence: 11,
  });

  if (!captured || !Array.isArray(captured.messages)) {
    throw new Error("completed-round lifecycle did not send a conversation request");
  }
  const messages = captured.messages;
  if (!messages.every((message): message is Record<string, unknown> => (
    message !== null && typeof message === "object" && !Array.isArray(message)
  ))) {
    throw new Error("completed-round lifecycle sent a malformed message");
  }
  return messages;
}

describe("observed legacy skill conversation normalization", () => {
  it("preserves Unicode and real user code blocks at the completed-round lifecycle seam", async () => {
    const output = await captureCompletedRound(
      [{ role: "user", content: "Xin chào 世界\n```ts\nconst answer = 42;\n```" }],
      "openai",
      { role: "assistant", content: "Đã hiểu ✓" },
    );

    expect(output).toEqual([
      { role: "user", content: "Xin chào 世界\n```ts\nconst answer = 42;\n```" },
      { role: "assistant", content: "Đã hiểu ✓" },
    ]);
  });

  it("keeps multiple tool calls paired with their results at the completed-round lifecycle seam", async () => {
    const output = await captureCompletedRound(
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

  it("retains a failed tool result as paired extraction evidence at the completed-round lifecycle seam", async () => {
    const output = await captureCompletedRound(
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

  it("retains an empty tool result with its pairing identity at the completed-round lifecycle seam", async () => {
    const output = await captureCompletedRound(
      [{ role: "tool", tool_call_id: "call-empty", content: "" }],
      "openai",
      { role: "assistant", content: "no output" },
    );

    expect(output).toContainEqual({
      role: "tool_result",
      content: "",
      tool_call_id: "call-empty",
    });
  });

  it("excludes system instructions at the completed-round lifecycle seam", async () => {
    const output = await captureCompletedRound(
      [
        { role: "system", content: "secret system instruction" },
        { role: "user", content: "real prompt" },
      ],
      "openai",
      { role: "assistant", content: "answer" },
    );

    expect(output.map((message) => message.content)).not.toContain("secret system instruction");
    expect(output).toContainEqual({ role: "user", content: "real prompt" });
  });

  it("excludes thinking and hidden-reasoning blocks at the completed-round lifecycle seam", async () => {
    const output = await captureCompletedRound(
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

  it("excludes image blocks at the completed-round lifecycle seam", async () => {
    const output = await captureCompletedRound(
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

  it("does not recapture injected memory context at the completed-round lifecycle seam", async () => {
    const output = await captureCompletedRound(
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

  it("preserves a sequential OpenAI tool loop at the completed-round lifecycle seam", async () => {
    const output = await captureCompletedRound(
      [
        { role: "user", content: "inspect and patch" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-read", function: { name: "read", arguments: "{\"path\":\"a\"}" } }],
        },
        { role: "tool", tool_call_id: "call-read", content: "old" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-patch", function: { name: "apply_patch", arguments: "{\"path\":\"a\"}" } }],
        },
        { role: "tool", tool_call_id: "call-patch", content: "done" },
      ],
      "openai",
      { role: "assistant", content: "patched" },
    );

    expect(output).toEqual([
      { role: "user", content: "inspect and patch" },
      { role: "tool_call", content: "{\"path\":\"a\"}", tool_call_id: "call-read", tool_name: "read" },
      { role: "tool_result", content: "old", tool_call_id: "call-read" },
      { role: "tool_call", content: "{\"path\":\"a\"}", tool_call_id: "call-patch", tool_name: "apply_patch" },
      { role: "tool_result", content: "done", tool_call_id: "call-patch" },
      { role: "assistant", content: "patched" },
    ]);
  });

  it("does not schedule ingestion for an intermediate OpenAI tool-call response", async () => {
    const fetcher = vi.fn();
    setCoreSkillClient(new CoreSkillClient(TEST_CONFIG.coreSkill, fetcher));

    await triggerSkillExtractIfReady({
      config: TEST_CONFIG,
      sessionKey: "session-intermediate",
      agentSource: "unknown",
      sessionInfo: {
        space_id: "space-1",
        user_id: "user-1",
        team_id: "team-1",
        agent_id: "agent-1",
      },
      inputMessages: [{ role: "user", content: "run a tool" }],
      assistantMessage: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-1", function: { name: "read", arguments: "{}" } }],
      },
      protocol: "openai",
      turnSequence: 12,
    });

    expect(fetcher).not.toHaveBeenCalled();
  });
});

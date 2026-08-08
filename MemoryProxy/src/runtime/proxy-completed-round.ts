import { createHash } from "node:crypto";

import {
  findLastFinalAssistant,
  isFinalAnswer,
  normalizeConversation,
  type NormalizedMessage,
  type Protocol,
  type RawMessage,
} from "../skill/normalize-conversation.js";
import type {
  CommitCompletedRoundInput,
  RuntimeIdentity,
  RuntimeRoundEvent,
} from "./index.js";

export interface BuildProxyCompletedRoundInput {
  identity: RuntimeIdentity;
  turnSequence: number;
  inputMessages: unknown[];
  assistantMessage: Record<string, unknown> | null;
  toolCallCountOverride?: number;
}

/** Normalize a protocol response into the transport-independent completed-round contract. */
export function buildProxyCompletedRound(
  protocol: Protocol,
  input: BuildProxyCompletedRoundInput,
): CommitCompletedRoundInput | null {
  if (!isFinalAnswer(input.assistantMessage, input.toolCallCountOverride)) return null;

  const rawMessages = input.inputMessages.filter(isRawMessage);
  const startIndex = findLastFinalAssistant(rawMessages, protocol) + 1;
  const normalized = normalizeConversation(
    rawMessages.slice(startIndex),
    protocol,
    input.assistantMessage,
    input.identity.agentSource,
  );
  const first = normalized[0];
  const last = normalized.at(-1);
  if (first?.role !== "user" || last?.role !== "assistant" ||
      !first.content.trim() || !last.content.trim()) {
    return null;
  }

  const turnSequence = Math.max(1, Math.floor(input.turnSequence));
  const turnId = `turn-${turnSequence}`;
  return {
    sourceEventId: `proxy:${protocol}:sha256:${sha256(JSON.stringify({
      ...input.identity,
      turnId,
    }))}`,
    identity: { ...input.identity, turnId },
    realPrompt: first.content,
    events: normalized.slice(1, -1).map(toRuntimeEvent),
    finalResponse: last.content,
  };
}

function toRuntimeEvent(message: NormalizedMessage): RuntimeRoundEvent {
  switch (message.role) {
  case "assistant":
    return { type: "assistant", content: message.content };
  case "tool_call":
    return {
      type: "tool_call",
      toolCallId: message.tool_call_id ?? "",
      toolName: message.tool_name ?? "unknown",
      input: parseToolInput(message.content),
    };
  case "tool_result":
    return {
      type: "tool_result",
      toolCallId: message.tool_call_id ?? "",
      content: message.content,
      failed: false,
    };
  case "user":
  case "system":
    throw new TypeError(`Unexpected ${message.role} message inside a completed round`);
  }
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRawMessage(value: unknown): value is RawMessage {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

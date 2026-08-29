import type { CommitCompletedRoundInput } from "./index.js";
import {
  buildProxyCompletedRound,
  type BuildProxyCompletedRoundInput,
} from "./proxy-completed-round.js";

export type BuildAnthropicCompletedRoundInput = BuildProxyCompletedRoundInput;

/** Convert one final Anthropic response into the shared completed-round contract. */
export function buildAnthropicCompletedRound(
  input: BuildAnthropicCompletedRoundInput,
): CommitCompletedRoundInput | null {
  return buildProxyCompletedRound("anthropic", input);
}

export interface AnthropicStreamSnapshot {
  usage: Record<string, unknown>;
  outputText: string;
  toolUseCount: number;
  messageStopped: boolean;
  stopReason: string | null;
  malformedEventCount: number;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

/** Incrementally accumulates the canonical Anthropic SSE response state. */
export class AnthropicStreamAccumulator {
  private buffer = "";
  private readonly usage: Record<string, unknown> = {};
  private outputText = "";
  private toolUseCount = 0;
  private textBlockCount = 0;
  private messageStopped = false;
  private stopReason: string | null = null;
  private malformedEventCount = 0;
  private readonly toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  push(text: string): void {
    this.buffer += text;
    const events = this.buffer.split("\n\n");
    this.buffer = events.pop() ?? "";
    for (const event of events) this.processEvent(event);
  }

  finish(text = ""): AnthropicStreamSnapshot {
    this.buffer += text;
    if (this.buffer.trim()) this.processEvent(this.buffer);
    this.buffer = "";
    return this.snapshot();
  }

  snapshot(): AnthropicStreamSnapshot {
    return {
      usage: { ...this.usage },
      outputText: this.outputText,
      toolUseCount: this.toolUseCount,
      messageStopped: this.messageStopped,
      stopReason: this.stopReason,
      malformedEventCount: this.malformedEventCount,
      toolCalls: [...this.toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({ ...call })),
    };
  }

  private processEvent(eventText: string): void {
    const data = eventText.split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (!data || data === "[DONE]") return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.malformedEventCount += 1;
      return;
    }

    if (event.type === "message_start") {
      const message = event.message as Record<string, unknown> | undefined;
      if (message?.usage && typeof message.usage === "object") {
        Object.assign(this.usage, message.usage);
      }
      return;
    }
    if (event.type === "message_delta") {
      if (event.usage && typeof event.usage === "object") {
        Object.assign(this.usage, event.usage);
      }
      const delta = event.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === "string") this.stopReason = delta.stop_reason;
      return;
    }
    if (event.type === "message_stop") {
      this.messageStopped = true;
      return;
    }
    if (event.type === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === "tool_use") {
        this.toolUseCount += 1;
        const index = typeof event.index === "number" ? event.index : this.toolUseCount - 1;
        this.toolCalls.set(index, {
          id: typeof block.id === "string" ? block.id : "",
          name: typeof block.name === "string" ? block.name : "",
          arguments: "",
        });
      }
      if (block?.type === "text") {
        if (this.textBlockCount > 0) this.outputText += "\n";
        this.textBlockCount += 1;
        if (typeof block.text === "string") this.outputText += block.text;
      }
      return;
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.outputText += delta.text;
      }
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const index = typeof event.index === "number" ? event.index : undefined;
        const call = index === undefined ? undefined : this.toolCalls.get(index);
        if (call) call.arguments += delta.partial_json;
      }
    }
  }
}

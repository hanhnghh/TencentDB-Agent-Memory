import type { CommitCompletedRoundInput } from "./index.js";
import {
  buildProxyCompletedRound,
  type BuildProxyCompletedRoundInput,
} from "./proxy-completed-round.js";

export type BuildOpenAICompletedRoundInput = BuildProxyCompletedRoundInput;

/** Convert one final OpenAI HTTP response into the shared completed-round contract. */
export function buildOpenAICompletedRound(
  input: BuildOpenAICompletedRoundInput,
): CommitCompletedRoundInput | null {
  return buildProxyCompletedRound("openai", input);
}

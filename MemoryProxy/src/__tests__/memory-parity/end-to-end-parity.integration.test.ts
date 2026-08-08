import { describe, expect, it } from "vitest";

import { createSessionNamespace } from "../../agent-sources.js";
import { buildCodexCompletedRound } from "../../codex/round-normalizer.js";
import {
  InMemoryMemoryRuntimeAdapters,
  MemoryRuntime,
  MemoryRuntimeAuthorizationError,
  type BoundRuntimeIdentity,
  type CommitCompletedRoundInput,
  type PrepareContextResult,
  type RuntimeAuthorizationDecision,
  type RuntimeCapabilityFlags,
  type RuntimeContextBlock,
  type RuntimeIdentity,
  type RuntimeOutboxRound,
} from "../../runtime/index.js";
import { buildOpenAICompletedRound } from "../../runtime/openai-adapter.js";
import {
  COMPLETED_ROUND_GOLDEN,
  HOOK_ROUND_INPUT,
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_TASK,
  PROXY_ROUND_INPUTS,
} from "./fixtures.js";

const PARITY_AGENT_SOURCES = ["codebuddy", "codex"] as const;
const DISABLED_CAPABILITIES = {
  skill: false,
  llmWiki: false,
  codeGraph: false,
  chatMemory: false,
} as const satisfies RuntimeCapabilityFlags;
const ACL_DENIAL_REASON = "fixture_denied";

type ParityAgentSource = (typeof PARITY_AGENT_SOURCES)[number];

interface RuntimeHarnessOptions {
  capabilities?: RuntimeCapabilityFlags;
  authorizationAllowed?: boolean;
}

interface RuntimeHarness {
  runtime: MemoryRuntime;
  adapters: InMemoryMemoryRuntimeAdapters;
}

const CONTEXT_BLOCKS: readonly RuntimeContextBlock[] = [
  {
    id: "memory",
    sourceHookId: "tdai-profile-memory-injector",
    kind: "memory",
    order: 10,
    type: "text",
    content: "Remember the shared release decision.",
  },
  {
    id: "skill",
    sourceHookId: "skill-injector",
    kind: "skill",
    order: 20,
    type: "text",
    content: "Use the verified deployment checklist.",
  },
];

describe("proxy/hooks end-to-end memory parity", () => {
  it("produces equivalent prepared context, L0 pair, and normalized skill round", async () => {
    const proxyIdentity = runtimeIdentity("codebuddy");
    const hookIdentity = runtimeIdentity("codex");
    const proxyHarness = createRuntimeHarness(proxyIdentity);
    const hookHarness = createRuntimeHarness(hookIdentity);

    const proxyPrepared = await proxyHarness.runtime.prepareContext({ identity: proxyIdentity });
    const hookPrepared = await hookHarness.runtime.prepareContext({ identity: hookIdentity });
    const proxyRound = representativeProxyRound(proxyIdentity);
    const hookRound = representativeHookRound(hookIdentity);

    await proxyHarness.runtime.commitCompletedRound(proxyRound);
    await hookHarness.runtime.commitCompletedRound(hookRound);

    const proxyMemoryOutcome = memoryOutcome(proxyHarness.adapters.enqueuedRounds[0]);
    const hookMemoryOutcome = memoryOutcome(hookHarness.adapters.enqueuedRounds[0]);

    expect(transportNeutralContext(proxyPrepared)).toEqual(transportNeutralContext(hookPrepared));
    expect(proxyMemoryOutcome).toEqual(hookMemoryOutcome);
    expect(proxyMemoryOutcome).toEqual({
      l0: {
        messages: [
          { role: "user", content: HOOK_ROUND_INPUT.prompt.prompt },
          { role: "assistant", content: HOOK_ROUND_INPUT.stop.assistant },
        ],
      },
      skill: { messages: COMPLETED_ROUND_GOLDEN },
      channels: { l0: true, skill: true },
    });

    expect(proxyHarness.adapters.authorizationChecks.map(({ action }) => action)).toEqual([
      "read",
      "write",
    ]);
    expect(hookHarness.adapters.authorizationChecks.map(({ action }) => action)).toEqual([
      "read",
      "write",
    ]);
    expect(createSessionNamespace(proxyIdentity.agentSource, proxyIdentity.sessionId)).not.toBe(
      createSessionNamespace(hookIdentity.agentSource, hookIdentity.sessionId),
    );
  });

  it.each(PARITY_AGENT_SOURCES)(
    "applies the same Team/Agent/Task ACL denial and disabled capability outcome for %s",
    async (agentSource) => {
      const identity = runtimeIdentity(agentSource);
      const deniedHarness = createRuntimeHarness(identity, { authorizationAllowed: false });

      await expect(deniedHarness.runtime.prepareContext({ identity })).rejects.toMatchObject({
        name: MemoryRuntimeAuthorizationError.name,
        action: "read",
        reason: ACL_DENIAL_REASON,
      });
      expect(deniedHarness.adapters.authorizationChecks).toEqual([{
        action: "read",
        identity: boundIdentity(identity),
      }]);

      const disabledHarness = createRuntimeHarness(identity, {
        capabilities: DISABLED_CAPABILITIES,
      });
      const prepared = await disabledHarness.runtime.prepareContext({ identity });
      const result = await disabledHarness.runtime.commitCompletedRound(
        representativeRound(identity),
      );

      expect(prepared.capabilities).toEqual({
        memory: { enabled: false },
        skill: { enabled: false },
        knowledge: { wiki: { enabled: false }, codeGraph: { enabled: false } },
      });
      expect(result).toMatchObject({ status: "skipped", reason: "extraction_disabled" });
      expect(disabledHarness.adapters.enqueuedRounds).toEqual([]);
    },
  );
});

function createRuntimeHarness(
  identity: RuntimeIdentity,
  {
    capabilities,
    authorizationAllowed = true,
  }: RuntimeHarnessOptions = {},
): RuntimeHarness {
  const authorizationDecision: RuntimeAuthorizationDecision = authorizationAllowed
    ? { allowed: true }
    : { allowed: false, reason: ACL_DENIAL_REASON };
  const adapters = new InMemoryMemoryRuntimeAdapters({
    binding: {
      identity: boundIdentity(identity),
      resolution: "recovered",
      agent: PARITY_AGENT,
      task: PARITY_TASK,
    },
    capabilities,
    authorization: {
      read: authorizationDecision,
      write: authorizationDecision,
    },
    context: {
      blocks: CONTEXT_BLOCKS.map((block) => ({ ...block })),
      diagnostics: {
        prewarmed: ["memory", "skill"],
        cacheHits: ["memory", "skill"],
        degraded: [],
      },
    },
  });
  return { runtime: new MemoryRuntime(adapters), adapters };
}

function runtimeIdentity(agentSource: ParityAgentSource): RuntimeIdentity {
  return {
    serviceId: PARITY_IDENTITY.spaceId,
    userId: PARITY_IDENTITY.userId,
    agentSource,
    sessionId: PARITY_IDENTITY.sessionId,
  };
}

function boundIdentity(identity: RuntimeIdentity): BoundRuntimeIdentity {
  return {
    ...identity,
    teamId: PARITY_IDENTITY.teamId,
    agentId: PARITY_IDENTITY.agentId,
    taskId: PARITY_IDENTITY.taskId,
  };
}

function representativeRound(identity: RuntimeIdentity): CommitCompletedRoundInput {
  switch (identity.agentSource) {
    case "codebuddy":
      return representativeProxyRound(identity);
    case "codex":
      return representativeHookRound(identity);
    default:
      throw new TypeError(`unsupported parity agent source: ${identity.agentSource}`);
  }
}

function representativeProxyRound(identity: RuntimeIdentity): CommitCompletedRoundInput {
  const fixture = PROXY_ROUND_INPUTS.find(({ protocol }) => protocol === "openai");
  if (!fixture) throw new TypeError("representative OpenAI fixture is missing");
  const round = buildOpenAICompletedRound({
    identity,
    turnSequence: 1,
    inputMessages: fixture.messages,
    assistantMessage: fixture.assistantMessage,
  });
  if (!round) throw new TypeError("representative proxy fixture did not complete a round");
  return round;
}

function representativeHookRound(identity: RuntimeIdentity): CommitCompletedRoundInput {
  if (identity.agentSource !== "codex") {
    throw new TypeError("representative hook identity must use the Codex namespace");
  }
  return buildCodexCompletedRound({
    identity: {
      ...boundIdentity(identity),
      agentSource: "codex",
      turnId: HOOK_ROUND_INPUT.prompt.turn_id,
    },
    prompt: HOOK_ROUND_INPUT.prompt.prompt,
    tools: HOOK_ROUND_INPUT.tools.map((tool) => ({
      toolUseId: tool.tool_call_id,
      toolName: tool.tool_name,
      input: tool.input,
      output: tool.result,
      failed: tool.failed,
    })),
    finalResponse: HOOK_ROUND_INPUT.stop.assistant,
  });
}

function transportNeutralContext(result: PrepareContextResult) {
  const { agentSource: _agentSource, ...identity } = result.session.identity;
  return {
    ...result,
    session: { ...result.session, identity },
  };
}

function memoryOutcome(round: RuntimeOutboxRound | undefined) {
  if (!round) throw new TypeError("runtime did not enqueue the representative round");
  return {
    l0: round.l0,
    skill: round.skill,
    channels: round.channels,
  };
}

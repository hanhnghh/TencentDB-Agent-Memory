import { describe, expect, it } from "vitest";

import { createSessionNamespace } from "../../agent-sources.js";
import { buildCodexCompletedRound } from "../../codex/round-normalizer.js";
import {
  InMemoryMemoryRuntimeAdapters,
  MemoryRuntime,
  MemoryRuntimeAuthorizationError,
  type CommitCompletedRoundInput,
  type PrepareContextResult,
  type RuntimeCapabilityFlags,
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

const CONTEXT_BLOCKS = [
  {
    id: "memory",
    sourceHookId: "tdai-profile-memory-injector",
    kind: "memory" as const,
    order: 10,
    type: "text" as const,
    content: "Remember the shared release decision.",
  },
  {
    id: "skill",
    sourceHookId: "skill-injector",
    kind: "skill" as const,
    order: 20,
    type: "text" as const,
    content: "Use the verified deployment checklist.",
  },
] as const;

describe("proxy/hooks end-to-end memory parity", () => {
  it("produces equivalent prepared context, L0 pair, and normalized skill round", async () => {
    const proxyIdentity = runtimeIdentity("codebuddy");
    const hookIdentity = runtimeIdentity("codex");
    const proxy = harness(proxyIdentity);
    const hooks = harness(hookIdentity);

    const proxyPrepared = await proxy.runtime.prepareContext({ identity: proxyIdentity });
    const hookPrepared = await hooks.runtime.prepareContext({ identity: hookIdentity });
    const proxyRound = representativeProxyRound(proxyIdentity);
    const hookRound = representativeHookRound(hookIdentity);

    await proxy.runtime.commitCompletedRound(proxyRound);
    await hooks.runtime.commitCompletedRound(hookRound);

    expect(transportNeutralContext(proxyPrepared)).toEqual(transportNeutralContext(hookPrepared));
    expect(memoryOutcome(proxy.adapters.enqueuedRounds[0])).toEqual(
      memoryOutcome(hooks.adapters.enqueuedRounds[0]),
    );
    expect(memoryOutcome(proxy.adapters.enqueuedRounds[0])).toEqual({
      l0: {
        messages: [
          { role: "user", content: HOOK_ROUND_INPUT.prompt.prompt },
          { role: "assistant", content: HOOK_ROUND_INPUT.stop.assistant },
        ],
      },
      skill: { messages: COMPLETED_ROUND_GOLDEN },
      channels: { l0: true, skill: true },
    });

    expect(proxy.adapters.authorizationChecks.map(({ action }) => action)).toEqual(["read", "write"]);
    expect(hooks.adapters.authorizationChecks.map(({ action }) => action)).toEqual(["read", "write"]);
    expect(createSessionNamespace(proxyIdentity.agentSource, proxyIdentity.sessionId)).not.toBe(
      createSessionNamespace(hookIdentity.agentSource, hookIdentity.sessionId),
    );
  });

  it("applies the same Team/Agent/Task ACL denial and disabled capability outcome", async () => {
    for (const agentSource of ["codebuddy", "codex"] as const) {
      const identity = runtimeIdentity(agentSource);
      const denied = harness(identity, undefined, false);

      await expect(denied.runtime.prepareContext({ identity })).rejects.toMatchObject({
        name: MemoryRuntimeAuthorizationError.name,
        action: "read",
        reason: "fixture_denied",
      });
      expect(denied.adapters.authorizationChecks).toEqual([{
        action: "read",
        identity: boundIdentity(identity),
      }]);

      const disabled = harness(identity, {
        skill: false,
        llmWiki: false,
        codeGraph: false,
        chatMemory: false,
      });
      const prepared = await disabled.runtime.prepareContext({ identity });
      const result = await disabled.runtime.commitCompletedRound(
        agentSource === "codex"
          ? representativeHookRound(identity)
          : representativeProxyRound(identity),
      );

      expect(prepared.capabilities).toEqual({
        memory: { enabled: false },
        skill: { enabled: false },
        knowledge: { wiki: { enabled: false }, codeGraph: { enabled: false } },
      });
      expect(result).toMatchObject({ status: "skipped", reason: "extraction_disabled" });
      expect(disabled.adapters.enqueuedRounds).toEqual([]);
    }
  });
});

function harness(
  identity: RuntimeIdentity,
  capabilities?: RuntimeCapabilityFlags,
  allowed = true,
): { runtime: MemoryRuntime; adapters: InMemoryMemoryRuntimeAdapters } {
  const adapters = new InMemoryMemoryRuntimeAdapters({
    binding: {
      identity: boundIdentity(identity),
      resolution: "recovered",
      agent: PARITY_AGENT,
      task: PARITY_TASK,
    },
    ...(capabilities === undefined ? {} : { capabilities }),
    authorization: {
      read: allowed ? { allowed: true } : { allowed: false, reason: "fixture_denied" },
      write: allowed ? { allowed: true } : { allowed: false, reason: "fixture_denied" },
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

function runtimeIdentity(agentSource: "codebuddy" | "codex"): RuntimeIdentity {
  return {
    serviceId: PARITY_IDENTITY.spaceId,
    userId: PARITY_IDENTITY.userId,
    agentSource,
    sessionId: PARITY_IDENTITY.sessionId,
  };
}

function boundIdentity(identity: RuntimeIdentity) {
  return {
    ...identity,
    teamId: PARITY_IDENTITY.teamId,
    agentId: PARITY_IDENTITY.agentId,
    taskId: PARITY_IDENTITY.taskId,
  };
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

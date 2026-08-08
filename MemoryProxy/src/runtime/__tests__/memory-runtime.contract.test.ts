import { describe, expect, it } from "vitest";

import {
  InMemoryMemoryRuntimeAdapters,
  MemoryRuntime,
  MemoryRuntimeAuthorizationError,
  MemoryRuntimeBindingError,
  type MemoryRuntimeContract,
} from "../index.js";
import {
  COMPLETED_ROUND_GOLDEN,
  HOOK_ROUND_INPUT,
  NORMALIZATION_SCENARIOS,
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_TASK,
} from "../../__tests__/memory-parity/fixtures.js";

describe("MemoryRuntime contract", () => {
  it("prepares transport-neutral context through binding, ACL, capability, and cache ports", async () => {
    const boundIdentity = {
      serviceId: PARITY_IDENTITY.spaceId,
      teamId: PARITY_IDENTITY.teamId,
      userId: PARITY_IDENTITY.userId,
      agentId: PARITY_IDENTITY.agentId,
      taskId: PARITY_IDENTITY.taskId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    };
    const adapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: boundIdentity,
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        resolution: "recovered",
      },
      capabilities: {
        skill: true,
        llmWiki: false,
        codeGraph: true,
        chatMemory: true,
      },
      context: {
        blocks: [
          { id: "graph", kind: "knowledge", type: "text", content: "graph context", order: 30 },
          { id: "skill", kind: "skill", type: "text", content: "skill context", order: 20 },
          { id: "memory", kind: "memory", type: "text", content: "memory context", order: 10 },
        ],
        diagnostics: {
          prewarmed: ["memory", "skill", "graph"],
          cacheHits: ["memory", "skill", "graph"],
          degraded: [],
        },
      },
    });
    const runtime: MemoryRuntimeContract = new MemoryRuntime(adapters);

    const result = await runtime.prepareContext({
      identity: {
        serviceId: PARITY_IDENTITY.spaceId,
        userId: PARITY_IDENTITY.userId,
        agentSource: PARITY_IDENTITY.agentSource,
        sessionId: PARITY_IDENTITY.sessionId,
      },
    });

    expect(result.session).toEqual({
      identity: boundIdentity,
      agent: PARITY_AGENT,
      task: PARITY_TASK,
    });
    expect(result.blocks.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "memory", content: "memory context" },
      { kind: "skill", content: "skill context" },
      { kind: "knowledge", content: "graph context" },
    ]);
    expect(result.capabilities).toEqual({
      memory: { enabled: true },
      skill: { enabled: true },
      knowledge: {
        wiki: { enabled: false },
        codeGraph: { enabled: true },
      },
    });
    expect(result.diagnostics).toEqual({
      binding: "recovered",
      prewarmed: ["memory", "skill", "graph"],
      cacheHits: ["memory", "skill", "graph"],
      degraded: [],
    });
    expect(adapters.authorizationChecks).toEqual([{
      action: "read",
      identity: boundIdentity,
    }]);
  });

  it("commits the golden completed round as one L0 pair and one tool-aware skill round", async () => {
    const boundIdentity = {
      serviceId: PARITY_IDENTITY.spaceId,
      teamId: PARITY_IDENTITY.teamId,
      userId: PARITY_IDENTITY.userId,
      agentId: PARITY_IDENTITY.agentId,
      taskId: PARITY_IDENTITY.taskId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    };
    const adapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: boundIdentity,
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        resolution: "cached",
      },
    });
    const runtime: MemoryRuntimeContract = new MemoryRuntime(adapters);

    const result = await runtime.commitCompletedRound({
      sourceEventId: "codex:round:fixture",
      identity: {
        serviceId: PARITY_IDENTITY.spaceId,
        userId: PARITY_IDENTITY.userId,
        agentSource: PARITY_IDENTITY.agentSource,
        sessionId: PARITY_IDENTITY.sessionId,
        turnId: HOOK_ROUND_INPUT.prompt.turn_id,
      },
      realPrompt: HOOK_ROUND_INPUT.prompt.prompt,
      events: HOOK_ROUND_INPUT.tools.flatMap((tool) => [
        {
          type: "tool_call" as const,
          toolCallId: tool.tool_call_id,
          toolName: tool.tool_name,
          input: tool.input,
        },
        {
          type: "tool_result" as const,
          toolCallId: tool.tool_call_id,
          content: tool.result,
          failed: tool.failed,
        },
      ]),
      finalResponse: HOOK_ROUND_INPUT.stop.assistant,
    });

    expect(result).toMatchObject({ status: "enqueued" });
    expect(adapters.enqueuedRounds).toEqual([{
      sourceEventId: "codex:round:fixture",
      identity: { ...boundIdentity, turnId: HOOK_ROUND_INPUT.prompt.turn_id },
      l0: {
        messages: [
          { role: "user", content: HOOK_ROUND_INPUT.prompt.prompt },
          { role: "assistant", content: HOOK_ROUND_INPUT.stop.assistant },
        ],
      },
      skill: { messages: COMPLETED_ROUND_GOLDEN },
      channels: { l0: true, skill: true },
    }]);
    expect(adapters.authorizationChecks.at(-1)).toEqual({
      action: "write",
      identity: boundIdentity,
    });
  });

  it.each(NORMALIZATION_SCENARIOS)(
    "passes the $id characterization fixture through the runtime seam",
    async (scenario) => {
      const boundIdentity = {
        serviceId: PARITY_IDENTITY.spaceId,
        teamId: PARITY_IDENTITY.teamId,
        userId: PARITY_IDENTITY.userId,
        agentId: PARITY_IDENTITY.agentId,
        taskId: PARITY_IDENTITY.taskId,
        agentSource: PARITY_IDENTITY.agentSource,
        sessionId: PARITY_IDENTITY.sessionId,
      };
      const adapters = new InMemoryMemoryRuntimeAdapters({
        binding: {
          identity: boundIdentity,
          agent: PARITY_AGENT,
          task: PARITY_TASK,
          resolution: "cached",
        },
      });
      const runtime = new MemoryRuntime(adapters);
      const hook = scenario.hookInput;

      await runtime.commitCompletedRound({
        sourceEventId: `codex:round:${scenario.id}`,
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          userId: PARITY_IDENTITY.userId,
          agentSource: PARITY_IDENTITY.agentSource,
          sessionId: PARITY_IDENTITY.sessionId,
          turnId: hook.prompt.turn_id,
        },
        realPrompt: hook.prompt.prompt,
        events: [
          ...hook.tools.map((tool) => ({
            type: "tool_call" as const,
            toolCallId: tool.tool_call_id,
            toolName: tool.tool_name,
            input: tool.input,
          })),
          ...hook.tools.map((tool) => ({
            type: "tool_result" as const,
            toolCallId: tool.tool_call_id,
            content: tool.result,
            failed: tool.failed,
          })),
        ],
        finalResponse: hook.stop.assistant,
      });

      expect(adapters.enqueuedRounds[0].skill.messages).toEqual(scenario.golden);
    },
  );

  it("applies capability and extraction gates before durable enqueue", async () => {
    const boundIdentity = {
      serviceId: PARITY_IDENTITY.spaceId,
      teamId: PARITY_IDENTITY.teamId,
      userId: PARITY_IDENTITY.userId,
      agentId: PARITY_IDENTITY.agentId,
      taskId: PARITY_IDENTITY.taskId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    };
    const adapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: boundIdentity,
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        resolution: "cached",
      },
      capabilities: {
        skill: false,
        llmWiki: true,
        codeGraph: true,
        chatMemory: true,
      },
      extraction: { l0: true, skill: true },
    });
    const runtime = new MemoryRuntime(adapters);

    await runtime.commitCompletedRound({
      sourceEventId: "codex:round:l0-only",
      identity: {
        serviceId: boundIdentity.serviceId,
        userId: boundIdentity.userId,
        agentSource: boundIdentity.agentSource,
        sessionId: boundIdentity.sessionId,
        turnId: "turn-l0-only",
      },
      realPrompt: "remember this",
      events: [],
      finalResponse: "remembered",
    });

    expect(adapters.enqueuedRounds[0].channels).toEqual({ l0: true, skill: false });
  });

  it("returns an explicit skipped result when every extraction channel is disabled", async () => {
    const boundIdentity = {
      serviceId: PARITY_IDENTITY.spaceId,
      teamId: PARITY_IDENTITY.teamId,
      userId: PARITY_IDENTITY.userId,
      agentId: PARITY_IDENTITY.agentId,
      taskId: PARITY_IDENTITY.taskId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    };
    const adapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: boundIdentity,
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        resolution: "cached",
      },
      extraction: { l0: false, skill: false, reason: "configured_off" },
    });

    await expect(new MemoryRuntime(adapters).commitCompletedRound({
      sourceEventId: "codex:round:skipped",
      identity: {
        serviceId: boundIdentity.serviceId,
        userId: boundIdentity.userId,
        agentSource: boundIdentity.agentSource,
        sessionId: boundIdentity.sessionId,
        turnId: "turn-skipped",
      },
      realPrompt: "do not persist",
      events: [],
      finalResponse: "not persisted",
    })).resolves.toEqual({
      status: "skipped",
      sourceEventId: "codex:round:skipped",
      reason: "configured_off",
    });
    expect(adapters.enqueuedRounds).toEqual([]);
  });

  it("fails closed for a denied write and rejects a cross-session binding", async () => {
    const boundIdentity = {
      serviceId: PARITY_IDENTITY.spaceId,
      teamId: PARITY_IDENTITY.teamId,
      userId: PARITY_IDENTITY.userId,
      agentId: PARITY_IDENTITY.agentId,
      taskId: PARITY_IDENTITY.taskId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    };
    const deniedAdapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: boundIdentity,
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        resolution: "cached",
      },
      authorization: { write: { allowed: false, reason: "team_scope_denied" } },
    });
    const input = {
      sourceEventId: "codex:round:denied",
      identity: {
        serviceId: boundIdentity.serviceId,
        userId: boundIdentity.userId,
        agentSource: boundIdentity.agentSource,
        sessionId: boundIdentity.sessionId,
        turnId: "turn-denied",
      },
      realPrompt: "private prompt",
      events: [],
      finalResponse: "private response",
    };

    await expect(new MemoryRuntime(deniedAdapters).commitCompletedRound(input))
      .rejects.toBeInstanceOf(MemoryRuntimeAuthorizationError);
    expect(deniedAdapters.enqueuedRounds).toEqual([]);

    const mismatchedAdapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: { ...boundIdentity, sessionId: "another-session" },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        resolution: "recovered",
      },
    });
    await expect(new MemoryRuntime(mismatchedAdapters).prepareContext({
      identity: {
        serviceId: boundIdentity.serviceId,
        userId: boundIdentity.userId,
        agentSource: boundIdentity.agentSource,
        sessionId: boundIdentity.sessionId,
      },
    })).rejects.toBeInstanceOf(MemoryRuntimeBindingError);
    expect(mismatchedAdapters.authorizationChecks).toEqual([]);
  });

  it("rejects an unpaired tool result before durable enqueue", async () => {
    const boundIdentity = {
      serviceId: PARITY_IDENTITY.spaceId,
      teamId: PARITY_IDENTITY.teamId,
      userId: PARITY_IDENTITY.userId,
      agentId: PARITY_IDENTITY.agentId,
      taskId: PARITY_IDENTITY.taskId,
      agentSource: PARITY_IDENTITY.agentSource,
      sessionId: PARITY_IDENTITY.sessionId,
    };
    const adapters = new InMemoryMemoryRuntimeAdapters({
      binding: {
        identity: boundIdentity,
        agent: PARITY_AGENT,
        task: PARITY_TASK,
        resolution: "cached",
      },
    });

    await expect(new MemoryRuntime(adapters).commitCompletedRound({
      sourceEventId: "codex:round:unpaired-tool",
      identity: {
        serviceId: boundIdentity.serviceId,
        userId: boundIdentity.userId,
        agentSource: boundIdentity.agentSource,
        sessionId: boundIdentity.sessionId,
        turnId: "turn-unpaired-tool",
      },
      realPrompt: "run it",
      events: [{
        type: "tool_result",
        toolCallId: "missing-call",
        content: "orphan result",
        failed: true,
      }],
      finalResponse: "done",
    })).rejects.toThrow(/matching tool call/);
    expect(adapters.enqueuedRounds).toEqual([]);
  });
});

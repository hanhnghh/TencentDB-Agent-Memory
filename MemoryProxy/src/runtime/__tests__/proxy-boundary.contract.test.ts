import { describe, expect, it } from "vitest";

import {
  MemoryRuntimeAuthorizationError,
  MemoryRuntimeBindingError,
  MemoryRuntimeContextError,
  type PrepareContextResult,
} from "../index.js";
import {
  classifyMemoryRuntimePrepareError,
  sessionInfoFromRuntime,
} from "../proxy-boundary.js";
import {
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_TASK,
} from "../../__tests__/memory-parity/fixtures.js";

describe("proxy MemoryRuntime boundary", () => {
  it.each([
    new MemoryRuntimeAuthorizationError("read", "denied"),
    new MemoryRuntimeBindingError("binding_mismatch"),
  ])("classifies typed access failures as forbidden", (error) => {
    expect(classifyMemoryRuntimePrepareError(error)).toEqual({
      kind: "forbidden",
      error,
    });
  });

  it("classifies context preparation failures as degradable", () => {
    const error = new MemoryRuntimeContextError(new Error("cache unavailable"));

    expect(classifyMemoryRuntimePrepareError(error)).toEqual({
      kind: "degraded",
      error,
    });
  });

  it("classifies unexpected provider failures as unavailable, not forbidden", () => {
    const error = new Error("capability backend unavailable");

    expect(classifyMemoryRuntimePrepareError(error)).toEqual({
      kind: "unavailable",
      error,
    });
  });

  it("maps a prepared runtime binding to transport session metadata", () => {
    const prepared: PrepareContextResult = {
      session: {
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          userId: PARITY_IDENTITY.userId,
          teamId: PARITY_IDENTITY.teamId,
          agentId: PARITY_IDENTITY.agentId,
          taskId: PARITY_IDENTITY.taskId,
          agentSource: PARITY_IDENTITY.agentSource,
          sessionId: PARITY_IDENTITY.sessionId,
        },
        agent: PARITY_AGENT,
        task: PARITY_TASK,
      },
      blocks: [],
      capabilities: {
        memory: { enabled: true },
        skill: { enabled: true },
        knowledge: { wiki: { enabled: false }, codeGraph: { enabled: false } },
      },
      diagnostics: {
        binding: "cached",
        prewarmed: [],
        cacheHits: [],
        degraded: [],
      },
    };

    expect(sessionInfoFromRuntime(prepared)).toEqual({
      session_id: PARITY_IDENTITY.sessionId,
      space_id: PARITY_IDENTITY.spaceId,
      user_id: PARITY_IDENTITY.userId,
      team_id: PARITY_IDENTITY.teamId,
      agent_id: PARITY_IDENTITY.agentId,
      task_id: PARITY_IDENTITY.taskId,
      identity_verified: true,
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { KvBindingRepo } from "../../db/kv-binding-repo.js";
import { KvSessionRepo } from "../../db/kv-session-repo.js";
import { injectSessionContext } from "../../session/context-injector.js";
import { SessionStore } from "../../session/store.js";
import { MemoryStorage } from "../../storage/memory-storage.js";
import { MetadataClient } from "../../meta/client.js";
import type { SessionInitState } from "../../session/types.js";
import {
  OTHER_PARITY_IDENTITY,
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_SESSION_INFO,
  PARITY_TASK,
} from "./fixtures.js";

type ParityIdentity = {
  [Key in keyof typeof PARITY_IDENTITY]: string;
};

function initializedState(
  keyId: string,
  identity: ParityIdentity = PARITY_IDENTITY,
): SessionInitState {
  return {
    status: "initialized",
    keyId,
    startedAt: 1,
    attemptCount: 0,
    userId: identity.userId,
    sessionInfo: {
      ...PARITY_SESSION_INFO,
      session_id: identity.sessionId,
      space_id: identity.spaceId,
      user_id: identity.userId,
      team_id: identity.teamId,
      agent_id: identity.agentId,
      task_id: identity.taskId,
    },
    agentDetail: { ...PARITY_AGENT, id: identity.agentId },
    taskDetail: { ...PARITY_TASK, id: identity.taskId },
  };
}

describe("memory parity: identity and binding", () => {
  it("isolates the same session id across space, user, and agent-source identity", async () => {
    const storage = new MemoryStorage();
    const repo = new KvSessionRepo(storage);
    const first = initializedState("claude-code:session-shared", PARITY_IDENTITY);
    const second = initializedState("codebuddy:session-shared", OTHER_PARITY_IDENTITY);

    await repo.upsert(
      PARITY_IDENTITY.spaceId,
      PARITY_IDENTITY.userId,
      PARITY_IDENTITY.agentSource,
      PARITY_IDENTITY.sessionId,
      first,
    );
    await repo.upsert(
      OTHER_PARITY_IDENTITY.spaceId,
      OTHER_PARITY_IDENTITY.userId,
      OTHER_PARITY_IDENTITY.agentSource,
      OTHER_PARITY_IDENTITY.sessionId,
      second,
    );

    await expect(repo.getBySessionId(
      PARITY_IDENTITY.spaceId,
      PARITY_IDENTITY.userId,
      PARITY_IDENTITY.agentSource,
      PARITY_IDENTITY.sessionId,
    )).resolves.toEqual(first);
    await expect(repo.getBySessionId(
      OTHER_PARITY_IDENTITY.spaceId,
      OTHER_PARITY_IDENTITY.userId,
      OTHER_PARITY_IDENTITY.agentSource,
      OTHER_PARITY_IDENTITY.sessionId,
    )).resolves.toEqual(second);
    await expect(repo.getBySessionId(
      PARITY_IDENTITY.spaceId,
      OTHER_PARITY_IDENTITY.userId,
      PARITY_IDENTITY.agentSource,
      PARITY_IDENTITY.sessionId,
    )).resolves.toBeNull();
    await expect(repo.getBySessionId(
      OTHER_PARITY_IDENTITY.spaceId,
      PARITY_IDENTITY.userId,
      PARITY_IDENTITY.agentSource,
      PARITY_IDENTITY.sessionId,
    )).resolves.toBeNull();
    await expect(repo.getBySessionId(
      PARITY_IDENTITY.spaceId,
      PARITY_IDENTITY.userId,
      OTHER_PARITY_IDENTITY.agentSource,
      PARITY_IDENTITY.sessionId,
    )).resolves.toBeNull();
    await expect(repo.getBySessionId(
      PARITY_IDENTITY.spaceId,
      PARITY_IDENTITY.userId,
      PARITY_IDENTITY.agentSource,
      "another-session",
    )).resolves.toBeNull();
  });

  it("recovers the approved Team/Agent/Task binding without a remote service", async () => {
    const storage = new MemoryStorage();
    const bindingRepo = new KvBindingRepo(storage);
    await bindingRepo.putBinding(
      PARITY_IDENTITY.spaceId,
      PARITY_IDENTITY.userId,
      PARITY_IDENTITY.agentSource,
      PARITY_IDENTITY.sessionId,
      {
        outcome: "initialized",
        userId: PARITY_IDENTITY.userId,
        teamId: PARITY_IDENTITY.teamId,
        agentId: PARITY_IDENTITY.agentId,
        taskId: PARITY_IDENTITY.taskId,
      },
    );
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      const data = url.endsWith("/v3/meta/agent/get")
        ? {
            agent_id: PARITY_IDENTITY.agentId,
            team_id: PARITY_IDENTITY.teamId,
            name: PARITY_AGENT.name,
            description: PARITY_AGENT.description,
            prompt: PARITY_AGENT.prompt,
          }
        : {
            task_id: PARITY_IDENTITY.taskId,
            team_id: PARITY_IDENTITY.teamId,
            title: PARITY_TASK.name,
            description: PARITY_TASK.description,
          };
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const metadataClient = new MetadataClient(
      {
        endpoint: "http://metadata.fixture",
        serviceToken: "fixture-token",
        timeoutMs: 1_000,
      },
      PARITY_IDENTITY.spaceId,
      "user-key",
      vi.fn(fetcher),
    );
    const getAgent = vi.spyOn(metadataClient, "getAgent");
    const getTask = vi.spyOn(metadataClient, "getTask");
    const store = new SessionStore(30 * 60 * 1000, undefined, bindingRepo);

    const recovered = await store.getOrRecover(
      `${PARITY_IDENTITY.agentSource}:${PARITY_IDENTITY.sessionId}`,
      {
        spaceId: PARITY_IDENTITY.spaceId,
        userId: PARITY_IDENTITY.userId,
        agentSource: PARITY_IDENTITY.agentSource,
        sessionId: PARITY_IDENTITY.sessionId,
      },
      { metadataClient },
    );

    expect(recovered).toMatchObject({
      status: "initialized",
      bypassed: false,
      sessionInfo: {
        session_id: PARITY_IDENTITY.sessionId,
        user_id: PARITY_IDENTITY.userId,
        team_id: PARITY_IDENTITY.teamId,
        agent_id: PARITY_IDENTITY.agentId,
        task_id: PARITY_IDENTITY.taskId,
      },
      agentDetail: { id: PARITY_IDENTITY.agentId },
      taskDetail: { id: PARITY_IDENTITY.taskId },
    });
    expect(getAgent).toHaveBeenCalledWith(PARITY_IDENTITY.agentId);
    expect(getTask).toHaveBeenCalledWith(PARITY_IDENTITY.taskId);
  });

  it("injects Agent before Task in a stable, delimited context block", () => {
    const result = injectSessionContext(
      [{ role: "system", content: "base system" }, { role: "user", content: "hello" }],
      PARITY_AGENT,
      PARITY_TASK,
    );

    expect(result[0].content).toBe(
      "base system\n\n" +
      "<session_context>\n" +
      "[Agent]\n" +
      `id: ${PARITY_AGENT.id}\n` +
      `name: ${PARITY_AGENT.name}\n` +
      `description: ${PARITY_AGENT.description}\n` +
      "prompt:\n" +
      `${PARITY_AGENT.prompt}\n\n` +
      "[Task]\n" +
      `id: ${PARITY_TASK.id}\n` +
      `name: ${PARITY_TASK.name}\n` +
      `description: ${PARITY_TASK.description}\n` +
      "goal:\n" +
      `${PARITY_TASK.goal}\n` +
      "</session_context>",
    );
  });
});

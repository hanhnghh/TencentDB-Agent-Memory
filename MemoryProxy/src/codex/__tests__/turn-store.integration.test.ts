import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexTurnConflictError,
  openDurableCodexTurnStore,
} from "../turn-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable Codex turn store", () => {
  it("recovers an exact prompt after close and treats identical delivery as idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-turn-store-"));
    roots.push(root);
    const dbPath = join(root, "turns.db");
    const input = {
      identity: {
        serviceId: "memory-1",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        taskId: "task-1",
        agentSource: "codex" as const,
        sessionId: "session-1",
        turnId: "turn-1",
      },
      prompt: "real prompt with Unicode: xin chào",
    };

    const first = openDurableCodexTurnStore({ dbPath });
    await expect(first.beginTurn(input)).resolves.toEqual({ status: "persisted" });
    first.close();

    const reopened = openDurableCodexTurnStore({ dbPath });
    await expect(reopened.beginTurn(input)).resolves.toEqual({ status: "duplicate" });
    await expect(reopened.getTurn(input.identity)).resolves.toMatchObject(input);
    reopened.close();
  });

  it("rejects reuse of a session/turn identity with different prompt content", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-turn-conflict-"));
    roots.push(root);
    const store = openDurableCodexTurnStore({ dbPath: join(root, "turns.db") });
    const identity = {
      serviceId: "memory-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      taskId: "task-1",
      agentSource: "codex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
    };
    await store.beginTurn({ identity, prompt: "first prompt" });

    await expect(store.beginTurn({ identity, prompt: "different prompt" }))
      .rejects.toBeInstanceOf(CodexTurnConflictError);
    store.close();
  });

  it("recovers prompt and ordered tool events after restart before Stop closes the round", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-turn-replay-"));
    roots.push(root);
    const dbPath = join(root, "turns.db");
    const identity = {
      serviceId: "memory-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      taskId: "task-1",
      agentSource: "codex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
    };
    const first = openDurableCodexTurnStore({ dbPath });
    await first.beginTurn({ identity, prompt: "Giữ Unicode 🧠 và `code`." });
    await expect(first.appendToolEvent({
      identity,
      toolUseId: "call-shell",
      toolName: "exec_command",
      input: { cmd: "false" },
      output: "Process exited with code 1\nFinal output:\n",
      failed: true,
    })).resolves.toEqual({ status: "persisted" });
    await first.appendToolEvent({
      identity,
      toolUseId: "call-patch",
      toolName: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
      output: "Done!",
      failed: false,
    });
    first.close();

    const reopened = openDurableCodexTurnStore({ dbPath });
    await expect(reopened.recordStop({
      identity,
      finalResponse: "Đã hoàn thành.",
    })).resolves.toMatchObject({
      status: "persisted",
      committed: false,
      round: {
        identity,
        prompt: "Giữ Unicode 🧠 và `code`.",
        tools: [
          {
            toolUseId: "call-shell",
            toolName: "exec_command",
            input: { cmd: "false" },
            output: "Process exited with code 1\nFinal output:\n",
            failed: true,
          },
          {
            toolUseId: "call-patch",
            toolName: "apply_patch",
            input: "*** Begin Patch\n*** End Patch",
            output: "Done!",
            failed: false,
          },
        ],
        finalResponse: "Đã hoàn thành.",
      },
    });
    reopened.close();
  });

  it("deduplicates tool and Stop redelivery but rejects conflicting payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-turn-events-"));
    roots.push(root);
    const store = openDurableCodexTurnStore({ dbPath: join(root, "turns.db") });
    const identity = {
      serviceId: "memory-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      taskId: "task-1",
      agentSource: "codex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
    };
    const tool = {
      identity,
      toolUseId: "call-mcp",
      toolName: "mcp__memory__search",
      input: { query: "release" },
      output: "{\"content\":[{\"type\":\"text\",\"text\":\"found\"}]}",
      failed: false,
    };
    await store.beginTurn({ identity, prompt: "Find the release note." });

    await expect(store.appendToolEvent(tool)).resolves.toEqual({ status: "persisted" });
    await expect(store.appendToolEvent(tool)).resolves.toEqual({ status: "duplicate" });
    await expect(store.appendToolEvent({ ...tool, output: "different" }))
      .rejects.toBeInstanceOf(CodexTurnConflictError);

    const stop = { identity, finalResponse: "Found it." };
    await expect(store.recordStop(stop)).resolves.toMatchObject({ status: "persisted" });
    await expect(store.recordStop(stop)).resolves.toMatchObject({ status: "duplicate" });
    await expect(store.appendToolEvent(tool)).resolves.toEqual({ status: "duplicate" });
    await expect(store.appendToolEvent({
      ...tool,
      toolUseId: "call-after-stop",
    })).rejects.toBeInstanceOf(CodexTurnConflictError);
    await expect(store.recordStop({ ...stop, finalResponse: "Different answer." }))
      .rejects.toBeInstanceOf(CodexTurnConflictError);
    await expect(store.markCommitted(identity)).resolves.toEqual({ status: "committed" });
    await expect(store.recordStop(stop)).resolves.toMatchObject({
      status: "duplicate",
      committed: true,
    });
    store.close();
  });

  it("isolates the same session and turn across the complete binding identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-turn-scope-"));
    roots.push(root);
    const store = openDurableCodexTurnStore({ dbPath: join(root, "turns.db") });
    const firstIdentity = {
      serviceId: "memory-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      taskId: "task-1",
      agentSource: "codex" as const,
      sessionId: "shared-session",
      turnId: "shared-turn",
    };
    const secondIdentity = {
      ...firstIdentity,
      teamId: "team-2",
      agentId: "agent-2",
      taskId: "task-2",
    };

    await expect(store.beginTurn({ identity: firstIdentity, prompt: "first scope" }))
      .resolves.toEqual({ status: "persisted" });
    await expect(store.beginTurn({ identity: secondIdentity, prompt: "second scope" }))
      .resolves.toEqual({ status: "persisted" });
    await expect(store.getTurn(firstIdentity)).resolves.toMatchObject({ prompt: "first scope" });
    await expect(store.getTurn(secondIdentity)).resolves.toMatchObject({ prompt: "second scope" });
    store.close();
  });

  it("serializes concurrent duplicate and tool-vs-Stop writes across store connections", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-turn-concurrency-"));
    roots.push(root);
    const dbPath = join(root, "turns.db");
    const first = openDurableCodexTurnStore({ dbPath });
    const second = openDurableCodexTurnStore({ dbPath });
    const identity = {
      serviceId: "memory-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      taskId: "task-1",
      agentSource: "codex" as const,
      sessionId: "session-1",
      turnId: "turn-concurrent",
    };
    const tool = {
      identity,
      toolUseId: "call-shared",
      toolName: "exec_command",
      input: { cmd: "pwd" },
      output: "/workspace",
      failed: false,
    };
    await first.beginTurn({ identity, prompt: "concurrent prompt" });

    await expect(Promise.all([
      first.appendToolEvent(tool),
      second.appendToolEvent(tool),
    ])).resolves.toEqual(expect.arrayContaining([
      { status: "persisted" },
      { status: "duplicate" },
    ]));

    const closingIdentity = { ...identity, turnId: "turn-closing" };
    await first.beginTurn({ identity: closingIdentity, prompt: "closing prompt" });
    const [stopResult, lateToolResult] = await Promise.allSettled([
      first.recordStop({ identity: closingIdentity, finalResponse: "closed" }),
      second.appendToolEvent({ ...tool, identity: closingIdentity, toolUseId: "call-late" }),
    ]);
    expect(stopResult.status).toBe("fulfilled");
    expect(lateToolResult.status).toBe("rejected");
    if (lateToolResult.status === "rejected") {
      expect(lateToolResult.reason).toBeInstanceOf(CodexTurnConflictError);
    }
    await expect(first.recordStop({ identity: closingIdentity, finalResponse: "closed" }))
      .resolves.toMatchObject({ round: { tools: [] } });
    first.close();
    second.close();
  });

  it("does not change permissions on a caller-owned database directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-turn-permissions-"));
    roots.push(root);
    await chmod(root, 0o755);

    const store = openDurableCodexTurnStore({ dbPath: join(root, "turns.db") });

    expect((await stat(root)).mode & 0o777).toBe(0o755);
    expect((await stat(join(root, "turns.db"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "turns.db-wal"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "turns.db-shm"))).mode & 0o777).toBe(0o600);
    store.close();
  });
});

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

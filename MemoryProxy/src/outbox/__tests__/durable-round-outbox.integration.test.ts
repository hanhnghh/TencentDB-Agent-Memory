import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OutboxConflictError,
  openDurableRoundOutbox,
  type CompletedRound,
  type DeliveryReceipt,
  type RoundDeliveryPort,
} from "../index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outboxPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-round-outbox-"));
  tempRoots.push(root);
  return join(root, "outbox.db");
}

function round(overrides: Partial<CompletedRound> = {}): CompletedRound {
  return {
    sourceEventId: "codex:session-1:turn-1",
    identity: {
      serviceId: "space-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      taskId: "task-1",
      agentSource: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    l0: {
      messages: [
        { role: "user", content: "Remember this" },
        { role: "assistant", content: "I will" },
      ],
    },
    skill: {
      messages: [
        { role: "user", content: "Remember this" },
        { role: "assistant", content: "I will" },
      ],
    },
    ...overrides,
  };
}

function delivery(): RoundDeliveryPort {
  return {
    deliverL0: vi.fn(),
    deliverSkill: vi.fn(),
  };
}

function receipt(sourceEventId: string, contentHash: string): DeliveryReceipt {
  return {
    sourceEventId,
    contentHash,
    receiptId: `receipt:${sourceEventId}`,
    status: "committed",
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("durable completed-round outbox", () => {
  it("persists a completed round before acknowledging enqueue and recovers it after restart", async () => {
    const dbPath = await outboxPath();
    const first = openDurableRoundOutbox({ dbPath, delivery: delivery() });

    const accepted = await first.enqueue(round());
    expect(accepted).toMatchObject({ sourceEventId: "codex:session-1:turn-1", state: "pending" });
    expect(await first.health()).toMatchObject({ pendingCount: 1, deadCount: 0 });
    first.close();

    const restarted = openDurableRoundOutbox({ dbPath, delivery: delivery() });
    expect(await restarted.get("codex:session-1:turn-1")).toMatchObject({
      sourceEventId: "codex:session-1:turn-1",
      state: "pending",
      attemptCount: 0,
    });
    expect(await restarted.health()).toMatchObject({ pendingCount: 1, deadCount: 0 });
    restarted.close();
  });

  it("returns the existing record for an exact enqueue replay and rejects changed content", async () => {
    const dbPath = await outboxPath();
    const outbox = openDurableRoundOutbox({ dbPath, delivery: delivery() });

    const initial = await outbox.enqueue(round());
    const duplicate = await outbox.enqueue(round());
    expect(duplicate).toEqual(initial);
    const replayWithDifferentCallerId = await outbox.enqueue(round({ sourceEventId: "caller-rebuilt-id" }));
    expect(replayWithDifferentCallerId).toEqual(initial);

    await expect(outbox.enqueue(round({
      l0: { messages: [{ role: "user", content: "different content" }] },
    }))).rejects.toBeInstanceOf(OutboxConflictError);
    await expect(outbox.enqueue(round({
      channels: { l0: true, skill: false },
    }))).rejects.toBeInstanceOf(OutboxConflictError);
    expect((await outbox.health()).pendingCount).toBe(1);
    outbox.close();
  });

  it("tracks an advisory drain signal so shutdown waits for its delivery", async () => {
    const dbPath = await outboxPath();
    const port: RoundDeliveryPort = {
      deliverL0: vi.fn(async (input) => receipt(input.sourceEventId, input.contentHash)),
      deliverSkill: vi.fn(async (input) => receipt(input.sourceEventId, input.contentHash)),
    };
    const outbox = openDurableRoundOutbox({ dbPath, delivery: port });
    await outbox.enqueue(round());

    outbox.signal();
    await outbox.stop();

    await expect(outbox.get("codex:session-1:turn-1")).resolves.toMatchObject({
      state: "committed",
    });
    expect(port.deliverL0).toHaveBeenCalledOnce();
    expect(port.deliverSkill).toHaveBeenCalledOnce();
    outbox.close();
  });

  it("delivers L0 then skill with stable receipts while preserving per-session order", async () => {
    const dbPath = await outboxPath();
    const firstSessionGate = deferred();
    const started: string[] = [];
    const port: RoundDeliveryPort = {
      deliverL0: vi.fn(async (input) => {
        started.push(`${input.identity.sessionId}:${input.identity.turnId}:l0`);
        if (input.identity.sessionId === "session-1" && input.identity.turnId === "turn-1") {
          await firstSessionGate.promise;
        }
        return receipt(input.sourceEventId, input.contentHash);
      }),
      deliverSkill: vi.fn(async (input) => {
        started.push(`${input.identity.sessionId}:${input.identity.turnId}:skill`);
        return receipt(input.sourceEventId, input.contentHash);
      }),
    };
    const outbox = openDurableRoundOutbox({ dbPath, delivery: port });
    await outbox.enqueue(round());
    await outbox.enqueue(round({ sourceEventId: "codex:session-1:turn-2", identity: {
      ...round().identity,
      taskId: "task-changed-within-session",
      turnId: "turn-2",
    } }));
    await outbox.enqueue(round({ sourceEventId: "codex:session-2:turn-1", identity: {
      ...round().identity,
      sessionId: "session-2",
    } }));

    const draining = outbox.drainReady({ concurrency: 2 });
    await vi.waitFor(() => {
      expect(started).toContain("session-1:turn-1:l0");
      expect(started).toContain("session-2:turn-1:l0");
    });
    expect(started).not.toContain("session-1:turn-2:l0");

    firstSessionGate.resolve();
    await expect(draining).resolves.toEqual({ committed: 3, retried: 0, dead: 0 });
    expect(started.indexOf("session-1:turn-1:skill")).toBeLessThan(
      started.indexOf("session-1:turn-2:l0"),
    );
    expect(await outbox.get("codex:session-1:turn-2")).toMatchObject({ state: "committed" });

    const l0Calls = vi.mocked(port.deliverL0).mock.calls.map(([input]) => input);
    const skillCalls = vi.mocked(port.deliverSkill).mock.calls.map(([input]) => input);
    expect(l0Calls.every((input) => /^codex:outbox:[a-f0-9]{64}:l0$/.test(input.sourceEventId))).toBe(true);
    expect(new Set(l0Calls.map((input) => input.sourceEventId)).size).toBe(3);
    expect(skillCalls.every((input) => /^codex:outbox:[a-f0-9]{64}:skill$/.test(input.sourceEventId))).toBe(true);
    expect([...l0Calls, ...skillCalls].every((input) => /^sha256:[a-f0-9]{64}$/.test(input.contentHash))).toBe(true);
    outbox.close();
  });

  it("delivers only the extraction channels selected by the runtime", async () => {
    const dbPath = await outboxPath();
    const port: RoundDeliveryPort = {
      deliverL0: vi.fn(async (input) => receipt(input.sourceEventId, input.contentHash)),
      deliverSkill: vi.fn(async (input) => receipt(input.sourceEventId, input.contentHash)),
    };
    const outbox = openDurableRoundOutbox({ dbPath, delivery: port });
    await outbox.enqueue(round({ channels: { l0: true, skill: false } }));
    await outbox.enqueue(round({
      sourceEventId: "codex:session-2:turn-1",
      identity: { ...round().identity, sessionId: "session-2" },
      channels: { l0: false, skill: true },
    }));

    await expect(outbox.drainReady({ concurrency: 2 })).resolves.toEqual({
      committed: 2,
      retried: 0,
      dead: 0,
    });
    expect(port.deliverL0).toHaveBeenCalledTimes(1);
    expect(port.deliverSkill).toHaveBeenCalledTimes(1);
    expect(vi.mocked(port.deliverL0).mock.calls[0][0].identity.sessionId).toBe("session-1");
    expect(vi.mocked(port.deliverSkill).mock.calls[0][0].identity.sessionId).toBe("session-2");
    outbox.close();
  });

  it("retries a lost acknowledgement with the same event identity and then commits the duplicate receipt", async () => {
    const dbPath = await outboxPath();
    let now = 1_000;
    const l0Events: Array<{ sourceEventId: string; contentHash: string }> = [];
    const port: RoundDeliveryPort = {
      deliverL0: vi.fn(async (input) => {
        l0Events.push({ sourceEventId: input.sourceEventId, contentHash: input.contentHash });
        if (l0Events.length === 1) {
          throw Object.assign(new Error("acknowledgement timed out"), {
            kind: "timeout",
            retryable: true,
            status: 408,
          });
        }
        return { ...receipt(input.sourceEventId, input.contentHash), status: "duplicate" as const };
      }),
      deliverSkill: vi.fn(async (input) => receipt(input.sourceEventId, input.contentHash)),
    };
    const outbox = openDurableRoundOutbox({
      dbPath,
      delivery: port,
      now: () => now,
      random: () => 0,
      retry: { baseMs: 100, capMs: 1_000, jitterMs: 0 },
    });
    await outbox.enqueue(round());

    await expect(outbox.drainReady()).resolves.toEqual({ committed: 0, retried: 1, dead: 0 });
    expect(await outbox.get("codex:session-1:turn-1")).toMatchObject({
      state: "pending",
      attemptCount: 1,
      nextAttemptAt: 1_100,
    });
    expect(await outbox.health()).toMatchObject({
      pendingCount: 1,
      retryingCount: 1,
      nextRetryAt: 1_100,
    });
    await expect(outbox.drainReady()).resolves.toEqual({ committed: 0, retried: 0, dead: 0 });

    now = 1_100;
    await expect(outbox.drainReady()).resolves.toEqual({ committed: 1, retried: 0, dead: 0 });
    expect(l0Events).toHaveLength(2);
    expect(l0Events[1]).toEqual(l0Events[0]);
    expect(port.deliverSkill).toHaveBeenCalledTimes(1);
    expect(await outbox.get("codex:session-1:turn-1")).toMatchObject({
      state: "committed",
      attemptCount: 2,
    });
    outbox.close();
  });

  it("moves a permanent MemoryCore failure to dead-letter without exposing payloads in health", async () => {
    const dbPath = await outboxPath();
    const port: RoundDeliveryPort = {
      deliverL0: vi.fn(async () => {
        throw Object.assign(new Error("HTTP 403 contained secret-user-content"), {
          kind: "client",
          retryable: false,
          status: 403,
        });
      }),
      deliverSkill: vi.fn(),
    };
    const outbox = openDurableRoundOutbox({ dbPath, delivery: port });
    await outbox.enqueue(round());

    await expect(outbox.drainReady()).resolves.toEqual({ committed: 0, retried: 0, dead: 1 });
    expect(await outbox.get("codex:session-1:turn-1")).toMatchObject({ state: "dead" });
    const health = await outbox.health();
    expect(health).toMatchObject({ pendingCount: 0, retryingCount: 0, deadCount: 1 });
    expect(JSON.stringify(health)).not.toContain("secret-user-content");
    expect(port.deliverSkill).not.toHaveBeenCalled();
    outbox.close();
  });

  it("classifies network, 429 and 5xx failures as retryable", async () => {
    const dbPath = await outboxPath();
    const port: RoundDeliveryPort = {
      deliverL0: vi.fn(async (input) => {
        if (input.identity.sessionId === "network") throw new TypeError("fetch failed");
        const status = input.identity.sessionId === "throttled" ? 429 : 503;
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      }),
      deliverSkill: vi.fn(),
    };
    const outbox = openDurableRoundOutbox({
      dbPath,
      delivery: port,
      random: () => 0,
      retry: { baseMs: 100, jitterMs: 0 },
    });
    for (const sessionId of ["network", "throttled", "unavailable"]) {
      await outbox.enqueue(round({
        sourceEventId: `codex:${sessionId}:turn-1`,
        identity: { ...round().identity, sessionId },
      }));
    }

    await expect(outbox.drainReady({ concurrency: 3 })).resolves.toEqual({
      committed: 0,
      retried: 3,
      dead: 0,
    });
    expect(await outbox.health()).toMatchObject({ pendingCount: 3, retryingCount: 3, deadCount: 0 });
    outbox.close();
  });

  it("caps the complete retry delay including jitter and dead-letters exhausted retries", async () => {
    const dbPath = await outboxPath();
    let now = 1_000;
    const port: RoundDeliveryPort = {
      deliverL0: vi.fn(async () => {
        throw Object.assign(new Error("network unavailable"), { kind: "network", retryable: true });
      }),
      deliverSkill: vi.fn(),
    };
    const outbox = openDurableRoundOutbox({
      dbPath,
      delivery: port,
      now: () => now,
      random: () => 1,
      retry: { baseMs: 100, capMs: 100, jitterMs: 50, maxAttempts: 2 },
    });
    await outbox.enqueue(round());

    await expect(outbox.drainReady()).resolves.toEqual({ committed: 0, retried: 1, dead: 0 });
    expect(await outbox.get("codex:session-1:turn-1")).toMatchObject({ nextAttemptAt: 1_100 });

    now = 1_100;
    await expect(outbox.drainReady()).resolves.toEqual({ committed: 0, retried: 0, dead: 1 });
    expect(await outbox.health()).toMatchObject({ pendingCount: 0, retryingCount: 0, deadCount: 1 });
    expect(port.deliverL0).toHaveBeenCalledTimes(2);
    outbox.close();
  });

  it("recovers interrupted inflight work and replays it when the startup worker begins", async () => {
    const dbPath = await outboxPath();
    const beforeCrash = openDurableRoundOutbox({ dbPath, delivery: delivery() });
    await beforeCrash.enqueue(round());
    beforeCrash.close();

    // Emulate the durable state left by a process killed after claim and before
    // acknowledgement. Assertions remain at the public outbox seam below.
    const crashedDatabase = new Database(dbPath);
    crashedDatabase.prepare(`
      UPDATE completed_round_outbox
      SET state = 'inflight', attempt_count = 1
      WHERE source_event_id = ?
    `).run("codex:session-1:turn-1");
    crashedDatabase.close();

    const port: RoundDeliveryPort = {
      deliverL0: vi.fn(async (input) => receipt(input.sourceEventId, input.contentHash)),
      deliverSkill: vi.fn(async (input) => receipt(input.sourceEventId, input.contentHash)),
    };
    const restarted = openDurableRoundOutbox({ dbPath, delivery: port });
    expect(await restarted.get("codex:session-1:turn-1")).toMatchObject({
      state: "pending",
      attemptCount: 1,
    });

    await restarted.start({ pollIntervalMs: 60_000 });
    expect(await restarted.get("codex:session-1:turn-1")).toMatchObject({
      state: "committed",
      attemptCount: 2,
    });
    await restarted.stop();
    restarted.close();
  });

  it("refuses to start without a file-backed available durable store", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-round-outbox-invalid-"));
    tempRoots.push(root);

    expect(() => openDurableRoundOutbox({ dbPath: ":memory:", delivery: delivery() }))
      .toThrow(/requires a file-backed durable outbox/);
    expect(() => openDurableRoundOutbox({ dbPath: root, delivery: delivery() }))
      .toThrow(/Durable round outbox is unavailable/);
  });

  it("rejects malformed completed-round boundary data before persistence", async () => {
    const dbPath = await outboxPath();
    const outbox = openDurableRoundOutbox({ dbPath, delivery: delivery() });
    const malformed: unknown = {
      ...round(),
      identity: { sessionId: "session-1" },
    };

    await expect(outbox.enqueue(malformed as CompletedRound)).rejects.toThrow(/identity fields/);
    expect(await outbox.health()).toMatchObject({ pendingCount: 0, deadCount: 0 });
    outbox.close();
  });
});

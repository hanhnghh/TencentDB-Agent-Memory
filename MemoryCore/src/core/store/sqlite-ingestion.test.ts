import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { L0IngestionInput } from "./types.js";
import { VectorStore } from "./sqlite.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ingestion(contentHash = "content-1", payloadHash = "payload-1"): L0IngestionInput {
  return {
    receiptKey: "scoped-event-key",
    sourceEventId: "event-1",
    contentHash,
    payloadHash,
    records: [{
      record: {
        id: "msg-deterministic-0",
        sessionKey: "session-1",
        sessionId: "session-1",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        role: "user",
        messageText: "hello",
        recordedAt: "2026-08-08T00:00:00.000Z",
        timestamp: Date.parse("2026-08-08T00:00:00.000Z"),
      },
    }],
  };
}

describe("SQLite L0 ingestion receipt durability", () => {
  it("replays as duplicate after restart without adding another L0 record", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-core-ingestion-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "vectors.db");

    const firstStore = new VectorStore(dbPath, 0);
    firstStore.init();
    const first = firstStore.commitL0Ingestion(ingestion());
    firstStore.close();

    const restartedStore = new VectorStore(dbPath, 0);
    restartedStore.init();
    const replay = restartedStore.commitL0Ingestion(ingestion());
    const conflict = restartedStore.commitL0Ingestion(ingestion("content-2", "payload-2"));
    const count = restartedStore.countL0({ sessionId: "session-1" });
    restartedStore.close();

    expect(first.status).toBe("committed");
    expect(replay.status).toBe("duplicate");
    expect(conflict.status).toBe("conflict");
    expect(count).toBe(1);
  });
});

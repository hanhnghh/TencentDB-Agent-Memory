import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("returns conflict for the same event with changed content without adding another L0 record", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-core-ingestion-conflict-"));
    tempDirs.push(dir);
    const store = new VectorStore(join(dir, "vectors.db"), 0);
    store.init();

    const first = store.commitL0Ingestion(ingestion());
    const conflict = store.commitL0Ingestion(ingestion("content-2", "payload-2"));
    const count = store.countL0({ sessionId: "session-1" });
    store.close();

    expect(first.status).toBe("committed");
    expect(conflict.status).toBe("conflict");
    expect(count).toBe(1);
  });

  it("rolls back every L0 row when durable receipt insertion fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-core-ingestion-rollback-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "vectors.db");
    const store = new VectorStore(dbPath, 0);
    store.init();

    const control = new DatabaseSync(dbPath);
    control.exec(`
      CREATE TRIGGER reject_l0_receipt
      BEFORE INSERT ON l0_ingestion_receipts
      BEGIN
        SELECT RAISE(ABORT, 'receipt unavailable');
      END
    `);
    control.close();

    const result = store.commitL0Ingestion(ingestion());
    const count = store.countL0({ sessionId: "session-1" });
    store.close();

    expect(result.status).toBe("failed");
    expect(count).toBe(0);
  });

  it("rejects malformed durable receipt data instead of coercing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-core-ingestion-malformed-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "vectors.db");
    const store = new VectorStore(dbPath, 0);
    store.init();
    expect(store.commitL0Ingestion(ingestion()).status).toBe("committed");

    const control = new DatabaseSync(dbPath);
    control.exec("UPDATE l0_ingestion_receipts SET accepted_ids_json = '{}'");
    control.close();

    expect(() => store.getL0IngestionReceipt("scoped-event-key")).toThrow(
      "Malformed L0 ingestion receipt field: accepted_ids_json",
    );
    store.close();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { L0IngestionInput } from "./types.js";

const clientState = vi.hoisted(() => ({
  documents: new Map<string, Map<string, Record<string, unknown>>>(),
  l0WriteBatches: 0,
  receiptWriteBatches: 0,
}));

vi.mock("./tcvdb-client.js", () => ({
  TcvdbApiError: class TcvdbApiError extends Error {
    readonly apiCode: number;

    constructor(_path: string, code: number, message: string) {
      super(message);
      this.apiCode = code;
    }
  },
  TcvdbClient: class TcvdbClient {
    async createDatabase(): Promise<boolean> {
      return false;
    }

    async createCollection(): Promise<void> {}

    getDatabase(): string {
      return "memory-1";
    }

    async query(collection: string, params: Record<string, unknown>): Promise<{ documents: Record<string, unknown>[] }> {
      const ids = Array.isArray(params.documentIds) ? params.documentIds : [];
      const collectionDocs = clientState.documents.get(collection);
      return {
        documents: ids.flatMap((id) => {
          const document = collectionDocs?.get(String(id));
          return document ? [document] : [];
        }),
      };
    }

    async upsert(collection: string, documents: Record<string, unknown>[]): Promise<void> {
      if (collection.endsWith("_l0_conversations")) clientState.l0WriteBatches += 1;
      if (collection.endsWith("_l0_ingestion_receipts")) clientState.receiptWriteBatches += 1;
      let collectionDocs = clientState.documents.get(collection);
      if (!collectionDocs) {
        collectionDocs = new Map();
        clientState.documents.set(collection, collectionDocs);
      }
      for (const document of documents) collectionDocs.set(String(document.id), document);
    }
  },
}));

import { TcvdbMemoryStore } from "./tcvdb.js";

function ingestion(payloadHash = "payload-1"): L0IngestionInput {
  return {
    receiptKey: "scoped-event-key",
    sourceEventId: "event-1",
    contentHash: "content-1",
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

function createStore(): TcvdbMemoryStore {
  return new TcvdbMemoryStore({
    url: "http://vector-db.test",
    username: "root",
    apiKey: "test-key",
    database: "memory-1",
    embeddingModel: "test-model",
    timeout: 1_000,
  });
}

beforeEach(() => {
  clientState.documents.clear();
  clientState.l0WriteBatches = 0;
  clientState.receiptWriteBatches = 0;
});

describe("TCVDB L0 ingestion receipt durability", () => {
  it("replays after store reconstruction without another L0 or receipt write", async () => {
    const firstStore = createStore();
    await firstStore.init();
    const first = await firstStore.commitL0Ingestion(ingestion());

    const restartedStore = createStore();
    await restartedStore.init();
    const replay = await restartedStore.commitL0Ingestion(ingestion());
    const conflict = await restartedStore.commitL0Ingestion(ingestion("payload-2"));

    expect(first.status).toBe("committed");
    expect(replay.status).toBe("duplicate");
    expect(conflict.status).toBe("conflict");
    expect(clientState.l0WriteBatches).toBe(1);
    expect(clientState.receiptWriteBatches).toBe(1);
  });
});

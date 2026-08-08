import { describe, expect, it, vi } from "vitest";

import type { IMemoryStore, L0IngestionInput, L0IngestionReceipt } from "../core/store/types.js";
import { handleConversationAdd, type V2RouterDeps } from "./v2-router.js";
import { conversationAddDataSchema } from "./v2-schemas.js";

const auth = { serviceId: "memory-1" };

function makeDeps(store: Partial<IMemoryStore>): V2RouterDeps {
  return {
    getStore: () => store as IMemoryStore,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    deployMode: "service",
    requestIsolation: {
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "session-1",
    },
  };
}

describe("conversation/add ingestion receipts", () => {
  it("preserves the legacy contract when source identity is omitted", async () => {
    const upsertL0 = vi.fn(() => true);
    const deps = makeDeps({ upsertL0 });

    const response = await handleConversationAdd({
      session_id: "session-1",
      messages: [{ role: "user", content: "legacy caller" }],
    }, auth, "req-legacy", deps);

    expect(response).toMatchObject({
      code: 0,
      data: { total_count: 1, accepted_versions: ["v1"] },
    });
    expect(conversationAddDataSchema.parse(response.data).receipt).toBeUndefined();
    expect(upsertL0).toHaveBeenCalledTimes(1);
  });

  it("returns the prior receipt for a lost-ack replay without writing or notifying twice", async () => {
    const receipts = new Map<string, L0IngestionReceipt>();
    const commit = vi.fn(async (input: L0IngestionInput) => {
      const existing = receipts.get(input.receiptKey);
      if (existing) {
        if (existing.contentHash !== input.contentHash || existing.payloadHash !== input.payloadHash) {
          return { status: "conflict", receipt: existing };
        }
        return { status: "duplicate", receipt: existing };
      }
      const receipt = {
        sourceEventId: input.sourceEventId,
        contentHash: input.contentHash,
        payloadHash: input.payloadHash,
        acceptedIds: input.records.map((entry) => entry.record.id),
        acceptedVersions: input.records.map(() => "v1"),
        committedAt: "2026-08-08T00:00:00.000Z",
      };
      receipts.set(input.receiptKey, receipt);
      return { status: "committed", receipt };
    });
    const notifyPipeline = vi.fn(async () => undefined);
    const checkMemoryQuota = vi.fn(async () => ({ allowed: true, current: 0, limit: 100 }));
    const reportMemoryAdded = vi.fn(async () => undefined);
    const deps = makeDeps({
      upsertL0: vi.fn(() => true),
      getL0IngestionReceipt: vi.fn(async (receiptKey: string) => receipts.get(receiptKey)),
      commitL0Ingestion: commit,
    } as Partial<IMemoryStore>);
    deps.notifyPipeline = notifyPipeline;
    deps.quotaManager = {
      checkMemoryQuota,
      reportMemoryAdded,
    } as V2RouterDeps["quotaManager"];

    const body = {
      session_id: "session-1",
      source_event_id: "codex-session-1-turn-7-batch-0",
      content_hash: "client-hash-7",
      messages: [
        { role: "user", content: "Retry-safe question" },
        { role: "assistant", content: "Retry-safe answer" },
      ],
    };

    const first = await handleConversationAdd(body, auth, "req-1", deps);
    const replay = await handleConversationAdd(body, auth, "req-2", deps);

    const firstData = conversationAddDataSchema.parse(first.data);
    const replayData = conversationAddDataSchema.parse(replay.data);
    expect(firstData).toMatchObject({ receipt: { status: "committed", source_event_id: body.source_event_id } });
    expect(replayData).toEqual({
      ...firstData,
      receipt: {
        ...firstData.receipt,
        status: "duplicate",
      },
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(notifyPipeline).toHaveBeenCalledTimes(1);
    expect(checkMemoryQuota).toHaveBeenCalledTimes(1);
    expect(reportMemoryAdded).toHaveBeenCalledTimes(1);
  });

  it("returns a clear conflict when an event id is reused for different content", async () => {
    const priorReceipt = {
      sourceEventId: "event-1",
      contentHash: "hash-1",
      payloadHash: "payload-1",
      acceptedIds: ["msg-stable"],
      acceptedVersions: ["v1"],
      committedAt: "2026-08-08T00:00:00.000Z",
    };
    const deps = makeDeps({
      upsertL0: vi.fn(() => true),
      getL0IngestionReceipt: vi.fn(async () => priorReceipt),
      commitL0Ingestion: vi.fn(async () => ({ status: "conflict", receipt: priorReceipt })),
    } as Partial<IMemoryStore>);

    const response = await handleConversationAdd({
      session_id: "session-1",
      source_event_id: "event-1",
      content_hash: "hash-2",
      messages: [{ role: "user", content: "different" }],
    }, auth, "req-conflict", deps);

    expect(response).toMatchObject({
      code: 409,
      data: {
        source_event_id: "event-1",
        expected_content_hash: "hash-1",
        actual_content_hash: "hash-2",
      },
    });
  });

  it("rejects changed content even when the caller reuses the same content hash", async () => {
    const receipts = new Map<string, L0IngestionReceipt>();
    const commit = vi.fn(async (input: L0IngestionInput) => {
      const receipt = {
        sourceEventId: input.sourceEventId,
        contentHash: input.contentHash,
        payloadHash: input.payloadHash,
        acceptedIds: input.records.map((entry) => entry.record.id),
        acceptedVersions: input.records.map(() => "v1"),
        committedAt: "2026-08-08T00:00:00.000Z",
      };
      receipts.set(input.receiptKey, receipt);
      return { status: "committed", receipt };
    });
    const deps = makeDeps({
      upsertL0: vi.fn(() => true),
      getL0IngestionReceipt: vi.fn(async (receiptKey: string) => receipts.get(receiptKey)),
      commitL0Ingestion: commit,
    } as Partial<IMemoryStore>);
    const base = {
      session_id: "session-1",
      source_event_id: "event-reused-hash",
      content_hash: "caller-hash",
    };

    const first = await handleConversationAdd({
      ...base,
      messages: [{ role: "user", content: "original" }],
    }, auth, "req-original", deps);
    const changed = await handleConversationAdd({
      ...base,
      messages: [{ role: "user", content: "changed" }],
    }, auth, "req-changed", deps);

    expect(first.code).toBe(0);
    expect(changed).toMatchObject({ code: 409 });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("scopes receipt and message identity by service", async () => {
    const receiptKeys: string[] = [];
    const messageIds: string[] = [];
    const deps = makeDeps({
      upsertL0: vi.fn(() => true),
      getL0IngestionReceipt: vi.fn(async () => undefined),
      commitL0Ingestion: vi.fn(async (input: L0IngestionInput) => {
        receiptKeys.push(input.receiptKey);
        messageIds.push(input.records[0].record.id);
        return {
          status: "committed",
          receipt: {
            sourceEventId: input.sourceEventId,
            contentHash: input.contentHash,
            payloadHash: input.payloadHash,
            acceptedIds: [input.records[0].record.id],
            acceptedVersions: ["v1"],
            committedAt: "2026-08-08T00:00:00.000Z",
          },
        };
      }),
    } as Partial<IMemoryStore>);
    const body = {
      session_id: "session-1",
      source_event_id: "event-shared",
      messages: [{ role: "user", content: "same event in separate services" }],
    };

    await handleConversationAdd(body, { serviceId: "memory-1" }, "req-service-1", deps);
    await handleConversationAdd(body, { serviceId: "memory-2" }, "req-service-2", deps);

    expect(new Set(receiptKeys).size).toBe(2);
    expect(new Set(messageIds).size).toBe(2);
  });


  it("uses deterministic message ids for source events", async () => {
    const seenIds: string[][] = [];
    const deps = makeDeps({
      upsertL0: vi.fn(() => true),
      getL0IngestionReceipt: vi.fn(async () => undefined),
      commitL0Ingestion: vi.fn(async (input: L0IngestionInput) => {
        const ids = input.records.map((entry) => entry.record.id);
        seenIds.push(ids);
        return {
          status: "committed",
          receipt: {
            sourceEventId: input.sourceEventId,
            contentHash: input.contentHash,
            payloadHash: input.payloadHash,
            acceptedIds: ids,
            acceptedVersions: ids.map(() => "v1"),
            committedAt: "2026-08-08T00:00:00.000Z",
          },
        };
      }),
    } as Partial<IMemoryStore>);
    const body = {
      session_id: "session-1",
      source_event_id: "event-stable",
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    };

    await handleConversationAdd(body, auth, "req-a", deps);
    await handleConversationAdd(body, auth, "req-b", deps);

    expect(seenIds[0]).toEqual(seenIds[1]);
    expect(seenIds[0]).toHaveLength(2);
  });

  it("does not acknowledge a legacy request when the durable store returns false", async () => {
    const notifyPipeline = vi.fn(async () => undefined);
    const deps = makeDeps({ upsertL0: vi.fn(() => false) });
    deps.notifyPipeline = notifyPipeline;

    const response = await handleConversationAdd({
      session_id: "session-1",
      messages: [{ role: "user", content: "must persist" }],
    }, auth, "req-storage-failure", deps);

    expect(response).toMatchObject({ code: 503 });
    expect(notifyPipeline).not.toHaveBeenCalled();
  });

  it("does not notify when source-event receipt storage returns failure", async () => {
    const notifyPipeline = vi.fn(async () => undefined);
    const deps = makeDeps({
      upsertL0: vi.fn(() => true),
      getL0IngestionReceipt: vi.fn(async () => undefined),
      commitL0Ingestion: vi.fn(async () => ({ status: "failed" })),
    } as Partial<IMemoryStore>);
    deps.notifyPipeline = notifyPipeline;

    const response = await handleConversationAdd({
      session_id: "session-1",
      source_event_id: "event-storage-failure",
      messages: [{ role: "user", content: "must persist with receipt" }],
    }, auth, "req-receipt-storage-failure", deps);

    expect(response).toMatchObject({ code: 503, data: { retryable: true } });
    expect(notifyPipeline).not.toHaveBeenCalled();
  });
});

import http from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IMemoryStore, L0IngestionInput, L0IngestionReceipt } from "../core/store/types.js";
import { VectorStore } from "../core/store/sqlite.js";
import { handleConversationAdd, handleV2Route, type V2RouterDeps } from "./v2-router.js";
import { conversationAddDataSchema } from "./v2-schemas.js";

const auth = { serviceId: "memory-1" };
const testStores: VectorStore[] = [];

type IngestionStoreOverrides = Partial<Pick<
  IMemoryStore,
  "upsertL0" | "getL0IngestionReceipt" | "commitL0Ingestion"
>>;

afterEach(() => {
  for (const store of testStores.splice(0)) store.close();
});

function makeDeps(overrides: IngestionStoreOverrides): V2RouterDeps {
  const store = Object.assign(new VectorStore(":memory:", 0), overrides);
  store.init();
  testStores.push(store);
  return {
    getStore: () => store,
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

async function dispatchConversationAdd(
  pathname: "/v2/conversation/add" | "/v3/conversation/add",
  body: Record<string, unknown>,
  deps: V2RouterDeps,
  identity: {
    serviceId?: string;
    teamId?: string;
    userId?: string;
    agentId?: string;
    taskId?: string;
  } = {},
): Promise<{ status: number; envelope: Record<string, unknown> }> {
  const request = new http.IncomingMessage(new Socket());
  request.headers = {
    authorization: "Bearer test-key",
    "x-tdai-service-id": identity.serviceId ?? "memory-1",
    "x-tdai-team-id": identity.teamId ?? "team-1",
    "x-tdai-user-id": identity.userId ?? "user-1",
    "x-tdai-agent-id": identity.agentId ?? "agent-1",
    ...(identity.taskId ? { "x-tdai-task-id": identity.taskId } : {}),
  };
  const response = new http.ServerResponse(request);
  const sendJson = vi.fn();

  const handled = await handleV2Route(
    request,
    response,
    pathname,
    "POST",
    async () => body,
    sendJson,
    deps,
  );

  expect(handled).toBe(true);
  expect(sendJson).toHaveBeenCalledTimes(1);
  const call: unknown = sendJson.mock.calls[0];
  if (!Array.isArray(call) || typeof call[1] !== "number") throw new Error("Expected route response status");
  const status = call[1];
  const envelope: unknown = call[2];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Expected route response envelope");
  }
  return { status, envelope };
}

describe("conversation/add ingestion receipts", () => {
  it.each(["/v2/conversation/add", "/v3/conversation/add"] as const)(
    "%s preserves the public legacy contract when source identity is omitted",
    async (pathname) => {
      const upsertL0 = vi.fn(() => true);
      const { status, envelope } = await dispatchConversationAdd(pathname, {
        session_id: "session-1",
        messages: [{ role: "user", content: "legacy caller" }],
      }, makeDeps({ upsertL0 }));

      expect(status).toBe(200);
      expect(envelope).toMatchObject({
        code: 0,
        data: { total_count: 1, accepted_versions: ["v1"] },
      });
      expect(conversationAddDataSchema.parse(envelope.data).receipt).toBeUndefined();
      expect(upsertL0).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["/v2/conversation/add", "/v3/conversation/add"] as const)(
    "%s returns the prior lost-ack receipt without repeating writes, notifications, or quota effects",
    async (pathname) => {
      const receipts = new Map<string, L0IngestionReceipt>();
      const commit = vi.fn(async (input: L0IngestionInput) => {
        const existing = receipts.get(input.receiptKey);
        if (existing) return { status: "duplicate" as const, receipt: existing };
        const receipt = {
          sourceEventId: input.sourceEventId,
          contentHash: input.contentHash,
          payloadHash: input.payloadHash,
          acceptedIds: input.records.map((entry) => entry.record.id),
          acceptedVersions: input.records.map(() => "v1"),
          committedAt: "2026-08-08T00:00:00.000Z",
        };
        receipts.set(input.receiptKey, receipt);
        return { status: "committed" as const, receipt };
      });
      const notifyPipeline = vi.fn(async () => undefined);
      const checkMemoryQuota = vi.fn(async () => ({ allowed: true, current: 0, limit: 100 }));
      const reportMemoryAdded = vi.fn(async () => undefined);
      const deps = makeDeps({
        upsertL0: vi.fn(() => true),
        getL0IngestionReceipt: vi.fn(async (receiptKey: string) => receipts.get(receiptKey)),
        commitL0Ingestion: commit,
      });
      deps.notifyPipeline = notifyPipeline;
      deps.quotaManager = { checkMemoryQuota, reportMemoryAdded };
      const body = {
        session_id: "session-1",
        source_event_id: "event-lost-ack",
        content_hash: "hash-lost-ack",
        messages: [{ role: "user", content: "hello" }],
      };

      const first = await dispatchConversationAdd(pathname, body, deps);
      const replay = await dispatchConversationAdd(pathname, body, deps);

      expect(first.status).toBe(200);
      expect(first.envelope).toMatchObject({ data: { receipt: { status: "committed" } } });
      expect(replay.status).toBe(200);
      expect(replay.envelope).toMatchObject({ data: { receipt: { status: "duplicate" } } });
      expect(commit).toHaveBeenCalledTimes(1);
      expect(notifyPipeline).toHaveBeenCalledTimes(1);
      expect(checkMemoryQuota).toHaveBeenCalledTimes(1);
      expect(reportMemoryAdded).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["/v2/conversation/add", "/v3/conversation/add"] as const)(
    "%s returns HTTP 409 when a source event is reused with different content",
    async (pathname) => {
      const priorReceipt: L0IngestionReceipt = {
        sourceEventId: "event-conflict",
        contentHash: "hash-original",
        payloadHash: "payload-original",
        acceptedIds: ["msg-original"],
        acceptedVersions: ["v1"],
        committedAt: "2026-08-08T00:00:00.000Z",
      };
      const deps = makeDeps({
        upsertL0: vi.fn(() => true),
        getL0IngestionReceipt: vi.fn(async () => priorReceipt),
        commitL0Ingestion: vi.fn(),
      });

      const { status, envelope } = await dispatchConversationAdd(pathname, {
        session_id: "session-1",
        source_event_id: "event-conflict",
        content_hash: "hash-changed",
        messages: [{ role: "user", content: "changed" }],
      }, deps);

      expect(status).toBe(409);
      expect(envelope).toMatchObject({
        code: 409,
        data: {
          source_event_id: "event-conflict",
          expected_content_hash: "hash-original",
          actual_content_hash: "hash-changed",
        },
      });
    },
  );

  it.each([
    { pathname: "/v2/conversation/add" as const, sourceEvent: false },
    { pathname: "/v3/conversation/add" as const, sourceEvent: false },
    { pathname: "/v2/conversation/add" as const, sourceEvent: true },
    { pathname: "/v3/conversation/add" as const, sourceEvent: true },
  ])("$pathname does not acknowledge storage failure (source_event_id=$sourceEvent)", async ({ pathname, sourceEvent }) => {
    const notifyPipeline = vi.fn(async () => undefined);
    const deps = makeDeps({
      upsertL0: vi.fn(() => false),
      getL0IngestionReceipt: vi.fn(async () => undefined),
      commitL0Ingestion: vi.fn(async () => ({ status: "failed" as const })),
    });
    deps.notifyPipeline = notifyPipeline;
    const body = {
      session_id: "session-1",
      ...(sourceEvent ? { source_event_id: "event-storage-failure" } : {}),
      messages: [{ role: "user", content: "must persist" }],
    };

    const { status, envelope } = await dispatchConversationAdd(pathname, body, deps);

    expect(status).toBe(503);
    expect(envelope).toMatchObject({ code: 503, data: { retryable: true } });
    expect(notifyPipeline).not.toHaveBeenCalled();
  });

  it.each(["serviceId", "teamId", "userId", "agentId", "taskId", "sessionId"] as const)(
    "scopes public receipt and message identity by %s",
    async (dimension) => {
      const receiptKeys: string[] = [];
      const messageIds: string[] = [];
      const deps = makeDeps({
        upsertL0: vi.fn(() => true),
        getL0IngestionReceipt: vi.fn(async () => undefined),
        commitL0Ingestion: vi.fn(async (input: L0IngestionInput) => {
          receiptKeys.push(input.receiptKey);
          messageIds.push(input.records[0].record.id);
          return {
            status: "committed" as const,
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
      });
      const baseIdentity = {
        serviceId: "memory-1",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        taskId: "task-1",
      };
      const changedIdentity = {
        ...baseIdentity,
        ...(dimension === "sessionId" ? {} : { [dimension]: `${dimension}-2` }),
      };
      const baseBody = {
        session_id: "session-1",
        source_event_id: "event-shared",
        messages: [{ role: "user", content: "same event" }],
      };
      const changedBody = dimension === "sessionId" ? { ...baseBody, session_id: "session-2" } : baseBody;

      await dispatchConversationAdd("/v3/conversation/add", baseBody, deps, baseIdentity);
      await dispatchConversationAdd("/v3/conversation/add", changedBody, deps, changedIdentity);

      expect(new Set(receiptKeys).size).toBe(2);
      expect(new Set(messageIds).size).toBe(2);
    },
  );

  it.each([
    { field: "source_event_id", length: 0, expectedStatus: 400 },
    { field: "source_event_id", length: 1, expectedStatus: 200 },
    { field: "source_event_id", length: 512, expectedStatus: 200 },
    { field: "source_event_id", length: 513, expectedStatus: 400 },
    { field: "content_hash", length: 0, expectedStatus: 400 },
    { field: "content_hash", length: 1, expectedStatus: 200 },
    { field: "content_hash", length: 256, expectedStatus: 200 },
    { field: "content_hash", length: 257, expectedStatus: 400 },
  ])("validates $field length $length at the public route", async ({ field, length, expectedStatus }) => {
    const deps = makeDeps({
      upsertL0: vi.fn(() => true),
      getL0IngestionReceipt: vi.fn(async () => undefined),
      commitL0Ingestion: vi.fn(async (input: L0IngestionInput) => ({
        status: "committed" as const,
        receipt: {
          sourceEventId: input.sourceEventId,
          contentHash: input.contentHash,
          payloadHash: input.payloadHash,
          acceptedIds: input.records.map(({ record }) => record.id),
          acceptedVersions: input.records.map(() => "v1"),
          committedAt: "2026-08-08T00:00:00.000Z",
        },
      })),
    });
    const body = {
      session_id: "session-1",
      source_event_id: field === "source_event_id" ? "x".repeat(length) : "event-boundary",
      ...(field === "content_hash" ? { content_hash: "x".repeat(length) } : {}),
      messages: [{ role: "user", content: "hello" }],
    };

    const { status } = await dispatchConversationAdd("/v3/conversation/add", body, deps);

    expect(status).toBe(expectedStatus);
  });

  it.each([
    { messages: 0, contentLength: 1, expectedStatus: 400 },
    { messages: 1, contentLength: 0, expectedStatus: 400 },
    { messages: 1, contentLength: 1, expectedStatus: 200 },
    { messages: 100, contentLength: 1, expectedStatus: 200 },
    { messages: 101, contentLength: 1, expectedStatus: 400 },
    { messages: 1, contentLength: 8192, expectedStatus: 200 },
    { messages: 1, contentLength: 8193, expectedStatus: 400 },
  ])(
    "preserves the public payload boundary messages=$messages contentLength=$contentLength",
    async ({ messages, contentLength, expectedStatus }) => {
      const deps = makeDeps({
        upsertL0: vi.fn(() => true),
        getL0IngestionReceipt: vi.fn(async () => undefined),
        commitL0Ingestion: vi.fn(async (input: L0IngestionInput) => ({
          status: "committed" as const,
          receipt: {
            sourceEventId: input.sourceEventId,
            contentHash: input.contentHash,
            payloadHash: input.payloadHash,
            acceptedIds: input.records.map(({ record }) => record.id),
            acceptedVersions: input.records.map(() => "v1"),
            committedAt: "2026-08-08T00:00:00.000Z",
          },
        })),
      });
      const body = {
        session_id: "session-1",
        source_event_id: "event-payload-boundary",
        messages: Array.from({ length: messages }, () => ({ role: "user", content: "x".repeat(contentLength) })),
      };

      const { status } = await dispatchConversationAdd("/v3/conversation/add", body, deps);

      expect(status).toBe(expectedStatus);
    },
  );

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
    });
    deps.notifyPipeline = notifyPipeline;
    deps.quotaManager = {
      checkMemoryQuota,
      reportMemoryAdded,
    };

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
    });

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
    });
    const base = {
      session_id: "session-1",
      source_event_id: "event-reused-hash",
      content_hash: "caller-hash",
    };

    const first = await dispatchConversationAdd("/v3/conversation/add", {
      ...base,
      messages: [{ role: "user", content: "original" }],
    }, deps);
    const changed = await dispatchConversationAdd("/v3/conversation/add", {
      ...base,
      messages: [{ role: "user", content: "changed" }],
    }, deps);

    expect(first.status).toBe(200);
    expect(changed).toMatchObject({ status: 409, envelope: { code: 409 } });
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
    });
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
    });
    const body = {
      session_id: "session-1",
      source_event_id: "event-stable",
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    };

    await dispatchConversationAdd("/v3/conversation/add", body, deps);
    await dispatchConversationAdd("/v3/conversation/add", body, deps);

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
    });
    deps.notifyPipeline = notifyPipeline;

    const response = await handleConversationAdd({
      session_id: "session-1",
      source_event_id: "event-storage-failure",
      messages: [{ role: "user", content: "must persist with receipt" }],
    }, auth, "req-receipt-storage-failure", deps);

    expect(response).toMatchObject({ code: 503, data: { retryable: true } });
    expect(notifyPipeline).not.toHaveBeenCalled();
  });

  it("returns an error response when durable receipt lookup throws", async () => {
    const notifyPipeline = vi.fn(async () => undefined);
    const deps = makeDeps({
      upsertL0: vi.fn(() => true),
      getL0IngestionReceipt: vi.fn(async () => {
        throw new Error("storage credentials leaked only to server logs");
      }),
      commitL0Ingestion: vi.fn(async () => ({ status: "failed" })),
    });
    deps.notifyPipeline = notifyPipeline;
    const request = new http.IncomingMessage(new Socket());
    request.headers = {
      authorization: "Bearer test-key",
      "x-tdai-service-id": "memory-1",
    };
    const response = new http.ServerResponse(request);
    const sendJson = vi.fn();

    const handled = await handleV2Route(
      request,
      response,
      "/v2/conversation/add",
      "POST",
      async () => ({
        session_id: "session-1",
        source_event_id: "event-storage-throw",
        messages: [{ role: "user", content: "must not be accepted" }],
      }),
      sendJson,
      deps,
    );

    expect(handled).toBe(true);
    expect(sendJson).toHaveBeenCalledWith(response, 500, expect.objectContaining({ code: 500 }));
    expect(JSON.stringify(sendJson.mock.calls[0][2])).not.toContain("storage credentials");
    expect(notifyPipeline).not.toHaveBeenCalled();
  });
});

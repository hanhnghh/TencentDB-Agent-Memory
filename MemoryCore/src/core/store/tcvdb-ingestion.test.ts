import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { L0IngestionInput } from "./types.js";
import { TcvdbMemoryStore } from "./tcvdb.js";

interface VectorDbRequest {
  collection?: string;
  documents?: Array<Record<string, unknown>>;
  query?: { documentIds?: unknown };
}

interface ClientState {
  documents: Map<string, Map<string, Record<string, unknown>>>;
  l0WriteBatches: number;
  receiptWriteBatches: number;
  l0WritesInFlight: number;
  maxL0WritesInFlight: number;
  authorizationHeaders: string[];
  warnings: string[];
  requests: Array<{ path: string; body: VectorDbRequest }>;
}

const clientState: ClientState = {
  documents: new Map<string, Map<string, Record<string, unknown>>>(),
  l0WriteBatches: 0,
  receiptWriteBatches: 0,
  l0WritesInFlight: 0,
  maxL0WritesInFlight: 0,
  authorizationHeaders: [],
  warnings: [],
  requests: [],
};

let server: Server;
let vectorDbEndpoint: string;

function parseRequestBody(body: unknown): VectorDbRequest {
  const text = typeof body === "string"
    ? body
    : body instanceof Uint8Array
      ? new TextDecoder().decode(body)
      : undefined;
  if (text === undefined) throw new Error("VectorDB request body must be JSON text");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("VectorDB request body must be an object");
  }
  const collection = Reflect.get(value, "collection");
  if (collection !== undefined && typeof collection !== "string") {
    throw new Error("VectorDB collection must be a string");
  }
  const rawDocuments = Reflect.get(value, "documents");
  let documents: Array<Record<string, unknown>> | undefined;
  if (rawDocuments !== undefined) {
    if (!Array.isArray(rawDocuments) || !rawDocuments.every(isUnknownRecord)) {
      throw new Error("VectorDB documents must be objects");
    }
    documents = rawDocuments;
  }
  const rawQuery = Reflect.get(value, "query");
  let query: VectorDbRequest["query"];
  if (rawQuery !== undefined) {
    if (!isUnknownRecord(rawQuery)) throw new Error("VectorDB query must be an object");
    query = { documentIds: rawQuery.documentIds };
  }
  return {
    ...(collection !== undefined ? { collection } : {}),
    ...(documents !== undefined ? { documents } : {}),
    ...(query !== undefined ? { query } : {}),
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRequestBody(request: IncomingMessage): Promise<VectorDbRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return parseRequestBody(Buffer.concat(chunks));
}

function sendJson(response: ServerResponse, body: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ code: 0, msg: "ok", ...body }));
}

async function handleVectorDbRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const path = request.url ?? "";
    clientState.authorizationHeaders.push(request.headers.authorization ?? "");
    const body = await readRequestBody(request);
    clientState.requests.push({ path, body });

    if (path === "/database/list") return sendJson(response, { databases: ["memory-1"] });
    if (path === "/collection/describe") {
      return sendJson(response, {
        collection: { collection: body.collection ?? "", database: "memory-1" },
      });
    }
    if (path === "/document/query") {
      const ids = Array.isArray(body.query?.documentIds) ? body.query.documentIds : [];
      const collectionDocs = clientState.documents.get(body.collection ?? "");
      const documents = ids.flatMap((id) => {
        const document = collectionDocs?.get(String(id));
        return document ? [document] : [];
      });
      return sendJson(response, { documents });
    }
    if (path === "/document/upsert") {
      const collection = body.collection ?? "";
      const documents = body.documents;
      if (!Array.isArray(documents)) throw new Error("VectorDB upsert requires documents");
      const isL0Write = collection.endsWith("_l0_conversations");
      if (isL0Write) {
        clientState.l0WriteBatches += 1;
        clientState.l0WritesInFlight += 1;
        clientState.maxL0WritesInFlight = Math.max(
          clientState.maxL0WritesInFlight,
          clientState.l0WritesInFlight,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (collection.endsWith("_l0_ingestion_receipts")) clientState.receiptWriteBatches += 1;
      let collectionDocs = clientState.documents.get(collection);
      if (!collectionDocs) {
        collectionDocs = new Map();
        clientState.documents.set(collection, collectionDocs);
      }
      for (const document of documents) {
        const id = document.id;
        if (typeof id !== "string") throw new Error("VectorDB document id must be a string");
        collectionDocs.set(id, document);
      }
      if (isL0Write) clientState.l0WritesInFlight -= 1;
      return sendJson(response, { affectedCount: documents.length });
    }
    throw new Error(`Unexpected VectorDB request path: ${path}`);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 500, msg: error instanceof Error ? error.message : "fixture error" }));
  }
}

function ingestion(
  payloadHash = "payload-1",
  sourceEventId = "event-1",
  receiptKey = "scoped-event-key",
): L0IngestionInput {
  return {
    receiptKey,
    sourceEventId,
    contentHash: "content-1",
    payloadHash,
    records: [{
      record: {
        id: `msg-${receiptKey}`,
        sessionKey: "session-1",
        sessionId: "session-1",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        taskId: "task-1",
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
    url: vectorDbEndpoint,
    username: "root",
    apiKey: "test-key",
    database: "memory-1",
    embeddingModel: "test-model",
    timeout: 1_000,
    logger: {
      info: () => undefined,
      debug: () => undefined,
      warn: (message) => clientState.warnings.push(message),
      error: (message) => clientState.warnings.push(message),
    },
  });
}

beforeEach(async () => {
  clientState.documents.clear();
  clientState.l0WriteBatches = 0;
  clientState.receiptWriteBatches = 0;
  clientState.l0WritesInFlight = 0;
  clientState.maxL0WritesInFlight = 0;
  clientState.authorizationHeaders.length = 0;
  clientState.warnings.length = 0;
  clientState.requests.length = 0;
  server = createServer((request, response) => {
    void handleVectorDbRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture address");
  vectorDbEndpoint = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe("TCVDB L0 ingestion receipt durability", () => {
  it("replays after store reconstruction through the real client boundary", async () => {
    const firstStore = createStore();
    await firstStore.init();
    const first = await firstStore.commitL0Ingestion(ingestion());

    const restartedStore = createStore();
    await restartedStore.init();
    const replay = await restartedStore.commitL0Ingestion(ingestion());
    const conflict = await restartedStore.commitL0Ingestion(ingestion("payload-2"));

    expect(
      first.status,
      `${clientState.warnings.join("\n")}\n${JSON.stringify(clientState.requests)}`,
    ).toBe("committed");
    expect(replay.status).toBe("duplicate");
    expect(conflict.status).toBe("conflict");
    expect(clientState.l0WriteBatches).toBe(1);
    expect(clientState.receiptWriteBatches).toBe(1);
    expect(clientState.authorizationHeaders).not.toContain("");
    expect(new Set(clientState.authorizationHeaders)).toEqual(
      new Set(["Bearer account=root&api_key=test-key"]),
    );
  });

  it("serializes concurrent duplicate delivery without another L0 or receipt write", async () => {
    const store = createStore();
    await store.init();

    const [first, replay] = await Promise.all([
      store.commitL0Ingestion(ingestion()),
      store.commitL0Ingestion(ingestion()),
    ]);

    expect([first.status, replay.status].sort()).toEqual(["committed", "duplicate"]);
    expect(clientState.l0WriteBatches).toBe(1);
    expect(clientState.receiptWriteBatches).toBe(1);
  });

  it("returns conflict for the same event with changed content without another write", async () => {
    const store = createStore();
    await store.init();

    const first = await store.commitL0Ingestion(ingestion());
    const conflict = await store.commitL0Ingestion(ingestion("payload-changed"));

    expect(first.status).toBe("committed");
    expect(conflict.status).toBe("conflict");
    expect(clientState.l0WriteBatches).toBe(1);
    expect(clientState.receiptWriteBatches).toBe(1);
  });

  it("rejects malformed durable receipt data instead of coercing it", async () => {
    const store = createStore();
    await store.init();
    expect((await store.commitL0Ingestion(ingestion())).status).toBe("committed");
    const receiptCollection = clientState.documents.get("memory-1_l0_ingestion_receipts");
    const stored = receiptCollection?.get("scoped-event-key");
    if (!stored) throw new Error("Expected durable receipt fixture");
    stored.accepted_ids_json = "{}";

    await expect(store.getL0IngestionReceipt("scoped-event-key")).rejects.toThrow(
      "Malformed L0 ingestion receipt field: accepted_ids_json",
    );
  });

  it("uses the full session identity rather than event identity for the mutation queue", async () => {
    const store = createStore();
    await store.init();

    await Promise.all([
      store.commitL0Ingestion(ingestion("payload-1", "event-1", "receipt-1")),
      store.commitL0Ingestion(ingestion("payload-2", "event-2", "receipt-2")),
    ]);

    expect(clientState.l0WriteBatches).toBe(2);
    expect(clientState.receiptWriteBatches).toBe(2);
    expect(clientState.maxL0WritesInFlight).toBe(1);
  });
});

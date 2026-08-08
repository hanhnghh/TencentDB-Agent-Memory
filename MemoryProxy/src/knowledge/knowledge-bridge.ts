import type { Context } from "hono";

import type {
  BridgeSessionAccess,
  BridgeSessionAccessResolver,
} from "../bridge/session-access.js";
import { resolveHttpBridgeSession } from "../bridge/http-session-access.js";
import { CoreKnowledgeClient, type KnowledgeItem } from "./core-client.js";
import type { ProxyConfig } from "../types.js";

const TAG = "[knowledge-bridge]";

export interface KnowledgeBridgeDeps {
  fetcher?: typeof fetch;
  resolveSession: BridgeSessionAccessResolver;
}

export function createKnowledgeBridgeHandler(
  config: ProxyConfig,
  deps: KnowledgeBridgeDeps,
): (context: Context) => Promise<Response> {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const client = new CoreKnowledgeClient(config.knowledge, fetcher);

  return async (context): Promise<Response> => {
    const operation = extractOperation(new URL(context.req.url).pathname);
    if (!operation) return envelope(40401, `${TAG} unknown path`, 404);
    if (context.req.method !== "POST") {
      return envelope(40501, `${TAG} method not allowed`, 405);
    }
    if (!(context.req.header("content-type") ?? "").toLowerCase().includes("application/json")) {
      return envelope(41501, `${TAG} content-type must be application/json`, 415);
    }

    const resolved = await resolveHttpBridgeSession(context, deps.resolveSession);
    if (!resolved.ok) {
      return envelope(resolved.code, `${TAG} ${resolved.message}`, resolved.httpStatus);
    }
    const { access } = resolved;
    if (!access.userKey) return envelope(40301, `${TAG} caller authorization unavailable`, 403);
    if (access.capabilities.knowledge.wiki.enabled !== true &&
        access.capabilities.knowledge.codeGraph.enabled !== true) {
      return envelope(40301, `${TAG} knowledge capability is disabled`, 403);
    }

    const body = await parseBody(context, operation);
    if (body instanceof Response) return body;
    const knowledgeId = body.knowledge_id;
    const resources = await resolveAuthorizedResources(client, access, knowledgeId);
    const resource = resources.find((candidate) => candidate.knowledge_id === knowledgeId);
    if (!resource || !capabilityEnabled(resource, access.capabilities)) {
      return envelope(40301, `${TAG} knowledge asset is not authorized`, 403);
    }

    const serviceUrl = validatedServiceUrl(resource.service_url);
    if (!serviceUrl) return envelope(50201, `${TAG} knowledge service is unavailable`, 502);
    let response: Response;
    try {
      response = await fetcher(`${serviceUrl}/tools/${operation}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tdai-service-id": access.identity.serviceId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.knowledge.timeoutMs),
      });
    } catch (cause: unknown) {
      return isTimeoutError(cause)
        ? envelope(50401, `${TAG} upstream timed out`, 504)
        : envelope(50301, `${TAG} upstream unavailable`, 503);
    }
    if (!response.ok) return classifiedUpstreamFailure(response.status);
    const responseBody = await readUpstreamEnvelope(response);
    if (!responseBody) return envelope(50202, `${TAG} upstream returned malformed data`, 502);
    if (responseBody.code !== 0) {
      const applicationStatus = responseBody.code >= 10_000
        ? Math.floor(responseBody.code / 100)
        : responseBody.code;
      return applicationStatus >= 400 && applicationStatus <= 599
        ? classifiedUpstreamFailure(applicationStatus)
        : envelope(50202, `${TAG} upstream returned malformed data`, 502);
    }
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function resolveAuthorizedResources(
  client: CoreKnowledgeClient,
  access: BridgeSessionAccess,
  knowledgeId: string,
): Promise<KnowledgeItem[]> {
  const options = { serviceId: access.identity.serviceId };
  const visibleIds = await client.listAgentKnowledgeIds(
    access.identity.agentId,
    access.userKey ?? "",
    options,
  );
  if (!visibleIds.includes(knowledgeId)) return [];
  return client.listKnowledgeByIds(access.identity.teamId, [knowledgeId], options);
}

function capabilityEnabled(
  resource: KnowledgeItem,
  capabilities: BridgeSessionAccess["capabilities"],
): boolean {
  return resource.type === "wiki"
    ? capabilities.knowledge.wiki.enabled
    : capabilities.knowledge.codeGraph.enabled;
}

async function parseBody(
  context: Context,
  operation: "list" | "call",
): Promise<Record<string, unknown> & { knowledge_id: string } | Response> {
  let parsed: unknown;
  try {
    parsed = await context.req.json<unknown>();
  } catch {
    return envelope(40001, `${TAG} invalid JSON body`, 400);
  }
  if (!isRecord(parsed)) return envelope(40001, `${TAG} body must be a JSON object`, 400);
  const allowed = operation === "list"
    ? new Set(["knowledge_id"])
    : new Set(["knowledge_id", "tool_name", "params"]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) {
    return envelope(40001, `${TAG} body contains unsupported fields`, 400);
  }
  if (typeof parsed.knowledge_id !== "string" || !parsed.knowledge_id.trim()) {
    return envelope(40001, `${TAG} knowledge_id is required`, 400);
  }
  if (operation === "call" && (
    typeof parsed.tool_name !== "string" || !parsed.tool_name.trim() || !isRecord(parsed.params)
  )) {
    return envelope(40001, `${TAG} tool_name and object params are required`, 400);
  }
  return { ...parsed, knowledge_id: parsed.knowledge_id.trim() };
}

function extractOperation(path: string): "list" | "call" | null {
  const match = path.match(/^\/knowledge-bridge\/v3\/tools\/([^/]+)\/?$/);
  const operation = match?.[1];
  if (operation === "list" || operation === "call") return operation;
  return null;
}

function validatedServiceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function envelope(code: number, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message, request_id: `knowledge-bridge-${Date.now()}` }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function classifiedUpstreamFailure(status: number): Response {
  if (status === 408 || status === 504) {
    return envelope(50401, `${TAG} upstream timed out`, 504);
  }
  if (status === 429) return envelope(42901, `${TAG} upstream throttled`, 429);
  if (status >= 500) return envelope(50201, `${TAG} upstream failed`, 502);
  return envelope(40002, `${TAG} upstream rejected the request`, status);
}

async function readUpstreamEnvelope(
  response: Response,
): Promise<(Record<string, unknown> & { code: number }) | null> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) && typeof value.code === "number"
      ? { ...value, code: value.code }
      : null;
  } catch {
    return null;
  }
}

function isTimeoutError(cause: unknown): boolean {
  return cause instanceof DOMException && ["AbortError", "TimeoutError"].includes(cause.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

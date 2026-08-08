import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionNamespace } from "../../agent-sources.js";
import { DEFAULT_CONFIG } from "../../config.js";
import { __resetHookCacheRepoForTests } from "../../db/hookCacheRepo.js";
import { __resetDbForTests } from "../../db/index.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import { setCoreSkillClient } from "../../skill/core-client.js";
import type { ProxyConfig } from "../../types.js";
import {
  PARITY_AGENT,
  PARITY_IDENTITY,
  PARITY_SESSION_INFO,
  PARITY_TASK,
} from "../../__tests__/memory-parity/fixtures.js";
import { parseRequestBody } from "../../__tests__/memory-parity/test-support.js";
import { createOpenAIMemoryRuntime } from "../openai-production.js";

const roots: string[] = [];
const previousOutboxPath = process.env.PROXY_OUTBOX_PATH;
const previousDbPath = process.env.PROXY_DB_PATH;

afterEach(async () => {
  setCoreSkillClient(null);
  __resetSessionStoreForTests();
  __resetHookCacheRepoForTests();
  __resetDbForTests();
  vi.unstubAllGlobals();
  if (previousOutboxPath === undefined) delete process.env.PROXY_OUTBOX_PATH;
  else process.env.PROXY_OUTBOX_PATH = previousOutboxPath;
  if (previousDbPath === undefined) delete process.env.PROXY_DB_PATH;
  else process.env.PROXY_DB_PATH = previousDbPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenAI production MemoryRuntime", () => {
  it("resolves binding, enforces ACL/capabilities and durably delivers both channels", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-memory-runtime-"));
    roots.push(root);
    process.env.PROXY_DB_PATH = join(root, "proxy.db");
    process.env.PROXY_OUTBOX_PATH = join(root, "outbox.db");

    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.sessionInit.enabled = true;
    config.injection.enabled = false;
    config.tdai.enabled = true;
    config.tdai.endpoint = "http://memory.fixture";
    config.tdai.apiKey = "service-token";
    config.tdai.serviceId = "configured-space";
    config.tdai.memory.enabled = true;
    config.tdai.memory.writeL0 = true;
    config.coreSkill = {
      endpoint: "http://core.fixture",
      serviceToken: "core-token",
      serviceId: "configured-space",
      timeoutMs: 1_000,
    };

    const keyId = createSessionNamespace("codebuddy", PARITY_IDENTITY.sessionId);
    await getSessionStore().set(keyId, {
      status: "initialized",
      keyId,
      startedAt: 1,
      attemptCount: 0,
      userId: PARITY_IDENTITY.userId,
      sessionInfo: PARITY_SESSION_INFO,
      agentDetail: PARITY_AGENT,
      taskDetail: PARITY_TASK,
    });

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = parseRequestBody(init);
      requests.push({ url, body });
      if (url.endsWith("/v3/meta/acl/check")) {
        return response({ code: 0, data: { allowed: true } });
      }
      if (url.endsWith("/v3/meta/config/user/get")) {
        return response({ code: 0, data: { items: [] } });
      }
      if (url.endsWith("/v3/conversation/add")) {
        return response({
          code: 0,
          data: {
            accepted_ids: ["message-1", "message-2"],
            accepted_versions: ["v1", "v1"],
            total_count: 2,
            receipt: {
              source_event_id: body.source_event_id,
              content_hash: body.content_hash,
              status: "committed",
              committed_at: "2026-08-08T00:00:00.000Z",
            },
          },
        });
      }
      if (url.endsWith("/v3/skill/conversation/add")) {
        return response({
          code: 0,
          data: {
            status: "ok",
            receipt: {
              receipt_id: "skill-receipt-1",
              source_event_id: body.source_event_id,
              content_hash: body.content_hash,
              accepted_at_ms: 1,
            },
          },
        });
      }
      throw new Error(`unexpected fixture URL: ${url}`);
    }));

    const managed = await createOpenAIMemoryRuntime(config);
    try {
      const runtime = managed.provider.forRequest({ userKey: "client-user-key" });
      await expect(runtime.prepareContext({
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          userId: PARITY_IDENTITY.userId,
          agentSource: "codebuddy",
          sessionId: PARITY_IDENTITY.sessionId,
        },
      })).resolves.toMatchObject({
        session: { identity: { teamId: PARITY_IDENTITY.teamId } },
        capabilities: { memory: { enabled: true }, skill: { enabled: true } },
      });

      await expect(runtime.commitCompletedRound({
        sourceEventId: "proxy:openai:fixture",
        identity: {
          serviceId: PARITY_IDENTITY.spaceId,
          userId: PARITY_IDENTITY.userId,
          agentSource: "codebuddy",
          sessionId: PARITY_IDENTITY.sessionId,
          turnId: "turn-1",
        },
        realPrompt: "hello",
        events: [],
        finalResponse: "done",
      })).resolves.toMatchObject({ status: "enqueued" });
      await expect(managed.drain()).resolves.toEqual({ committed: 1, retried: 0, dead: 0 });
      await expect(managed.provider.health?.()).resolves.toMatchObject({
        pendingCount: 0,
        retryingCount: 0,
        deadCount: 0,
      });
    } finally {
      await managed.shutdown();
    }

    expect(requests.filter((entry) => entry.url.endsWith("/v3/meta/acl/check"))).toHaveLength(2);
    expect(requests.some((entry) => entry.url.endsWith("/v3/conversation/add"))).toBe(true);
    expect(requests.some((entry) => entry.url.endsWith("/v3/skill/conversation/add"))).toBe(true);
  });
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

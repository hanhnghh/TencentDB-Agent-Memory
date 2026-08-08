import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config.js";
import { createHookApp } from "../hook-server.js";
import { RuntimeHealth } from "../runtime/health.js";
import { createApp } from "../server.js";
import type { ProxyConfig } from "../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime mode route isolation", () => {
  it("serves hook health without exposing proxy forwarding routes", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "hooks";
    config.upstream.url = "";
    const app = createHookApp(config);

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      mode: "hooks",
      listeners: {
        proxy: { enabled: false },
        hooks: { enabled: true },
      },
      durableStore: { ready: true },
      connectivity: {
        upstream: "disabled",
        creditReport: "disabled",
      },
    });
    expect((await app.request("/v1/chat/completions", { method: "POST" })).status)
      .toBe(404);
  });

  it("never forwards local sidecar paths through the public proxy catch-all", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "both";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const app = createApp(config);

    for (const path of [
      "/hooks/session-start",
      "/hooks%2Fsession-start",
      "/h%6foks%2fsession-start",
      "/knowledge-bridge/v3/tools/list",
      "/knowledge%2dbridge%2fv3%2ftools%2flist",
      "/codex/manage/refresh",
      "/%2Fcodex%2Fmanage%2Frefresh",
      "/hooks%ZZsession-start",
    ]) {
      const encodedResponse = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "SessionStart" }),
      });
      expect([400, 404]).toContain(encodedResponse.status);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reports shared listener, durable-store and redacted connectivity state", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "both";
    config.upstream.url = "https://upstream.secret.example/v1";
    config.upstream.apiKey = "server-secret";
    config.coreSkill.serviceToken = "memory-secret";
    const provider = {
      forRequest: () => {
        throw new Error("health must not create a request runtime");
      },
      health: async () => ({
        pendingCount: 2,
        inflightCount: 0,
        retryingCount: 1,
        deadCount: 0,
        oldestPendingAgeMs: 120,
      }),
    };
    const health = new RuntimeHealth(config, provider);
    health.markListenerReady("proxy", "0.0.0.0", 8096);
    health.markListenerReady("hooks", "127.0.0.1", 8097);
    health.recordConnectivity({ upstream: "ok", memoryCore: "failed" });
    const proxyApp = createApp(config, { memoryRuntimeProvider: provider, runtimeHealth: health });
    const hookApp = createHookApp(config, { memoryRuntimeProvider: provider, runtimeHealth: health });

    const proxyResponse = await proxyApp.request("/health");
    const hookResponse = await hookApp.request("/health");
    expect(proxyResponse.status).toBe(503);
    expect(hookResponse.status).toBe(503);
    const proxyBody: unknown = await proxyResponse.json();
    const hookBody: unknown = await hookResponse.json();

    expect(hookBody).toEqual(proxyBody);
    expect(hookBody).toMatchObject({
      mode: "both",
      upstream: "configured",
      opik: "disabled",
      costGuard: "disabled",
      rateLimit: "enabled",
      listeners: {
        proxy: { enabled: true, ready: true, host: "0.0.0.0", port: 8096 },
        hooks: { enabled: true, ready: true, host: "127.0.0.1", port: 8097 },
      },
      durableStore: {
        ready: true,
        outbox: { pendingCount: 2, retryingCount: 1, deadCount: 0 },
      },
      storage: {
        enabled: false,
        degraded: false,
      },
      memoryRuntime: { pendingCount: 2, retryingCount: 1, deadCount: 0 },
      connectivity: { upstream: "ok", memoryCore: "failed" },
    });
    const serialized = JSON.stringify(hookBody);
    expect(serialized).not.toContain("upstream.secret.example");
    expect(serialized).not.toContain("server-secret");
    expect(serialized).not.toContain("memory-secret");
  });

  it("keeps standalone app health backward-compatible", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    const app = createApp(config);

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("keeps startup readiness unavailable while active connectivity checks are pending", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    const health = new RuntimeHealth(config);
    health.markListenerReady("proxy", config.server.host, config.server.port);
    const app = createApp(config, { runtimeHealth: health, storesActivated: true });

    const response = await app.request("/health");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "starting" });
  });

  it("reports an unhealthy durable outbox as unavailable", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "hooks";
    config.upstream.url = "";
    const provider = {
      forRequest: () => {
        throw new Error("health must not create a request runtime");
      },
      health: async () => ({
        pendingCount: 0,
        inflightCount: 0,
        retryingCount: 0,
        deadCount: 1,
        oldestPendingAgeMs: 0,
      }),
    };
    const app = createHookApp(config, { memoryRuntimeProvider: provider });

    const response = await app.request("/health");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      durableStore: { ready: false, outbox: { deadCount: 1 } },
    });
  });

  it.each([
    ["server-key", "server-key"],
    ["client-key", "client-key"],
  ] as const)("preserves proxy %s authorization", async (configuredKey, expectedKey) => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "proxy";
    config.upstream.url = "http://upstream.fixture/v1/chat/completions";
    config.upstream.apiKey = configuredKey === "server-key" ? configuredKey : "";
    const seenAuthorization: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({
        id: "chatcmpl-runtime-mode",
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const app = createApp(config);

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer client-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(seenAuthorization).toEqual([`Bearer ${expectedKey}`]);
  });
});

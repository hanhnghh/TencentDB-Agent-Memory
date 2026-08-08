import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { DEFAULT_CONFIG } from "../../config.js";
import {
  __resetHookCacheRepoForTests,
  getHookCacheRepo,
} from "../../db/hookCacheRepo.js";
import { __resetSessionRepoForTests } from "../../db/sessionRepo.js";
import { KvHookCacheRepo } from "../../db/kv-hook-cache-repo.js";
import { __resetSessionStoreForTests } from "../../session/store.js";
import { __resetProxyStorageForTests } from "../../storage/factory.js";
import type { ProxyConfig } from "../../types.js";
import {
  startRuntime,
  type ForwardingRuntime,
  type RuntimeListenerAdapter,
} from "../startup.js";

const roots: string[] = [];
const previousOutboxPath = process.env.PROXY_OUTBOX_PATH;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (previousOutboxPath === undefined) delete process.env.PROXY_OUTBOX_PATH;
  else process.env.PROXY_OUTBOX_PATH = previousOutboxPath;
  __resetHookCacheRepoForTests();
  __resetSessionRepoForTests();
  __resetSessionStoreForTests();
  __resetProxyStorageForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mode-aware runtime startup", () => {
  it("starts hooks mode with only a loopback listener and no forwarding connectivity", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooks-runtime-startup-"));
    roots.push(root);
    process.env.PROXY_OUTBOX_PATH = join(root, "outbox.db");
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "hooks";
    config.upstream.url = "";
    config.storage.enabled = true;
    config.storage.backend = "memory";
    config.extraction.enabled = false;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const forwardingLoader = vi.fn<() => Promise<ForwardingRuntime>>();
    const listenerAdapter: RuntimeListenerAdapter = {
      listen: async ({ host, port }) => ({
        host,
        port,
        close: async () => undefined,
      }),
    };

    const running = await startRuntime(config, { listenerAdapter, forwardingLoader });
    try {
      await running.connectivityChecked;
      await expect(running.health.snapshot()).resolves.toMatchObject({
        status: "ok",
        mode: "hooks",
        listeners: {
          proxy: { enabled: false, ready: false },
          hooks: { enabled: true, ready: true, host: "127.0.0.1", port: 8097 },
        },
        connectivity: {
          upstream: "disabled",
          creditReport: "disabled",
        },
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(forwardingLoader).not.toHaveBeenCalled();
      expect(getHookCacheRepo()).toBeInstanceOf(KvHookCacheRepo);
    } finally {
      await running.stop();
    }
  });

  it("starts proxy mode with only its public listener", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "proxy";
    config.creditReport.url = "";
    config.storage.enabled = true;
    config.storage.backend = "memory";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("reachable", { status: 401 })));
    const seenKinds: string[] = [];
    const listenerAdapter: RuntimeListenerAdapter = {
      listen: async ({ kind, host, port }) => {
        seenKinds.push(kind);
        return { host, port, close: async () => undefined };
      },
    };
    const shutdown = vi.fn(async () => undefined);
    const forwardingLoader = vi.fn(async (): Promise<ForwardingRuntime> => ({
      createApp: () => new Hono(),
      shutdown,
    }));

    const running = await startRuntime(config, { listenerAdapter, forwardingLoader });
    await running.connectivityChecked;
    await expect(running.health.snapshot()).resolves.toMatchObject({
      status: "ok",
      mode: "proxy",
      listeners: {
        proxy: { enabled: true, ready: true },
        hooks: { enabled: false, ready: false },
      },
    });
    expect(seenKinds).toEqual(["proxy"]);
    expect(forwardingLoader).toHaveBeenCalledOnce();
    await running.stop();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("cleans up an already-open listener when the second listener fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "failed-runtime-startup-"));
    roots.push(root);
    process.env.PROXY_OUTBOX_PATH = join(root, "outbox.db");
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "both";
    config.extraction.enabled = false;
    config.storage.enabled = true;
    config.storage.backend = "memory";
    const close = vi.fn(async () => undefined);
    const listenerAdapter: RuntimeListenerAdapter = {
      listen: vi.fn(async ({ kind, host, port }) => {
        if (kind === "hooks") throw new Error("hook listener failed");
        return { host, port, close };
      }),
    };
    const shutdown = vi.fn(async () => undefined);
    const forwardingLoader = async (): Promise<ForwardingRuntime> => ({
      createApp: () => new Hono(),
      shutdown,
    });

    await expect(startRuntime(config, { listenerAdapter, forwardingLoader }))
      .rejects.toThrow("hook listener failed");
    expect(close).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("drains the bounded connectivity check before dependency shutdown", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "proxy";
    config.creditReport.url = "";
    config.storage.enabled = true;
    config.storage.backend = "memory";
    let releaseFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    })));
    const listenerAdapter: RuntimeListenerAdapter = {
      listen: async ({ host, port }) => ({
        host,
        port,
        close: async () => undefined,
      }),
    };
    const shutdown = vi.fn(async () => undefined);
    const forwardingLoader = async (): Promise<ForwardingRuntime> => ({
      createApp: () => new Hono(),
      shutdown,
    });
    const running = await startRuntime(config, { listenerAdapter, forwardingLoader });

    const stopping = running.stop();
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    if (!releaseFetch) throw new Error("connectivity probe did not start");
    releaseFetch(new Response("reachable", { status: 401 }));
    await stopping;

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("starts both listeners separately over one shared health state", async () => {
    const root = await mkdtemp(join(tmpdir(), "both-runtime-startup-"));
    roots.push(root);
    process.env.PROXY_OUTBOX_PATH = join(root, "outbox.db");
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "both";
    config.server.host = "127.0.0.1";
    config.server.port = 0;
    config.runtime.hooks.port = 0;
    config.storage.enabled = true;
    config.storage.backend = "memory";
    config.extraction.enabled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));

    const running = await startRuntime(config);
    try {
      await running.connectivityChecked;
      const snapshot = await running.health.snapshot();
      const proxyPort = snapshot.listeners.proxy.port;
      const hookPort = snapshot.listeners.hooks.port;
      expect(proxyPort).not.toBe(hookPort);

      const proxyHealth = await requestJson(proxyPort, "/health");
      const hookHealth = await requestJson(hookPort, "/health");
      expect(hookHealth.body).toEqual(proxyHealth.body);
      expect(hookHealth.body).toMatchObject({
        mode: "both",
        listeners: {
          proxy: { enabled: true, ready: true },
          hooks: { enabled: true, ready: true },
        },
      });
      expect((await requestJson(proxyPort, "/hooks/session-start", "POST")).status)
        .toBe(404);
      expect((await requestJson(hookPort, "/v1/chat/completions", "POST")).status)
        .toBe(404);
    } finally {
      await running.stop();
    }
  });
});

function requestJson(
  port: number,
  path: string,
  method = "GET",
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          const body: unknown = response.headers["content-type"]?.includes("application/json")
            ? JSON.parse(text)
            : text;
          resolve({ status: response.statusCode ?? 0, body });
        } catch (error: unknown) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

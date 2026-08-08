import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import type { ProxyConfig } from "../../types.js";
import {
  startRuntime,
  type RuntimeListenerAdapter,
} from "../startup.js";

const roots: string[] = [];
const previousOutboxPath = process.env.PROXY_OUTBOX_PATH;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (previousOutboxPath === undefined) delete process.env.PROXY_OUTBOX_PATH;
  else process.env.PROXY_OUTBOX_PATH = previousOutboxPath;
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
    const listenerAdapter: RuntimeListenerAdapter = {
      listen: async ({ host, port }) => ({
        host,
        port,
        close: async () => undefined,
      }),
    };

    const running = await startRuntime(config, { listenerAdapter });
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
    } finally {
      await running.stop();
    }
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

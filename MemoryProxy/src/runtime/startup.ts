import { serve } from "@hono/node-server";
import type { Hono } from "hono";

import { initAuth } from "../auth.js";
import { initClickHouse, shutdownClickHouse } from "../clickhouse.js";
import { checkConnectivity } from "../connectivity.js";
import { setExtensionDebug, shutdownGuard } from "../guard-adapter.js";
import { createHookApp } from "../hook-server.js";
import { initLangfuse, shutdownLangfuse } from "../langfuse.js";
import { initLogger, log, shutdownLogger } from "../report/log.js";
import { createApp } from "../server.js";
import { initProxyStorage } from "../storage/factory.js";
import { initSystemUsers } from "../systemUser.js";
import type { ProxyConfig } from "../types.js";
import { RuntimeHealth, type ListenerKind } from "./health.js";
import { planRuntime } from "./mode.js";
import {
  createMemoryRuntime,
  type ManagedMemoryRuntime,
} from "./production.js";

export interface RuntimeListenerInput {
  kind: ListenerKind;
  app: Hono;
  host: string;
  port: number;
}

export interface RunningListener {
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface RuntimeListenerAdapter {
  listen(input: RuntimeListenerInput): Promise<RunningListener>;
}

export interface StartRuntimeOptions {
  listenerAdapter?: RuntimeListenerAdapter;
}

export interface RunningRuntime {
  health: RuntimeHealth;
  connectivityChecked: Promise<void>;
  stop(): Promise<void>;
}

/** Own the complete process lifecycle for proxy, hooks, or both modes. */
export async function startRuntime(
  config: ProxyConfig,
  options: StartRuntimeOptions = {},
): Promise<RunningRuntime> {
  const plan = planRuntime(config);
  const listenerAdapter = options.listenerAdapter ?? nodeListenerAdapter;
  const listeners: RunningListener[] = [];
  let memoryRuntime: ManagedMemoryRuntime | undefined;
  let stopped = false;

  initLogger({
    level: config.log.level === "debug" ? "debug" : "info",
    filePath: config.log.file || "",
    rotate: config.log.rotate,
    backend: config.log.backend,
  });

  try {
    await initProxyStorage(config.storage);
    if (plan.dependencies.memoryRuntime) {
      memoryRuntime = await createMemoryRuntime(config);
    }

    if (plan.dependencies.forwarding) {
      initializeForwardingDependencies(config);
    }

    const health = new RuntimeHealth(config, memoryRuntime?.provider);
    if (plan.listeners.proxy.enabled) {
      const listener = await listenerAdapter.listen({
        kind: "proxy",
        app: createApp(config, {
          memoryRuntimeProvider: memoryRuntime?.provider,
          runtimeHealth: health,
        }),
        host: plan.listeners.proxy.host,
        port: plan.listeners.proxy.port,
      });
      listeners.push(listener);
      health.markListenerReady("proxy", listener.host, listener.port);
      log.info("runtime.listener_ready", {
        kind: "proxy",
        host: listener.host,
        port: listener.port,
      });
    }
    if (plan.listeners.hooks.enabled) {
      const listener = await listenerAdapter.listen({
        kind: "hooks",
        app: createHookApp(config, {
          memoryRuntimeProvider: memoryRuntime?.provider,
          runtimeHealth: health,
        }),
        host: plan.listeners.hooks.host,
        port: plan.listeners.hooks.port,
      });
      listeners.push(listener);
      health.markListenerReady("hooks", listener.host, listener.port);
      log.info("runtime.listener_ready", {
        kind: "hooks",
        host: listener.host,
        port: listener.port,
      });
    }

    const connectivityChecked = checkConnectivity(config)
      .then((summary) => {
        health.recordConnectivity(summary);
      })
      .catch((error: unknown) => {
        log.warn("connectivity.check_error", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
        health.recordConnectivity({ runtime: "failed" });
      });

    return {
      health,
      connectivityChecked,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        await closeListeners(listeners);
        if (plan.dependencies.forwarding) {
          await shutdownGuard();
          await shutdownLangfuse();
          await shutdownClickHouse();
        }
        await memoryRuntime?.shutdown();
        await shutdownLogger();
      },
    };
  } catch (error: unknown) {
    await closeListeners(listeners);
    if (plan.dependencies.forwarding) {
      await shutdownGuard();
      await shutdownLangfuse();
      await shutdownClickHouse();
    }
    await memoryRuntime?.shutdown();
    await shutdownLogger();
    throw error;
  }
}

function initializeForwardingDependencies(config: ProxyConfig): void {
  setExtensionDebug(config.log.level === "debug");
  initClickHouse(config.clickhouse);
  void initLangfuse(config).catch((error: unknown) => {
    log.warn("langfuse.init_error", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
  });
  initAuth(config.auth);
  initSystemUsers(config.systemUsers);
}

async function closeListeners(listeners: RunningListener[]): Promise<void> {
  await Promise.all([...listeners].reverse().map((listener) => listener.close()));
}

const nodeListenerAdapter: RuntimeListenerAdapter = {
  listen: ({ app, host, port }) => new Promise<RunningListener>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, ({ address, port: boundPort }) => {
      server.off("error", reject);
      resolve({
        host: address,
        port: boundPort,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => {
            if (error) closeReject(error);
            else closeResolve();
          });
        }),
      });
    });
    server.once("error", reject);
  }),
};

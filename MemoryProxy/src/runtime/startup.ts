import { serve } from "@hono/node-server";
import type { Hono } from "hono";

import { checkConnectivity } from "../connectivity.js";
import { createHookApp } from "../hook-server.js";
import { tryActivateRedis, tryActivateStorage } from "../injection/index.js";
import { initLogger, log, shutdownLogger } from "../report/log.js";
import { initProxyStorage } from "../storage/factory.js";
import type { ProxyConfig } from "../types.js";
import { RuntimeHealth, type ListenerKind } from "./health.js";
import { planRuntime } from "./mode.js";
import {
  createMemoryRuntime,
  type ManagedMemoryRuntime,
  type MemoryRuntimeProvider,
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

export interface ForwardingRuntime {
  createApp(
    config: ProxyConfig,
    options: {
      memoryRuntimeProvider?: MemoryRuntimeProvider;
      runtimeHealth: RuntimeHealth;
      storesActivated: true;
    },
  ): Hono;
  shutdown(): Promise<void>;
}

export interface StartRuntimeOptions {
  listenerAdapter?: RuntimeListenerAdapter;
  forwardingLoader?: (config: ProxyConfig) => Promise<ForwardingRuntime>;
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
  const forwardingLoader = options.forwardingLoader ?? loadForwardingRuntime;
  const listeners: RunningListener[] = [];
  let memoryRuntime: ManagedMemoryRuntime | undefined;
  let forwardingRuntime: ForwardingRuntime | undefined;
  let stopPromise: Promise<void> | undefined;

  initLogger({
    level: config.log.level === "debug" ? "debug" : "info",
    filePath: config.log.file || "",
    rotate: config.log.rotate,
    backend: config.log.backend,
  });

  try {
    await initProxyStorage(config.storage);
    if (!tryActivateStorage(config)) {
      tryActivateRedis(config);
    }
    if (plan.dependencies.memoryRuntime) {
      memoryRuntime = await createMemoryRuntime(config);
    }

    if (plan.dependencies.forwarding) {
      forwardingRuntime = await forwardingLoader(config);
    }

    const health = new RuntimeHealth(config, memoryRuntime?.provider);
    if (plan.listeners.proxy.enabled) {
      if (!forwardingRuntime) {
        throw new Error("forwarding runtime missing for active proxy listener");
      }
      const listener = await listenerAdapter.listen({
        kind: "proxy",
        app: forwardingRuntime.createApp(config, {
          memoryRuntimeProvider: memoryRuntime?.provider,
          runtimeHealth: health,
          storesActivated: true,
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
      stop(): Promise<void> {
        stopPromise ??= cleanupRuntime({
          listeners,
          connectivityChecked,
          forwardingRuntime,
          memoryRuntime,
        }).then((errors) => {
          throwCleanupErrors(errors, "runtime shutdown failed");
        });
        return stopPromise;
      },
    };
  } catch (error: unknown) {
    const cleanupErrors = await cleanupRuntime({
      listeners,
      forwardingRuntime,
      memoryRuntime,
    });
    if (cleanupErrors.length > 0) {
      const message = error instanceof Error ? error.message : "runtime startup failed";
      throw new AggregateError([error, ...cleanupErrors], message);
    }
    throw error;
  }
}

/** Load and initialize forwarding-only modules only when proxy traffic is active. */
async function loadForwardingRuntime(config: ProxyConfig): Promise<ForwardingRuntime> {
  const [auth, clickhouse, guard, langfuse, server, systemUsers] = await Promise.all([
    import("../auth.js"),
    import("../clickhouse.js"),
    import("../guard-adapter.js"),
    import("../langfuse.js"),
    import("../server.js"),
    import("../systemUser.js"),
  ]);
  guard.setExtensionDebug(config.log.level === "debug");
  clickhouse.initClickHouse(config.clickhouse);
  await langfuse.initLangfuse(config);
  auth.initAuth(config.auth);
  systemUsers.initSystemUsers(config.systemUsers);

  return {
    createApp: server.createApp,
    async shutdown(): Promise<void> {
      const results = await Promise.allSettled([
        guard.shutdownGuard(),
        langfuse.shutdownLangfuse(),
        clickhouse.shutdownClickHouse(),
      ]);
      throwCleanupErrors(rejectedReasons(results), "forwarding shutdown failed");
    },
  };
}

async function closeListeners(listeners: RunningListener[]): Promise<void> {
  const results = await Promise.allSettled(
    [...listeners].reverse().map((listener) => listener.close()),
  );
  throwCleanupErrors(rejectedReasons(results), "listener shutdown failed");
}

async function cleanupRuntime(input: {
  listeners: RunningListener[];
  connectivityChecked?: Promise<void>;
  forwardingRuntime?: ForwardingRuntime;
  memoryRuntime?: ManagedMemoryRuntime;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  const steps: Array<() => Promise<unknown>> = [() => closeListeners(input.listeners)];
  const connectivityChecked = input.connectivityChecked;
  if (connectivityChecked) steps.push(() => connectivityChecked);
  const forwardingRuntime = input.forwardingRuntime;
  if (forwardingRuntime) steps.push(() => forwardingRuntime.shutdown());
  const memoryRuntime = input.memoryRuntime;
  if (memoryRuntime) steps.push(() => memoryRuntime.shutdown());
  steps.push(() => shutdownLogger());
  for (const step of steps) {
    try {
      await step();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  return errors;
}

function rejectedReasons(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
}

function throwCleanupErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
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

import { Hono } from "hono";

import { RuntimeHealth } from "./runtime/health.js";
import type { MemoryRuntimeProvider } from "./runtime/production.js";
import type { ProxyConfig } from "./types.js";

export interface CreateHookAppOptions {
  memoryRuntimeProvider?: MemoryRuntimeProvider;
  runtimeHealth?: RuntimeHealth;
}

/** Build the loopback listener app. Lifecycle routes are added by hook adapters. */
export function createHookApp(
  config: ProxyConfig,
  options: CreateHookAppOptions = {},
): Hono {
  const app = new Hono();
  const health = options.runtimeHealth ?? new RuntimeHealth(
    config,
    options.memoryRuntimeProvider,
  );
  if (!options.runtimeHealth) {
    health.markListenerReady("hooks", config.runtime.hooks.host, config.runtime.hooks.port);
  }
  app.get("/health", async (c) => c.json(await health.snapshot()));
  return app;
}

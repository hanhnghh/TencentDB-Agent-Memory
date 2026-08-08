import { Hono } from "hono";

import { CodexHookService } from "./codex/hook-service.js";
import type { CodexHookAccessResolver } from "./codex/hook-access.js";
import type { CodexTurnStore } from "./codex/turn-store.js";
import { RuntimeHealth, runtimeHealthStatusCode } from "./runtime/health.js";
import type { MemoryRuntimeProvider } from "./runtime/production.js";
import type { ProxyConfig } from "./types.js";

export interface CreateHookAppOptions {
  memoryRuntimeProvider?: MemoryRuntimeProvider;
  runtimeHealth?: RuntimeHealth;
  codexAccessResolver?: CodexHookAccessResolver;
  codexTurnStore?: CodexTurnStore;
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
    { trackConnectivity: false },
  );
  if (!options.runtimeHealth) {
    health.markListenerReady("hooks", config.runtime.hooks.host, config.runtime.hooks.port);
  }
  const hookService = options.memoryRuntimeProvider && options.codexAccessResolver && options.codexTurnStore
    ? new CodexHookService({
        memoryRuntimeProvider: options.memoryRuntimeProvider,
        accessResolver: options.codexAccessResolver,
        turnStore: options.codexTurnStore,
      })
    : undefined;
  app.get("/health", async (c) => {
    const body = await health.snapshot();
    return c.json(body, runtimeHealthStatusCode(body));
  });
  app.post("/hooks/session-start", async (c) => {
    if (!hookService) return jsonResponse(503, { error: "hook_runtime_unavailable" });
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
    const result = await hookService.sessionStart(input);
    return jsonResponse(result.status, result.body);
  });
  app.post("/hooks/user-prompt-submit", async (c) => {
    if (!hookService) return jsonResponse(503, { error: "hook_runtime_unavailable" });
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
    const result = await hookService.userPromptSubmit(input);
    return jsonResponse(result.status, result.body);
  });
  return app;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

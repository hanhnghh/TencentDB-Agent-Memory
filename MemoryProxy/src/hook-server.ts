import { Hono, type Context } from "hono";

import { CodexHookService, type CodexHookResponse } from "./codex/hook-service.js";
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
  app.post("/hooks/session-start", (c) => dispatchHook(c, hookService, (service, input) =>
    service.sessionStart(input)));
  app.post("/hooks/user-prompt-submit", (c) => dispatchHook(c, hookService, (service, input) =>
    service.userPromptSubmit(input)));
  app.post("/hooks/post-tool-use", (c) => dispatchHook(c, hookService, (service, input) =>
    service.postToolUse(input)));
  app.post("/hooks/stop", (c) => dispatchHook(c, hookService, (service, input) =>
    service.stop(input)));
  app.post("/hooks/session-end", (c) => dispatchHook(c, hookService, (service, input) =>
    service.sessionEnd(input)));
  return app;
}

async function dispatchHook(
  context: Context,
  service: CodexHookService | undefined,
  handle: (service: CodexHookService, input: unknown) => Promise<CodexHookResponse>,
): Promise<Response> {
  if (!service) return jsonResponse(503, { error: "hook_runtime_unavailable" });
  let input: unknown;
  try {
    input = await context.req.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const result = await handle(service, input);
  return jsonResponse(result.status, result.body);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

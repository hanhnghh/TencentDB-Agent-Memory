/** Entry point: parse config, start server. */

if (!process.version.startsWith("v22.")) {
  console.error(`\x1b[31m[ERROR] Node.js version check failed!\x1b[0m`);
  console.error(`\x1b[31m[ERROR] Required Node.js version: v22.x\x1b[0m`);
  console.error(`\x1b[31m[ERROR] Current Node.js version is: ${process.version}\x1b[0m`);
  console.error(`\x1b[33m[TIP] Please run with Node.js v22. You can switch using:\x1b[0m`);
  console.error(`\x1b[33m      source ~/.nvm/nvm.sh && nvm use 22\x1b[0m`);
  process.exit(1);
}

import { buildConfig, parseArgv } from "./config.js";
import { log } from "./report/log.js";
import { startRuntime } from "./runtime/startup.js";

const overrides = parseArgv(process.argv);
const config = buildConfig(overrides);
const running = await startRuntime(config);
const health = await running.health.snapshot();
log.info("runtime.started", {
  mode: health.mode,
  proxyReady: health.listeners.proxy.ready,
  hookReady: health.listeners.hooks.ready,
  durableStoreReady: health.durableStore.ready,
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function gracefulShutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  log.info("runtime.shutdown", { signal, mode: config.runtime.mode });
  await running.stop();
  process.exit(0);
}

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });

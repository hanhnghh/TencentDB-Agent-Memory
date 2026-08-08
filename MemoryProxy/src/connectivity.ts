/**
 * Startup connectivity checker — probes all enabled external dependencies
 * and logs a unified connectivity report. Non-blocking, fire-and-forget.
 */

import { log } from "./report/log.js";
import type { ConnectivityStatus } from "./runtime/health.js";
import type { ProxyConfig } from "./types.js";

const TIMEOUT = 5000;

export async function checkConnectivity(
  config: ProxyConfig,
): Promise<Record<string, ConnectivityStatus>> {
  const probes: Record<string, Promise<ConnectivityStatus>> = {};
  const summary: Record<string, ConnectivityStatus> = {};
  const forwardingEnabled = config.runtime.mode !== "hooks";

  // Upstream LLM
  if (forwardingEnabled) probes["upstream"] = probe(config.upstream.url);
  else summary["upstream"] = "disabled";

  // ClickHouse
  if (forwardingEnabled && config.clickhouse.enabled && config.clickhouse.url) {
    const ch = config.clickhouse;
    const headers: Record<string, string> = {};
    if (ch.user) headers["X-ClickHouse-User"] = ch.user;
    if (ch.password) headers["X-ClickHouse-Key"] = ch.password;
    probes["clickhouse"] = probe(`${ch.url.replace(/\/+$/, "")}/?query=${encodeURIComponent("SELECT 1")}`, headers);
  }

  // Redis
  if (config.redis.enabled) {
    probes["redis"] = probeRedis(config.redis);
  }

  // Opik
  if (forwardingEnabled && config.opik.enabled && config.opik.url) {
    probes["opik"] = probe(`${config.opik.url.replace(/\/+$/, "")}/is-alive/ping`);
  }

  // Langfuse
  if (forwardingEnabled && config.langfuse.enabled && config.langfuse.host) {
    probes["langfuse"] = probe(`${config.langfuse.host.replace(/\/+$/, "")}/api/public/health`);
  }

  // Auth
  if (forwardingEnabled && config.auth.enabled && config.auth.url) {
    probes["auth"] = probe(config.auth.url);
  }

  // Credit report
  if (forwardingEnabled && config.creditReport.url) {
    probes["creditReport"] = probe(config.creditReport.url);
  } else summary["creditReport"] = "disabled";

  if (config.coreSkill.endpoint && config.coreSkill.serviceToken) {
    probes["memoryCore"] = probe(config.coreSkill.endpoint);
  }
  if (config.tdai.enabled && config.tdai.endpoint) {
    probes["tdai"] = probe(config.tdai.endpoint);
  }
  if (config.knowledge.enabled && config.knowledge.endpoint) {
    probes["knowledge"] = probe(config.knowledge.endpoint);
  }

  // Await all
  let allOk = true;
  for (const [name, p] of Object.entries(probes)) {
    const result = await p;
    summary[name] = result;
    if (result === "failed") allOk = false;
  }

  if (allOk) {
    log.info("connectivity.check", { result: "all_ok", ...summary });
  } else {
    log.warn("connectivity.check", { result: "some_failed", ...summary });
  }
  return summary;
}

/** Probe an HTTP endpoint without exposing its URL or failure detail. */
async function probe(
  url: string,
  headers?: Record<string, string>,
): Promise<ConnectivityStatus> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers,
      redirect: "follow",
    });
    await resp.text().catch(() => {});
    // This is a reachability probe, not an endpoint contract check. Several
    // configured targets are authenticated or POST-only and legitimately
    // answer an unauthenticated GET with 401/404/405.
    return "ok";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

/** Probe Redis with PING. */
async function probeRedis(
  cfg: ProxyConfig["redis"],
): Promise<ConnectivityStatus> {
  try {
    const { default: Redis } = await import("ioredis");
    const client = cfg.url
      ? new Redis(cfg.url, { lazyConnect: true, connectTimeout: TIMEOUT, maxRetriesPerRequest: 0 })
      : new Redis({ host: cfg.host || "127.0.0.1", port: cfg.port || 6379, password: cfg.password || undefined, db: cfg.db ?? 0, lazyConnect: true, connectTimeout: TIMEOUT, maxRetriesPerRequest: 0 });
    await client.connect();
    await client.ping();
    await client.quit();
    return "ok";
  } catch {
    return "failed";
  }
}

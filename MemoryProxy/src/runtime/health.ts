import type { OutboxHealth } from "../outbox/index.js";
import { getEffectiveBackend } from "../storage/factory.js";
import type { ProxyConfig } from "../types.js";
import { planRuntime, type RuntimePlan } from "./mode.js";
import type { MemoryRuntimeProvider } from "./production.js";

export type ListenerKind = "proxy" | "hooks";
export type ConnectivityStatus = "pending" | "ok" | "failed" | "disabled";

interface ListenerHealth {
  enabled: boolean;
  ready: boolean;
  host: string;
  port: number;
}

export interface RuntimeHealthSnapshot {
  status: "ok" | "starting" | "degraded";
  version: string;
  mode: ProxyConfig["runtime"]["mode"];
  upstream: "configured" | "disabled";
  opik: "configured" | "disabled";
  costGuard: "enabled" | "disabled";
  rateLimit: "enabled" | "disabled";
  listeners: Record<ListenerKind, ListenerHealth>;
  durableStore: {
    ready: boolean;
    storage: {
      enabled: boolean;
      requested: string;
      effective: string;
      degraded: boolean;
    };
    outbox: OutboxHealth | { state: "disabled" };
  };
  storage: RuntimeHealthSnapshot["durableStore"]["storage"];
  memoryRuntime?: OutboxHealth;
  connectivity: Record<string, ConnectivityStatus>;
}

/** Shared mutable readiness state observed identically by both listeners. */
export class RuntimeHealth {
  private readonly plan: RuntimePlan;
  private readonly listeners: Record<ListenerKind, ListenerHealth>;
  private connectivity: Record<string, ConnectivityStatus> = {};

  constructor(
    private readonly config: ProxyConfig,
    private readonly memoryRuntimeProvider?: MemoryRuntimeProvider,
  ) {
    this.plan = planRuntime(config);
    this.connectivity = initialConnectivity(config);
    this.listeners = {
      proxy: { ...this.plan.listeners.proxy, ready: false },
      hooks: { ...this.plan.listeners.hooks, ready: false },
    };
  }

  markListenerReady(kind: ListenerKind, host: string, port: number): void {
    this.listeners[kind] = {
      ...this.listeners[kind],
      ready: true,
      host,
      port,
    };
  }

  recordConnectivity(statuses: Record<string, ConnectivityStatus>): void {
    this.connectivity = { ...this.connectivity, ...statuses };
  }

  async snapshot(): Promise<RuntimeHealthSnapshot> {
    const storage = getEffectiveBackend();
    const storageDegraded = this.config.storage.enabled &&
      storage.requested === "cos" && storage.effective !== storage.requested;
    const outbox = this.memoryRuntimeProvider?.health
      ? await this.memoryRuntimeProvider.health()
      : { state: "disabled" as const };
    const outboxReady = "state" in outbox || (!outbox.workerErrorKind && outbox.deadCount === 0);
    const listenersReady = Object.values(this.listeners)
      .every((listener) => !listener.enabled || listener.ready);
    const connectivityDegraded = Object.values(this.connectivity).includes("failed");
    const durableStoreReady = !storageDegraded && outboxReady;
    const status = !listenersReady
      ? "starting"
      : !durableStoreReady || connectivityDegraded
        ? "degraded"
        : "ok";

    const storageHealth = {
      enabled: this.config.storage.enabled,
      requested: storage.requested,
      effective: storage.effective,
      degraded: storageDegraded,
    };
    return {
      status,
      version: "0.2.0",
      mode: this.plan.mode,
      upstream: this.plan.dependencies.forwarding ? "configured" : "disabled",
      opik: this.plan.dependencies.forwarding && this.config.opik.enabled
        ? "configured"
        : "disabled",
      costGuard: this.plan.dependencies.forwarding && this.config.costGuard.enabled
        ? "enabled"
        : "disabled",
      rateLimit: this.plan.dependencies.forwarding &&
          (this.config.rateLimit.tpm > 0 || this.config.rateLimit.qpm > 0)
        ? "enabled"
        : "disabled",
      listeners: structuredClone(this.listeners),
      durableStore: {
        ready: durableStoreReady,
        storage: storageHealth,
        outbox,
      },
      storage: storageHealth,
      ...("state" in outbox ? {} : { memoryRuntime: outbox }),
      connectivity: { ...this.connectivity },
    };
  }
}

function initialConnectivity(
  config: ProxyConfig,
): Record<string, ConnectivityStatus> {
  const forwarding = config.runtime.mode !== "hooks";
  return {
    upstream: forwarding && config.upstream.url ? "pending" : "disabled",
    creditReport: forwarding && config.creditReport.url ? "pending" : "disabled",
    clickhouse: forwarding && config.clickhouse.enabled ? "pending" : "disabled",
    opik: forwarding && config.opik.enabled ? "pending" : "disabled",
    langfuse: forwarding && config.langfuse.enabled ? "pending" : "disabled",
    auth: forwarding && config.auth.enabled ? "pending" : "disabled",
    redis: config.redis.enabled ? "pending" : "disabled",
    memoryCore: config.coreSkill.endpoint && config.coreSkill.serviceToken
      ? "pending"
      : "disabled",
    tdai: config.tdai.enabled && config.tdai.endpoint ? "pending" : "disabled",
    knowledge: config.knowledge.enabled && config.knowledge.endpoint
      ? "pending"
      : "disabled",
  };
}

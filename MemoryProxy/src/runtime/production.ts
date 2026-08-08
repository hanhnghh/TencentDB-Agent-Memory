import { createSessionNamespace } from "../agent-sources.js";
import { getHookCacheRepo } from "../db/hookCacheRepo.js";
import { resolveDbPath } from "../db/index.js";
import { prewarmFromConfig } from "../injection/index.js";
import { getMetadataClient } from "../meta/client.js";
import {
  MemoryCoreRoundDelivery,
  openDurableRoundOutbox,
  type OutboxHealth,
} from "../outbox/index.js";
import { getSessionStore } from "../session/store.js";
import { getCoreSkillClient } from "../skill/core-client.js";
import { TdaiClient } from "../tdai/client.js";
import type { ProxyConfig } from "../types.js";
import {
  AssetCapabilityHttpAdapter,
  ConfigExtractionAdapter,
  DurableRoundOutboxAdapter,
  HookCacheContextAdapter,
  MemoryCoreAuthorizationAdapter,
  MemoryRuntime,
  ProductionMemoryRuntimeAdapters,
  SessionStoreBindingAdapter,
  type MemoryRuntimeContract,
  type RuntimeExtractionDecision,
} from "./index.js";
export { isProxyMemoryRuntimeRequired } from "./mode.js";

export interface MemoryRuntimeAccess {
  userKey: string;
}

export interface MemoryRuntimeProvider {
  forRequest(access: MemoryRuntimeAccess): MemoryRuntimeContract;
  health?(): Promise<OutboxHealth>;
}

export interface ManagedMemoryRuntime {
  provider: MemoryRuntimeProvider;
  drain(): Promise<{ committed: number; retried: number; dead: number }>;
  shutdown(): Promise<void>;
}

/** Build the app-scoped production runtime and start its durable delivery worker. */
export async function createMemoryRuntime(
  config: ProxyConfig,
): Promise<ManagedMemoryRuntime> {
  const delivery = new MemoryCoreRoundDelivery(
    (serviceId) => createTdaiClient(config, serviceId),
    getCoreSkillClient(config.coreSkill),
  );
  const outbox = openDurableRoundOutbox({
    dbPath: process.env.PROXY_OUTBOX_PATH?.trim() || resolveDbPath(),
    delivery,
  });
  await outbox.start({ concurrency: 2 });

  const provider: MemoryRuntimeProvider = {
    health: () => outbox.health(),
    forRequest: ({ userKey }) => {
      const configuredExtraction = new ConfigExtractionAdapter(config);
      const runtime = new MemoryRuntime(new ProductionMemoryRuntimeAdapters({
        binding: new SessionStoreBindingAdapter(
          getSessionStore(),
          (identity) => getMetadataClient(config.coreSkill, identity.serviceId, userKey),
          (identity) => createSessionNamespace(identity.agentSource, identity.sessionId),
        ),
        authorization: new MemoryCoreAuthorizationAdapter(
          (identity) => createTdaiClient(config, identity.serviceId),
          () => userKey,
        ),
        capabilities: new AssetCapabilityHttpAdapter({
          endpoint: config.tdai.endpoint,
          apiKey: config.tdai.apiKey,
          serviceId: config.tdai.serviceId,
          timeoutMs: config.tdai.memory.timeoutMs,
          userKeyFor: () => userKey,
        }),
        context: config.injection.enabled && config.injection.injectors.length > 0
          ? new HookCacheContextAdapter({
              cacheRepo: getHookCacheRepo(),
              prewarm: (input, options) => prewarmFromConfig(config, input, options),
              callerUserKeyFor: () => userKey,
            })
          : {
              prepareContext: async () => ({
                blocks: [],
                diagnostics: { prewarmed: [], cacheHits: [], degraded: [] },
              }),
            },
        extraction: {
          decideExtraction(identity, capabilities): RuntimeExtractionDecision {
            const decision = configuredExtraction.decideExtraction(identity, capabilities);
            return {
              l0: decision.l0 && config.tdai.enabled && config.tdai.memory.enabled &&
                config.tdai.memory.writeL0,
              skill: decision.skill && Boolean(
                config.coreSkill.endpoint && config.coreSkill.serviceToken,
              ),
            };
          },
        },
        outbox: new DurableRoundOutboxAdapter(outbox),
      }));
      return runtime;
    },
  };

  return {
    provider,
    drain: () => outbox.drainReady({ concurrency: 2 }),
    async shutdown(): Promise<void> {
      await outbox.stop();
      outbox.close();
    },
  };
}

function createTdaiClient(config: ProxyConfig, serviceId: string): TdaiClient {
  return new TdaiClient({
    enabled: config.tdai.enabled && config.tdai.memory.enabled,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

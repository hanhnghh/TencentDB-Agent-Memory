import type { ProxyConfig } from "../types.js";

export interface RuntimePlan {
  mode: ProxyConfig["runtime"]["mode"];
  listeners: {
    proxy: { enabled: boolean; host: string; port: number };
    hooks: { enabled: boolean; host: string; port: number };
  };
  dependencies: {
    forwarding: boolean;
    memoryRuntime: boolean;
  };
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

/** Validate only dependencies that are active in the selected runtime mode. */
export function validateRuntimeConfig(config: ProxyConfig): ProxyConfig {
  if (config.runtime.mode !== "hooks") {
    requirePort(config.server.port, "server.port");
  }
  if (config.runtime.mode !== "proxy") {
    requirePort(config.runtime.hooks.port, "runtime.hooks.port");
  }
  if (config.runtime.mode !== "hooks" &&
      (typeof config.upstream.url !== "string" || !config.upstream.url.trim())) {
    throw new RuntimeConfigError("upstream.url is required in proxy and both modes");
  }
  if (config.runtime.mode !== "proxy" && !isLoopbackHost(config.runtime.hooks.host)) {
    throw new RuntimeConfigError("runtime.hooks.host must be loopback-only");
  }
  if (config.runtime.mode === "both" && config.server.port !== 0 &&
      config.server.port === config.runtime.hooks.port) {
    throw new RuntimeConfigError(
      "proxy and hook listeners must use different ports in both mode",
    );
  }
  return config;
}

/** Collapse mode selection into the startup decisions every caller needs. */
export function planRuntime(config: ProxyConfig): RuntimePlan {
  validateRuntimeConfig(config);
  const proxyEnabled = config.runtime.mode !== "hooks";
  const hooksEnabled = config.runtime.mode !== "proxy";
  return {
    mode: config.runtime.mode,
    listeners: {
      proxy: {
        enabled: proxyEnabled,
        host: config.server.host,
        port: config.server.port,
      },
      hooks: {
        enabled: hooksEnabled,
        host: config.runtime.hooks.host,
        port: config.runtime.hooks.port,
      },
    },
    dependencies: {
      forwarding: proxyEnabled,
      memoryRuntime: hooksEnabled || isProxyMemoryRuntimeRequired(config),
    },
  };
}

/** Whether the proxy transport has enabled memory read/write orchestration. */
export function isProxyMemoryRuntimeRequired(config: ProxyConfig): boolean {
  const hasInjection = config.injection.enabled && config.injection.injectors.length > 0;
  const hasL0Extraction = config.extraction.extractors.includes("tdai-memory") &&
    config.tdai.enabled && config.tdai.memory.enabled && config.tdai.memory.writeL0;
  const hasSkillExtraction = config.extraction.extractors.includes("skill") &&
    Boolean(config.coreSkill.endpoint && config.coreSkill.serviceToken);
  const hasExtraction = config.extraction.enabled && (hasL0Extraction || hasSkillExtraction);
  return config.sessionInit.enabled || hasInjection || hasExtraction;
}

function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== "string") return false;
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function requirePort(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RuntimeConfigError(`${field} must be an integer from 0 to 65535`);
  }
}

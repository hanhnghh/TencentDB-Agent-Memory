import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import type { ProxyConfig, RuntimeMode } from "../../types.js";
import { planRuntime } from "../mode.js";

describe("runtime mode startup contract", () => {
  it.each([
    ["proxy", true, false, true],
    ["hooks", false, true, false],
    ["both", true, true, true],
  ] as const)(
    "%s mode enables only its selected listeners and forwarding dependencies",
    (mode, proxyEnabled, hooksEnabled, forwardingEnabled) => {
      const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
      config.runtime.mode = mode satisfies RuntimeMode;

      expect(planRuntime(config)).toEqual({
        mode,
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
          forwarding: forwardingEnabled,
          memoryRuntime: hooksEnabled,
        },
      });
    },
  );
});

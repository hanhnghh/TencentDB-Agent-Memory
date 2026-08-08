import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config.js";
import { checkConnectivity } from "../connectivity.js";
import type { ProxyConfig } from "../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime mode connectivity", () => {
  it("does not initialize forwarding connectivity in hooks mode", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "hooks";
    config.upstream.url = "";
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(checkConnectivity(config)).resolves.toMatchObject({
      upstream: "disabled",
      creditReport: "disabled",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats an HTTP response as reachable without exposing endpoint or response details", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.runtime.mode = "proxy";
    config.upstream.url = "https://credential.example/private";
    config.creditReport.url = "";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "secret dependency failure",
      { status: 503 },
    )));

    const result = await checkConnectivity(config);

    expect(result).toMatchObject({ upstream: "ok", creditReport: "disabled" });
    expect(JSON.stringify(result)).not.toContain("credential.example");
    expect(JSON.stringify(result)).not.toContain("secret dependency failure");
  });

  it("reports network failures as failed", async () => {
    const config: ProxyConfig = structuredClone(DEFAULT_CONFIG);
    config.creditReport.url = "";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection refused");
    }));

    await expect(checkConnectivity(config)).resolves.toMatchObject({
      upstream: "failed",
    });
  });
});

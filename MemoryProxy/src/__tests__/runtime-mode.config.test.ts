import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildConfig, parseArgv } from "../config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime mode configuration", () => {
  it("keeps proxy mode as the backward-compatible default", () => {
    const config = buildConfig({ configFile: "/missing/runtime-mode-default.yaml" });

    expect(config.runtime).toEqual({
      mode: "proxy",
      hooks: {
        host: "127.0.0.1",
        port: 8097,
      },
    });
  });

  it("accepts hooks and both modes from YAML and CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-mode-config-"));
    roots.push(root);
    const configFile = join(root, "config.yaml");
    await writeFile(configFile, [
      "runtime:",
      "  mode: hooks",
      "  hooks:",
      "    host: 127.0.0.1",
      "    port: 9123",
    ].join("\n"));

    expect(buildConfig({ configFile }).runtime).toEqual({
      mode: "hooks",
      hooks: { host: "127.0.0.1", port: 9123 },
    });
    expect(parseArgv(["node", "index.js", "--mode", "both"])).toMatchObject({
      runtimeMode: "both",
    });
    expect(buildConfig({ configFile, runtimeMode: "both" }).runtime.mode).toBe("both");
  });

  it("rejects an unknown runtime mode instead of silently starting proxy mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-mode-invalid-"));
    roots.push(root);
    const configFile = join(root, "config.yaml");
    await writeFile(configFile, "runtime:\n  mode: public-hooks\n");

    expect(() => buildConfig({ configFile })).toThrowError(
      "runtime.mode must be one of: proxy, hooks, both",
    );
  });

  it("requires an upstream URL only when proxy traffic is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-mode-upstream-"));
    roots.push(root);
    const hooksFile = join(root, "hooks.yaml");
    const proxyFile = join(root, "proxy.yaml");
    await writeFile(hooksFile, "runtime:\n  mode: hooks\nupstream:\n  url: ''\n");
    await writeFile(proxyFile, "runtime:\n  mode: proxy\nupstream:\n  url: ''\n");

    expect(buildConfig({ configFile: hooksFile }).upstream.url).toBe("");
    expect(() => buildConfig({ configFile: proxyFile })).toThrowError(
      "upstream.url is required in proxy and both modes",
    );
  });

  it("rejects an exposed hook listener and colliding listeners in both mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-mode-listeners-"));
    roots.push(root);
    const exposedFile = join(root, "exposed.yaml");
    const collidingFile = join(root, "colliding.yaml");
    await writeFile(exposedFile, [
      "runtime:",
      "  mode: hooks",
      "  hooks:",
      "    host: 0.0.0.0",
      "    port: 8097",
      "upstream:",
      "  url: ''",
    ].join("\n"));
    await writeFile(collidingFile, [
      "runtime:",
      "  mode: both",
      "  hooks:",
      "    host: 127.0.0.1",
      "    port: 8096",
      "server:",
      "  host: 0.0.0.0",
      "  port: 8096",
    ].join("\n"));

    expect(() => buildConfig({ configFile: exposedFile })).toThrowError(
      "runtime.hooks.host must be loopback-only",
    );
    expect(() => buildConfig({ configFile: collidingFile })).toThrowError(
      "proxy and hook listeners must use different ports in both mode",
    );
  });

  it("rejects invalid active listener ports", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-mode-ports-"));
    roots.push(root);
    const configFile = join(root, "hooks.yaml");
    await writeFile(configFile, [
      "runtime:",
      "  mode: hooks",
      "  hooks:",
      "    port: 70000",
      "upstream:",
      "  url: ''",
    ].join("\n"));

    expect(() => buildConfig({ configFile })).toThrowError(
      "runtime.hooks.port must be an integer from 0 to 65535",
    );
    expect(() => buildConfig({
      configFile: "/missing/runtime-mode-port.yaml",
      port: Number.NaN,
    })).toThrowError("server.port must be an integer from 0 to 65535");
  });

  it("returns a classified config error for malformed listener input", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-mode-malformed-"));
    roots.push(root);
    const configFile = join(root, "hooks.yaml");
    await writeFile(configFile, [
      "runtime:",
      "  mode: hooks",
      "  hooks:",
      "    host: 127",
      "upstream:",
      "  url: ''",
    ].join("\n"));

    expect(() => buildConfig({ configFile })).toThrowError(
      "runtime.hooks.host must be loopback-only",
    );
  });
});

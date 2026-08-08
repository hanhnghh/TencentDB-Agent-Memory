import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const deployDir = resolve(import.meta.dirname);
const temporaryRoots = [];

test.afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

test("hooks deployment starts without proxy upstream configuration and uses hook health", async () => {
  const fixture = await deploymentFixture({
    PROXY_RUNTIME_MODE: "hooks",
    PROXY_UPSTREAM_URL: "",
    PROXY_UPSTREAM_API_KEY: "",
    PROXY_UPSTREAM_MODEL: "",
  });

  const result = await runScript("start-proxy.sh", fixture.env);

  assert.equal(result.code, 0, result.stderr);
  const config = await readFile(fixture.configFile, "utf8");
  assert.match(config, /runtime:\n  mode: hooks\n/);
  assert.match(config, /hooks:\n    host: 127\.0\.0\.1\n    port: 8097\n/);
  assert.match(config, /upstream:\n  url: ""\n  apiKey: ""\n/);

  const dockerLog = await readFile(fixture.dockerLog, "utf8");
  assert.match(dockerLog, /-e PROXY_HEALTH_PORT=8097/);
  assert.match(dockerLog, /-p 127\.0\.0\.1:8097:/);
  assert.doesNotMatch(dockerLog, /-p 8096:8096/);
});

test("full stack validation and launch remain hooks-aware", async () => {
  const fixture = await deploymentFixture({
    PROXY_RUNTIME_MODE: "hooks",
    PROXY_UPSTREAM_URL: "",
    PROXY_UPSTREAM_API_KEY: "",
    PROXY_UPSTREAM_MODEL: "",
  });

  const result = await runScript("start-all.sh", fixture.env);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /MemoryProxy \(hooks\)/);
  assert.match(result.stdout, /Codex hooks: http:\/\/127\.0\.0\.1:8097/);
});

test("source manager selects the active mode health listener", async () => {
  for (const [mode, expectedPort] of [["hooks", "9197"], ["both", "9196"]]) {
    const fixture = await deploymentFixture();
    const sourceConfig = join(fixture.root, `${mode}.yaml`);
    const sourceState = join(fixture.root, `${mode}-state`);
    await mkdir(sourceState);
    await writeFile(sourceConfig, [
      "runtime:",
      `  mode: ${mode}`,
      "  hooks:",
      "    host: 127.0.0.1",
      "    port: 9197",
      "server:",
      "  host: 0.0.0.0",
      "  port: 9196",
    ].join("\n") + "\n", "utf8");
    await writeFile(join(sourceState, "context-proxy.pid"), `${process.pid}\n`, "utf8");

    const result = await runScript(
      resolve(deployDir, "../../MemoryProxy/scripts/proxy.sh"),
      {
        ...fixture.env,
        PROXY_CONFIG_FILE: sourceConfig,
        PROXY_STATE_DIR: sourceState,
      },
      ["status"],
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(fixture.curlLog, "utf8"), new RegExp(`127\\.0\\.0\\.1:${expectedPort}/health`));
  }
});

test("deployment matrix validates mode-scoped upstream credentials", async (context) => {
  const cases = [
    {
      name: "proxy server-key",
      overrides: { PROXY_RUNTIME_MODE: "proxy" },
      code: 0,
      config: /upstream:\n  url: "https:\/\/upstream\.example\/v1"\n  apiKey: "server-secret"/,
    },
    {
      name: "proxy client-key passthrough",
      overrides: {
        PROXY_RUNTIME_MODE: "proxy",
        PROXY_UPSTREAM_AUTH_MODE: "client-key",
        PROXY_UPSTREAM_API_KEY: "",
      },
      code: 0,
      config: /upstream:\n  url: "https:\/\/upstream\.example\/v1"\n  apiKey: ""/,
    },
    {
      name: "both server-key",
      overrides: { PROXY_RUNTIME_MODE: "both" },
      code: 0,
      config: /runtime:\n  mode: both/,
      docker: [/-p 8096:8096/, /-p 127\.0\.0\.1:8097:/],
    },
    {
      name: "unknown mode",
      overrides: { PROXY_RUNTIME_MODE: "public-hooks" },
      code: 1,
      error: /PROXY_RUNTIME_MODE/,
    },
    {
      name: "proxy missing URL",
      overrides: { PROXY_RUNTIME_MODE: "proxy", PROXY_UPSTREAM_URL: "" },
      code: 1,
      error: /PROXY_UPSTREAM_URL/,
    },
    {
      name: "both missing model",
      overrides: { PROXY_RUNTIME_MODE: "both", PROXY_UPSTREAM_MODEL: "" },
      code: 1,
      error: /PROXY_UPSTREAM_MODEL/,
    },
    {
      name: "server-key missing key",
      overrides: { PROXY_UPSTREAM_API_KEY: "" },
      code: 1,
      error: /PROXY_UPSTREAM_API_KEY/,
    },
    {
      name: "client-key rejects a global override",
      overrides: { PROXY_UPSTREAM_AUTH_MODE: "client-key" },
      code: 1,
      error: /client-key.*PROXY_UPSTREAM_API_KEY/,
    },
    {
      name: "both rejects colliding host ports",
      overrides: { PROXY_RUNTIME_MODE: "both", PROXY_HOOK_PORT: "8096" },
      code: 1,
      error: /different host ports/,
    },
    {
      name: "hooks rejects a non-numeric publish target",
      overrides: { PROXY_RUNTIME_MODE: "hooks", PROXY_HOOK_PORT: "0.0.0.0:8097" },
      code: 1,
      error: /PROXY_HOOK_PORT.*1.*65535/,
    },
  ];

  for (const matrixCase of cases) {
    await context.test(matrixCase.name, async () => {
      const fixture = await deploymentFixture(matrixCase.overrides);
      const result = await runScript("start-proxy.sh", fixture.env);
      assert.equal(result.code, matrixCase.code, result.stderr);
      if (matrixCase.error) assert.match(result.stderr, matrixCase.error);
      if (matrixCase.config) {
        assert.match(await readFile(fixture.configFile, "utf8"), matrixCase.config);
      }
      if (matrixCase.docker) {
        const dockerLog = await readFile(fixture.dockerLog, "utf8");
        for (const expected of matrixCase.docker) assert.match(dockerLog, expected);
      }
    });
  }
});

test("hooks verification probes the internal memory model but not proxy upstream", async () => {
  const fixture = await deploymentFixture({
    PROXY_RUNTIME_MODE: "hooks",
    PROXY_UPSTREAM_URL: "",
    PROXY_UPSTREAM_API_KEY: "",
    PROXY_UPSTREAM_MODEL: "",
  });

  const result = await runScript("verify.sh", fixture.env);

  assert.equal(result.code, 0, result.stderr);
  const curlLog = await readFile(fixture.curlLog, "utf8");
  assert.match(curlLog, /memory-model\.example/);
  assert.doesNotMatch(curlLog, /upstream\.example/);
  assert.match(result.stdout, /hooks/);
  assert.match(result.stdout, /Memory Hub user key.*binding/);
});

test("client-key verification checks upstream reachability without a deployment key", async () => {
  const fixture = await deploymentFixture({
    PROXY_UPSTREAM_AUTH_MODE: "client-key",
    PROXY_UPSTREAM_API_KEY: "",
  });

  const result = await runScript("verify.sh", fixture.env);

  assert.equal(result.code, 0, result.stderr);
  const upstreamProbe = (await readFile(fixture.curlLog, "utf8"))
    .split("\n")
    .find((line) => line.includes("upstream.example"));
  assert.ok(upstreamProbe, "proxy upstream was not probed");
  assert.doesNotMatch(upstreamProbe, /Authorization|server-secret/);
});

test("container contract relays host-loopback hooks and forwards shutdown to the runtime", async () => {
  const fixture = await deploymentFixture({
    PROXY_RUNTIME_MODE: "both",
  });
  const result = await runScript("start-proxy.sh", fixture.env);
  assert.equal(result.code, 0, result.stderr);
  const dockerLog = await readFile(fixture.dockerLog, "utf8");
  assert.match(dockerLog, /-p 127\.0\.0\.1:8097:18097/);
  assert.match(dockerLog, /-e PROXY_HOOK_BRIDGE_ENABLED=1/);

  const dockerfile = await readFile(resolve(deployDir, "../../MemoryProxy/Dockerfile"), "utf8");
  assert.match(dockerfile, /CMD curl .*PROXY_HEALTH_PORT/);
  assert.match(dockerfile, /container-entrypoint\.sh/);
  const entrypoint = await readFile(
    resolve(deployDir, "../../MemoryProxy/scripts/container-entrypoint.sh"),
    "utf8",
  );
  assert.match(entrypoint, /trap .*TERM/);
  assert.match(entrypoint, /kill .*app_pid/);
  assert.match(entrypoint, /wait .*app_pid/);
});

test("container entrypoint stops the hook relay and waits for runtime shutdown", async () => {
  const fixture = await deploymentFixture();
  const signalLog = join(fixture.root, "signals.log");
  for (const executable of ["node", "socat"]) {
    const path = join(fixture.binDir, executable);
    await writeFile(path, `#!/usr/bin/env sh
trap 'echo ${executable}-term >> "$SIGNAL_LOG"; exit 0' TERM INT
echo ${executable}-start >> "$SIGNAL_LOG"
while :; do sleep 1; done
`, "utf8");
    await chmod(path, 0o755);
  }

  const child = spawn("sh", [
    resolve(deployDir, "../../MemoryProxy/scripts/container-entrypoint.sh"),
    "--config",
    "/data/config.yaml",
  ], {
    cwd: resolve(deployDir, "../../MemoryProxy"),
    env: {
      ...fixture.env,
      PROXY_HOOK_BRIDGE_ENABLED: "1",
      SIGNAL_LOG: signalLog,
    },
    stdio: "ignore",
  });
  await waitForText(signalLog, "node-start", 3_000);
  await waitForText(signalLog, "socat-start", 3_000);
  child.kill("SIGTERM");
  const exit = await waitForExit(child, 4_000);
  assert.ok(exit.code === 0 || exit.code === 143, `unexpected exit: ${JSON.stringify(exit)}`);
  const signals = await readFile(signalLog, "utf8");
  assert.match(signals, /node-term/);
  assert.match(signals, /socat-term/);
});

test("examples and bilingual install docs describe the deployed runtime contract", async () => {
  const envExample = await readFile(join(deployDir, ".env.example"), "utf8");
  for (const expected of [
    "PROXY_RUNTIME_MODE=proxy",
    "PROXY_UPSTREAM_AUTH_MODE=server-key",
    "PROXY_HOOK_PORT=8097",
    "PROXY_VOLUME=tdai-memory-proxy-data",
    "MEMORY_HUB_USER_KEY=",
  ]) {
    assert.match(envExample, new RegExp(expected));
  }

  const documents = await Promise.all([
    readFile(resolve(deployDir, "README.md"), "utf8"),
    readFile(resolve(deployDir, "../../INSTALL.md"), "utf8"),
    readFile(resolve(deployDir, "../../INSTALL_CN.md"), "utf8"),
  ]);
  for (const document of documents) {
    assert.match(document, /PROXY_RUNTIME_MODE/);
    assert.match(document, /server-key/);
    assert.match(document, /client-key/);
    assert.match(document, /MEMORY_LLM_API_KEY/);
    assert.match(document, /MEMORY_HUB_USER_KEY/);
    assert.match(document, /doctor/);
    assert.match(document, /127\.0\.0\.1.*8097/);
  }
});

async function deploymentFixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "tdai-deployment-mode-"));
  temporaryRoots.push(root);
  const binDir = join(root, "bin");
  const envFile = join(root, ".env");
  const dockerLog = join(root, "docker.log");
  const curlLog = join(root, "curl.log");
  const configDir = join(root, "proxy-config");
  const configFile = join(configDir, "config.yaml");
  await mkdir(binDir);
  const docker = join(binDir, "docker");
  await writeFile(docker, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "\${1:-}" in
  ps)
    printf '%s\\n' tdai-memory-core tdai-memory-hub
    ;;
  inspect)
    if [[ "$*" == *State.Health* ]]; then
      echo healthy
    else
      echo running
    fi
    ;;
esac
`, "utf8");
  await chmod(docker, 0o755);
  const curl = join(binDir, "curl");
  await writeFile(curl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
output_file=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "-o" ]]; then output_file="$argument"; fi
  previous="$argument"
done
if [[ -n "$output_file" && "$output_file" != "/dev/null" ]]; then
  printf '%s\\n' '{"data":[{"id":"memory-model"},{"id":"model-test"}]}' > "$output_file"
fi
printf '200'
`, "utf8");
  await chmod(curl, 0o755);

  const values = {
    PROXY_IMAGE: "example/memory-proxy:test",
    PROXY_PORT: "8096",
    PROXY_HOOK_PORT: "8097",
    PROXY_VOLUME: "tdai-memory-proxy-test",
    PROXY_RUNTIME_MODE: "proxy",
    PROXY_UPSTREAM_AUTH_MODE: "server-key",
    PROXY_UPSTREAM_URL: "https://upstream.example/v1",
    PROXY_UPSTREAM_API_KEY: "server-secret",
    PROXY_UPSTREAM_MODEL: "model-test",
    MEMORY_CORE_IMAGE: "example/memory-core:test",
    MEMORY_HUB_IMAGE: "example/memory-hub:test",
    MEMORY_CORE_PORT: "8420",
    PANEL_PORT: "8125",
    KNOWLEDGE_PORT: "8424",
    MEMORY_CORE_VOLUME: "tdai-memory-core-test",
    PANEL_VOLUME: "tdai-panel-test",
    MEMORY_LLM_BASE_URL: "https://memory-model.example/v1",
    MEMORY_LLM_API_KEY: "memory-secret",
    MEMORY_LLM_MODEL: "memory-model",
    MEMORY_LLM_PROTOCOL: "openai",
    KNOWLEDGE_PUBLIC_BASE_URL: "http://host.docker.internal:8424/v3",
    MEMORY_HUB_USER_KEY: "",
    MEMORY_CORE_GATEWAY_API_KEY: "core-service-secret",
    ...overrides,
  };
  await writeFile(envFile, Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n") + "\n", "utf8");

  return {
    binDir,
    configFile,
    curlLog,
    dockerLog,
    root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ENV_FILE: envFile,
      CURL: curl,
      FAKE_CURL_LOG: curlLog,
      FAKE_DOCKER_LOG: dockerLog,
      MEMORY_CORE_ADMIN_KEY_FILE: join(root, "admin-key"),
      MEMORY_CORE_CONFIG_DIR: join(root, "memory-core-config"),
      PROXY_CONFIG_DIR: configDir,
    },
  };
}

async function waitForText(path, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.includes(expected)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${expected}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("entrypoint did not stop"));
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

function runScript(script, env, args = []) {
  return new Promise((resolvePromise, reject) => {
    const scriptPath = resolve(script) === script ? script : join(deployDir, script);
    const child = spawn("bash", [scriptPath, ...args], {
      cwd: deployDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

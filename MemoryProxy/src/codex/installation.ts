import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {
  doctorCodexBinding,
  resolveUserConfigDir,
  verifyCodexProjectBinding,
  type BindingDoctorCheck,
  type CodexBindingDiagnosis,
  type CodexBindingPaths,
} from "./binding.js";
import { withProcessLock } from "./process-lock.js";

const PLUGIN_NAME = "tencentdb-agent-memory";
const INSTALLATION_VERSION = 1;
const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8097";
const DEFAULT_TIMEOUT_MS = 4_000;
const INSTALLATION_LOCK_RETRY_MS = 25;
const INSTALLATION_LOCK_TIMEOUT_MS = 5_000;
const MALFORMED_LOCK_STALE_MS = 30_000;
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CodexCommandRunner {
  run(args: string[]): Promise<CommandResult>;
}

export interface CodexInstallationPaths {
  rootDir: string;
  stateFile: string;
  dataDir: string;
  lifecycleLockFile: string;
  sidecarLeaseFile: string;
}

interface InstallationState {
  version: 1;
  pluginName: string;
  marketplaceName: string;
  marketplaceRoot: string;
  installedVersion: string;
  installedAt: string;
  updatedAt: string;
  projectDir?: string;
  configFile?: string;
  reviewedHooksSha256?: string;
}

interface PackageDescription {
  marketplaceName: string;
  marketplaceRoot: string;
  pluginName: string;
  pluginRoot: string;
  version: string;
  hooksSha256: string;
}

interface InstalledPlugin {
  pluginId: string;
  name: string;
  marketplaceName: string;
  version: string;
  enabled: boolean;
  sourcePath: string;
}

export interface CodexInstallInput {
  marketplaceRoot?: string;
  projectDir?: string;
  userConfigDir?: string;
  configFile?: string;
  codex?: CodexCommandRunner;
  sidecar?: CodexSidecarProcessManager;
}

export interface CodexInstallResult {
  installed: true;
  enabled: boolean;
  trusted: boolean;
  version: string;
  dataPath: string;
  sidecarRunning: boolean;
  review: {
    hooksSha256: string;
    instruction: string;
  };
}

export interface RecordCodexHookTrustInput {
  projectDir?: string;
  userConfigDir?: string;
  hooksSha256: string;
  codex?: CodexCommandRunner;
}

export interface DoctorCodexIntegrationInput extends CodexBindingPaths {
  codex?: CodexCommandRunner;
  sidecarUrl?: string;
  fetcher?: typeof fetch;
  bindingFetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface UninstallCodexIntegrationInput {
  projectDir?: string;
  userConfigDir?: string;
  codex?: CodexCommandRunner;
  sidecar?: CodexSidecarProcessManager;
  purgeData?: boolean;
}

export interface UninstallCodexIntegrationResult {
  removed: boolean;
  dataDisposition: "retained" | "purged";
  dataPath: string;
}

export interface CodexSidecarProcessManager {
  start(input: {
    configFile?: string;
    projectDir: string;
    userConfigDir?: string;
    leaseFile: string;
  }): Promise<void>;
  stop(leaseFile: string): Promise<boolean>;
}

export class CodexInstallationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexInstallationError";
  }
}

export function resolveCodexInstallationPaths(
  userConfigDir = defaultUserConfigDir(),
): CodexInstallationPaths {
  const rootDir = join(resolve(userConfigDir), "plugin-data");
  return {
    rootDir,
    stateFile: join(rootDir, "installation.json"),
    dataDir: join(rootDir, "data"),
    lifecycleLockFile: join(rootDir, ".lifecycle.lock"),
    sidecarLeaseFile: join(rootDir, "sidecar.lease.json"),
  };
}

export async function installCodexIntegration(
  input: CodexInstallInput = {},
): Promise<CodexInstallResult> {
  return installOrUpgrade(input);
}

export async function upgradeCodexIntegration(
  input: CodexInstallInput = {},
): Promise<CodexInstallResult> {
  return installOrUpgrade(input);
}

async function installOrUpgrade(input: CodexInstallInput): Promise<CodexInstallResult> {
  const packageInfo = await inspectPackage(input.marketplaceRoot ?? PACKAGE_ROOT);
  const paths = resolveCodexInstallationPaths(input.userConfigDir);
  const codex = input.codex ?? new SpawnCodexCommandRunner();
  const sidecar = input.sidecar ?? new SpawnCodexSidecarProcessManager();
  const projectDir = input.projectDir ?? process.cwd();

  await assertProtectedStateOutsideProject(projectDir, paths.rootDir);
  await ensureProtectedDirectory(paths.rootDir);
  return withInstallationLock(paths, async () => {
    const priorState = await readInstallationState(paths.stateFile);
    const priorWasRunning = await sidecar.stop(paths.sidecarLeaseFile);
    const effectiveProjectDir = resolve(input.projectDir ?? priorState?.projectDir ?? process.cwd());
    const effectiveConfigFile = input.configFile
      ? resolve(input.configFile)
      : priorState?.configFile;
    try {
      await ensureProtectedDirectory(paths.dataDir);
      await ensureMarketplace(codex, packageInfo);
      await runCodex(codex, [
        "plugin",
        "add",
        `${packageInfo.pluginName}@${packageInfo.marketplaceName}`,
        "--json",
      ], "Codex could not install the Agent Memory plugin");

      const installed = await findInstalledPlugin(
        codex,
        packageInfo.pluginName,
        packageInfo.marketplaceName,
      );
      if (!installed) {
        throw new CodexInstallationError(
          "plugin_not_installed",
          "Codex did not report the Agent Memory plugin as installed",
        );
      }
      const installedHooksSha256 = await hooksDigest(installed.sourcePath);
      if (installedHooksSha256 !== packageInfo.hooksSha256) {
        throw new CodexInstallationError(
          "installed_package_mismatch",
          "Installed hook definitions do not match the reviewed package source",
        );
      }

      const now = new Date().toISOString();
      const state: InstallationState = {
        version: INSTALLATION_VERSION,
        pluginName: packageInfo.pluginName,
        marketplaceName: packageInfo.marketplaceName,
        marketplaceRoot: packageInfo.marketplaceRoot,
        installedVersion: installed.version,
        installedAt: priorState?.installedAt ?? now,
        updatedAt: now,
        projectDir: effectiveProjectDir,
        ...(effectiveConfigFile ? { configFile: effectiveConfigFile } : {}),
        ...(priorState?.reviewedHooksSha256
          ? { reviewedHooksSha256: priorState.reviewedHooksSha256 }
          : {}),
      };
      await atomicWriteJson(paths.stateFile, state, 0o600);
      await sidecar.start({
        ...(effectiveConfigFile ? { configFile: effectiveConfigFile } : {}),
        projectDir: effectiveProjectDir,
        ...(input.userConfigDir ? { userConfigDir: input.userConfigDir } : {}),
        leaseFile: paths.sidecarLeaseFile,
      });
      const trusted = state.reviewedHooksSha256 === installedHooksSha256;
      return {
        installed: true,
        enabled: installed.enabled,
        trusted,
        version: installed.version,
        dataPath: paths.dataDir,
        sidecarRunning: true,
        review: reviewInstruction(installedHooksSha256),
      };
    } catch (error) {
      if (!priorState) {
        await unlink(paths.stateFile).catch(() => undefined);
        throw error;
      }
      if (priorWasRunning) {
        try {
          await sidecar.start({
            ...(priorState.configFile ? { configFile: priorState.configFile } : {}),
            projectDir: priorState.projectDir ?? projectDir,
            ...(input.userConfigDir ? { userConfigDir: input.userConfigDir } : {}),
            leaseFile: paths.sidecarLeaseFile,
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Upgrade failed and the previous sidecar could not be restarted",
          );
        }
      }
      await atomicWriteJson(paths.stateFile, priorState, 0o600);
      throw error;
    }
  });
}

export async function recordCodexHookTrust(
  input: RecordCodexHookTrustInput,
): Promise<{ trusted: true; hooksSha256: string }> {
  const paths = resolveCodexInstallationPaths(input.userConfigDir);
  await assertProtectedStateOutsideProject(input.projectDir ?? process.cwd(), paths.rootDir);
  await requireDirectory(paths.rootDir, "Agent Memory is not installed for Codex");
  const codex = input.codex ?? new SpawnCodexCommandRunner();
  return withInstallationLock(paths, async () => {
    const state = await readInstallationState(paths.stateFile);
    if (!state) {
      throw new CodexInstallationError("not_installed", "Agent Memory is not installed for Codex");
    }
    const installed = await findInstalledPlugin(codex, state.pluginName, state.marketplaceName);
    if (!installed || !installed.enabled) {
      throw new CodexInstallationError(
        "plugin_inactive",
        "Agent Memory must be installed and enabled before hook trust can be recorded",
      );
    }
    const currentDigest = await hooksDigest(installed.sourcePath);
    if (!/^[a-f0-9]{64}$/.test(input.hooksSha256) || input.hooksSha256 !== currentDigest) {
      throw new CodexInstallationError(
        "hooks_changed",
        "Hook definitions differ from the reviewed SHA-256; review them again with /hooks",
      );
    }
    await atomicWriteJson(paths.stateFile, {
      ...state,
      reviewedHooksSha256: currentDigest,
      updatedAt: new Date().toISOString(),
    }, 0o600);
    return { trusted: true, hooksSha256: currentDigest };
  });
}

export async function doctorCodexIntegration(
  input: DoctorCodexIntegrationInput,
): Promise<CodexBindingDiagnosis> {
  const checks: BindingDoctorCheck[] = [];
  const paths = resolveCodexInstallationPaths(input.userConfigDir);
  let state: InstallationState | null = null;
  try {
    state = await readInstallationState(paths.stateFile);
    checks.push({
      name: "installation_state",
      status: state ? "pass" : "fail",
      message: state
        ? "Protected installation state is valid"
        : "Protected installation state is missing",
    });
  } catch {
    checks.push({
      name: "installation_state",
      status: "fail",
      message: "Protected installation state is invalid",
    });
  }
  const codex = input.codex ?? new SpawnCodexCommandRunner();
  let installed: InstalledPlugin | null = null;

  try {
    installed = await findInstalledPlugin(
      codex,
      state?.pluginName ?? PLUGIN_NAME,
      state?.marketplaceName,
    );
    checks.push({
      name: "plugin_installed",
      status: installed ? "pass" : "fail",
      message: installed
        ? `Codex reports ${installed.pluginId} as installed`
        : "Agent Memory plugin is not installed",
    });
    checks.push({
      name: "plugin_enabled",
      status: installed?.enabled ? "pass" : "fail",
      message: installed?.enabled
        ? "Agent Memory plugin is enabled"
        : "Agent Memory plugin is not enabled",
    });
  } catch {
    checks.push({
      name: "plugin_installed",
      status: "fail",
      message: "Codex plugin installation state could not be inspected",
    });
    checks.push({
      name: "plugin_enabled",
      status: "fail",
      message: "Codex plugin enabled state could not be inspected",
    });
  }

  let currentHooksSha256: string | null = null;
  if (installed) {
    try {
      currentHooksSha256 = await hooksDigest(installed.sourcePath);
    } catch {
      currentHooksSha256 = null;
    }
  }
  const trusted = Boolean(
    currentHooksSha256 &&
    state?.reviewedHooksSha256 === currentHooksSha256,
  );
  checks.push({
    name: "hooks_trusted",
    status: trusted ? "pass" : "fail",
    message: trusted
      ? `Current hooks match reviewed SHA-256 ${currentHooksSha256}`
      : currentHooksSha256
        ? `Review current hooks with /hooks, then record SHA-256 ${currentHooksSha256}`
        : "Current hook definitions could not be inspected",
  });

  const binding = await doctorCodexBinding(input);
  checks.push(...binding.checks);
  const env = input.env ?? process.env;
  const endpoint = env.MEMORY_CORE_ENDPOINT?.trim();
  const serviceToken = env.MEMORY_CORE_SERVICE_TOKEN?.trim();
  if (!endpoint || !serviceToken) {
    checks.push({
      name: "binding_valid",
      status: "fail",
      message: "Live binding validation requires MEMORY_CORE_ENDPOINT and MEMORY_CORE_SERVICE_TOKEN",
    });
  } else {
    try {
      await verifyCodexProjectBinding({
        projectDir: input.projectDir,
        ...(input.userConfigDir ? { userConfigDir: input.userConfigDir } : {}),
        endpoint,
        authUrl: env.MEMORY_AUTH_URL?.trim() || endpoint,
        serviceToken,
        timeoutMs: input.timeoutMs,
        fetcher: input.bindingFetcher ?? globalThis.fetch.bind(globalThis),
      });
      checks.push({
        name: "binding_valid",
        status: "pass",
        message: "MemoryCore confirms the stored Team/Agent/Task binding",
      });
    } catch (error) {
      checks.push({
        name: "binding_valid",
        status: "fail",
        message: error instanceof Error
          ? error.message
          : "Stored Team/Agent/Task binding validation failed",
      });
    }
  }

  const health = await inspectSidecarHealth(
    input.sidecarUrl ?? DEFAULT_SIDECAR_URL,
    input.fetcher ?? globalThis.fetch.bind(globalThis),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  checks.push(health.reachableCheck, health.memoryCoreCheck, health.outboxCheck);

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

export async function uninstallCodexIntegration(
  input: UninstallCodexIntegrationInput = {},
): Promise<UninstallCodexIntegrationResult> {
  const paths = resolveCodexInstallationPaths(input.userConfigDir);
  await assertProtectedStateOutsideProject(input.projectDir ?? process.cwd(), paths.rootDir);
  const rootExists = await stat(paths.rootDir).then(
    (value) => value.isDirectory(),
    (error: unknown) => errorCode(error) === "ENOENT" ? false : Promise.reject(error),
  );
  if (!rootExists) {
    return { removed: false, dataDisposition: "retained", dataPath: paths.dataDir };
  }
  const codex = input.codex ?? new SpawnCodexCommandRunner();
  const sidecar = input.sidecar ?? new SpawnCodexSidecarProcessManager();
  return withInstallationLock(paths, async () => {
    const state = await readInstallationState(paths.stateFile);
    if (!state) {
      return { removed: false, dataDisposition: "retained", dataPath: paths.dataDir };
    }
    await sidecar.stop(paths.sidecarLeaseFile);
    await runCodex(codex, [
      "plugin",
      "remove",
      `${state.pluginName}@${state.marketplaceName}`,
      "--json",
    ], "Codex could not remove the Agent Memory plugin");
    await unlink(paths.stateFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (input.purgeData) await rm(paths.dataDir, { recursive: true, force: true });
    return {
      removed: true,
      dataDisposition: input.purgeData ? "purged" as const : "retained" as const,
      dataPath: paths.dataDir,
    };
  });
}

class SpawnCodexSidecarProcessManager implements CodexSidecarProcessManager {
  async start(input: {
    configFile?: string;
    projectDir: string;
    userConfigDir?: string;
    leaseFile: string;
  }): Promise<void> {
    const entrypoint = join(PACKAGE_ROOT, "scripts", "tdai-codex-memory.mjs");
    const args = [entrypoint, "sidecar", "--project", input.projectDir];
    if (input.userConfigDir) args.push("--user-config-dir", input.userConfigDir);
    if (input.configFile) args.push("--config", input.configFile);
    const child = spawn(process.execPath, args, {
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    if (!child.pid) {
      throw new CodexInstallationError("sidecar_start_failed", "Sidecar process did not start");
    }
    const pid = child.pid;
    try {
      await waitForSidecarLease(input.leaseFile, pid);
      child.unref();
    } catch (error) {
      await terminateOwnedChild(child);
      throw error;
    }
  }

  async stop(leaseFile: string): Promise<boolean> {
    const lease = await readProcessOwner(leaseFile);
    if (!lease) return false;
    if (!processIsRunning(lease.pid)) {
      await removeOwnedProcessFile(leaseFile, lease.token);
      return false;
    }
    if (lease.controlHost !== "127.0.0.1" || !lease.controlPort) {
      throw new CodexInstallationError(
        "sidecar_stop_failed",
        "Sidecar lease has no authenticated control channel; no process was signalled",
      );
    }
    await requestSidecarStop(lease.controlHost, lease.controlPort, lease.token);
    const deadline = Date.now() + INSTALLATION_LOCK_TIMEOUT_MS;
    while (await readProcessOwner(leaseFile)) {
      if (Date.now() >= deadline) {
        throw new CodexInstallationError(
          "sidecar_stop_failed",
          "Sidecar did not finish draining; plugin and durable data were left unchanged",
        );
      }
      await delay(INSTALLATION_LOCK_RETRY_MS);
    }
    return true;
  }
}

async function requestSidecarStop(host: string, port: number, token: string): Promise<void> {
  await new Promise<void>((resolveStop, rejectStop) => {
    const socket = createConnection({ host, port });
    let response = "";
    const fail = () => rejectStop(new CodexInstallationError(
      "sidecar_stop_failed",
      "Sidecar control channel is unavailable; no process was signalled",
    ));
    socket.setEncoding("utf8");
    socket.setTimeout(INSTALLATION_LOCK_TIMEOUT_MS, () => {
      socket.destroy();
      fail();
    });
    socket.once("error", fail);
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("connect", () => socket.end(`${token}\n`));
    socket.once("close", () => {
      if (response.trim() === "ACCEPTED") resolveStop();
      else fail();
    });
  });
}

async function terminateOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(1_000).then(() => false),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

class SpawnCodexCommandRunner implements CodexCommandRunner {
  run(args: string[]): Promise<CommandResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
    });
  }
}

async function inspectPackage(rawMarketplaceRoot: string): Promise<PackageDescription> {
  const marketplaceRoot = await realpath(resolve(rawMarketplaceRoot)).catch(() => {
    throw new CodexInstallationError("invalid_package", "Marketplace root does not exist");
  });
  const marketplace = await readJsonObject(
    join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    "marketplace manifest",
  );
  const marketplaceName = nonEmptyString(marketplace.name, "Marketplace name");
  const entries = marketplace.plugins;
  if (!Array.isArray(entries)) {
    throw new CodexInstallationError("invalid_package", "Marketplace plugins must be an array");
  }
  const entry = entries.find((candidate) => (
    isRecord(candidate) && candidate.name === PLUGIN_NAME
  ));
  if (!isRecord(entry) || !isRecord(entry.source)) {
    throw new CodexInstallationError("invalid_package", "Marketplace is missing Agent Memory");
  }
  if (entry.source.source !== "local" || entry.source.path !== `./plugins/${PLUGIN_NAME}`) {
    throw new CodexInstallationError(
      "invalid_package",
      "Agent Memory marketplace source must use the packaged local plugin path",
    );
  }
  if (!isRecord(entry.policy) ||
      entry.policy.installation !== "AVAILABLE" ||
      entry.policy.authentication !== "ON_INSTALL") {
    throw new CodexInstallationError(
      "invalid_package",
      "Agent Memory marketplace policy must be AVAILABLE with ON_INSTALL authentication",
    );
  }
  const pluginRoot = await realpath(join(marketplaceRoot, "plugins", PLUGIN_NAME));
  const manifest = await readJsonObject(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    "plugin manifest",
  );
  if (manifest.name !== PLUGIN_NAME) {
    throw new CodexInstallationError("invalid_package", "Plugin folder and manifest name differ");
  }
  const version = nonEmptyString(manifest.version, "Plugin version");
  const hooks = await readJsonObject(join(pluginRoot, "hooks.json"), "hook definitions");
  await assertThinPluginHooks(hooks, pluginRoot);
  return {
    marketplaceName,
    marketplaceRoot,
    pluginName: PLUGIN_NAME,
    pluginRoot,
    version,
    hooksSha256: await hooksDigest(pluginRoot),
  };
}

async function assertThinPluginHooks(
  hooks: Record<string, unknown>,
  pluginRoot: string,
): Promise<void> {
  const lifecycleHooks = hooks.hooks;
  if (!isRecord(lifecycleHooks)) {
    throw new CodexInstallationError("invalid_package", "Hook definitions are missing lifecycle hooks");
  }
  const requiredEvents = [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ];
  if (
    Object.keys(lifecycleHooks).length !== requiredEvents.length ||
    requiredEvents.some((eventName) => !Object.hasOwn(lifecycleHooks, eventName))
  ) {
    throw new CodexInstallationError(
      "invalid_package",
      "Hook definitions must declare the complete supported lifecycle",
    );
  }
  const commands: string[] = [];
  let hookCount = 0;
  for (const groups of Object.values(lifecycleHooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        hookCount++;
        if (isRecord(hook) && hook.type === "command" && typeof hook.command === "string") {
          commands.push(hook.command);
        }
      }
    }
  }
  if (commands.length !== hookCount || hookCount !== requiredEvents.length || commands.some((command) => (
    command !== "node \"${PLUGIN_ROOT}/scripts/memory-hook.mjs\""
  ))) {
    throw new CodexInstallationError(
      "invalid_package",
      "Every lifecycle hook must use the thin PLUGIN_ROOT executable",
    );
  }
  await stat(join(pluginRoot, "scripts", "memory-hook.mjs")).catch(() => {
    throw new CodexInstallationError("invalid_package", "Thin hook executable is missing");
  });
}

async function ensureMarketplace(
  codex: CodexCommandRunner,
  packageInfo: PackageDescription,
): Promise<void> {
  const result = await runCodex(
    codex,
    ["plugin", "marketplace", "list", "--json"],
    "Codex marketplace state could not be inspected",
  );
  const payload = parseJsonObject(result.stdout, "Codex marketplace output");
  if (!Array.isArray(payload.marketplaces)) {
    throw new CodexInstallationError(
      "malformed_codex_output",
      "Codex marketplace output is malformed",
    );
  }
  const configured = payload.marketplaces.find((entry) => (
    isRecord(entry) && entry.name === packageInfo.marketplaceName
  ));
  if (isRecord(configured)) {
    const rawConfiguredRoot = configured.root;
    const configuredRoot = typeof rawConfiguredRoot === "string"
      ? await realpath(rawConfiguredRoot).catch(() => resolve(rawConfiguredRoot))
      : null;
    if (configuredRoot !== packageInfo.marketplaceRoot) {
      throw new CodexInstallationError(
        "marketplace_conflict",
        `Codex marketplace '${packageInfo.marketplaceName}' points to another source`,
      );
    }
    return;
  }
  await runCodex(codex, [
    "plugin",
    "marketplace",
    "add",
    packageInfo.marketplaceRoot,
    "--json",
  ], "Codex could not add the Agent Memory marketplace");
}

async function findInstalledPlugin(
  codex: CodexCommandRunner,
  pluginName: string,
  marketplaceName?: string,
): Promise<InstalledPlugin | null> {
  const result = await runCodex(
    codex,
    ["plugin", "list", "--json"],
    "Codex plugin state could not be inspected",
  );
  const payload = parseJsonObject(result.stdout, "Codex plugin output");
  if (!Array.isArray(payload.installed)) {
    throw new CodexInstallationError("malformed_codex_output", "Codex plugin output is malformed");
  }
  for (const candidate of payload.installed) {
    if (!isRecord(candidate) || candidate.name !== pluginName) continue;
    if (marketplaceName && candidate.marketplaceName !== marketplaceName) continue;
    if (!isRecord(candidate.source) || typeof candidate.source.path !== "string") continue;
    if (
      typeof candidate.pluginId !== "string" ||
      typeof candidate.marketplaceName !== "string" ||
      typeof candidate.version !== "string" ||
      typeof candidate.enabled !== "boolean"
    ) continue;
    return {
      pluginId: candidate.pluginId,
      name: pluginName,
      marketplaceName: candidate.marketplaceName,
      version: candidate.version,
      enabled: candidate.enabled,
      sourcePath: candidate.source.path,
    };
  }
  return null;
}

async function inspectSidecarHealth(
  rawUrl: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<{
  reachableCheck: BindingDoctorCheck;
  memoryCoreCheck: BindingDoctorCheck;
  outboxCheck: BindingDoctorCheck;
}> {
  const unavailable = (message: string) => ({
    reachableCheck: { name: "sidecar_reachable", status: "fail", message },
    memoryCoreCheck: {
      name: "memory_core_reachable",
      status: "fail",
      message: "MemoryCore state is unavailable until the sidecar is reachable",
    },
    outboxCheck: {
      name: "outbox_healthy",
      status: "fail",
      message: "Outbox state is unavailable until the sidecar is reachable",
    },
  } satisfies {
    reachableCheck: BindingDoctorCheck;
    memoryCoreCheck: BindingDoctorCheck;
    outboxCheck: BindingDoctorCheck;
  });
  let url: URL;
  try {
    url = loopbackUrl(rawUrl);
  } catch {
    return unavailable("Sidecar URL must use loopback HTTP");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/health`;
  url.search = "";
  url.hash = "";
  try {
    const response = await fetcher(url, {
      method: "GET",
      signal: AbortSignal.timeout(validTimeout(timeoutMs)),
    });
    if (!response.ok && response.status !== 503) {
      const classification = response.status === 429
        ? "throttled"
        : response.status >= 500
          ? "server failure"
          : response.status >= 400
            ? "client rejection"
            : "unexpected HTTP status";
      return unavailable(
        `Agent Memory sidecar returned ${classification} (HTTP ${response.status})`,
      );
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return unavailable("Sidecar returned malformed health data");
    const reachableCheck: BindingDoctorCheck = {
      name: "sidecar_reachable",
      status: "pass",
      message: response.ok
        ? "Agent Memory sidecar is reachable"
        : "Agent Memory sidecar is reachable and reports degraded health",
    };
    const memoryCore = isRecord(payload.connectivity)
      ? payload.connectivity.memoryCore
      : undefined;
    const memoryCoreCheck: BindingDoctorCheck = {
      name: "memory_core_reachable",
      status: memoryCore === "ok" ? "pass" : "fail",
      message: memoryCore === "ok"
        ? "MemoryCore is reachable from the sidecar"
        : memoryCore === "disabled"
          ? "MemoryCore connectivity is not configured"
          : "MemoryCore is not reachable from the sidecar",
    };
    const outbox = isRecord(payload.durableStore) && isRecord(payload.durableStore.outbox)
      ? payload.durableStore.outbox
      : null;
    const deadCount = outbox && typeof outbox.deadCount === "number" ? outbox.deadCount : null;
    const retryingCount = outbox && typeof outbox.retryingCount === "number"
      ? outbox.retryingCount
      : 0;
    const workerError = outbox?.workerErrorKind;
    let outboxCheck: BindingDoctorCheck;
    if (!outbox || "state" in outbox || deadCount === null) {
      outboxCheck = {
        name: "outbox_healthy",
        status: "fail",
        message: "Durable outbox health is unavailable",
      };
    } else if (deadCount > 0 || (typeof workerError === "string" && workerError.length > 0)) {
      outboxCheck = {
        name: "outbox_healthy",
        status: "fail",
        message: `Durable outbox has ${deadCount} dead item(s) or a worker error`,
      };
    } else if (retryingCount > 0) {
      outboxCheck = {
        name: "outbox_healthy",
        status: "warn",
        message: `Durable outbox is healthy with ${retryingCount} item(s) retrying`,
      };
    } else {
      outboxCheck = {
        name: "outbox_healthy",
        status: "pass",
        message: "Durable outbox has no dead items or worker errors",
      };
    }
    return { reachableCheck, memoryCoreCheck, outboxCheck };
  } catch (error: unknown) {
    if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
      return unavailable("Agent Memory sidecar health check timed out");
    }
    if (error instanceof SyntaxError) {
      return unavailable("Agent Memory sidecar returned malformed health data");
    }
    return unavailable("Agent Memory sidecar network failure");
  }
}

async function runCodex(
  codex: CodexCommandRunner,
  args: string[],
  failureMessage: string,
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await codex.run(args);
  } catch {
    throw new CodexInstallationError("codex_unavailable", failureMessage);
  }
  if (result.code !== 0) {
    throw new CodexInstallationError("codex_command_failed", failureMessage);
  }
  return result;
}

function reviewInstruction(hooksSha256: string): CodexInstallResult["review"] {
  return {
    hooksSha256,
    instruction: `Review the installed definitions with /hooks; hooks are not trusted until SHA-256 ${hooksSha256} is recorded.`,
  };
}

async function hooksDigest(pluginRoot: string): Promise<string> {
  const content = await readFile(join(resolve(pluginRoot), "hooks.json"));
  return createHash("sha256").update(content).digest("hex");
}

async function ensureProtectedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

interface InstallationProcessOwner {
  pid: number;
  token: string;
  controlHost?: string;
  controlPort?: number;
}

async function readProcessOwner(path: string): Promise<InstallationProcessOwner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      isRecord(value) &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.token === "string" &&
      value.token.length > 0
    ) {
      return {
        pid: Number(value.pid),
        token: value.token,
        ...(typeof value.controlHost === "string" ? { controlHost: value.controlHost } : {}),
        ...(Number.isSafeInteger(value.controlPort) && Number(value.controlPort) > 0
          ? { controlPort: Number(value.controlPort) }
          : {}),
      };
    }
    return null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    return null;
  }
}

async function waitForSidecarLease(path: string, expectedPid: number): Promise<void> {
  const deadline = Date.now() + INSTALLATION_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lease = await readProcessOwner(path);
    if (lease?.pid === expectedPid && processIsRunning(expectedPid)) return;
    if (!processIsRunning(expectedPid)) break;
    await delay(INSTALLATION_LOCK_RETRY_MS);
  }
  throw new CodexInstallationError(
    "sidecar_start_failed",
    "Sidecar did not become ready; inspect it with the doctor command",
  );
}

async function withInstallationLock<T>(
  paths: CodexInstallationPaths,
  action: () => Promise<T>,
): Promise<T> {
  return withProcessLock({
    lockDir: paths.lifecycleLockFile,
    retryMs: INSTALLATION_LOCK_RETRY_MS,
    timeoutMs: INSTALLATION_LOCK_TIMEOUT_MS,
    malformedStaleMs: MALFORMED_LOCK_STALE_MS,
    busyError: () => new CodexInstallationError(
      "installation_busy",
      "Codex installation state is busy; retry the lifecycle operation",
    ),
  }, action);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function removeOwnedProcessFile(path: string, token: string): Promise<void> {
  try {
    const current: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(current) && current.token === token) await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function requireDirectory(path: string, message: string): Promise<void> {
  const exists = await stat(path).then(
    (value) => value.isDirectory(),
    (error: unknown) => errorCode(error) === "ENOENT" ? false : Promise.reject(error),
  );
  if (!exists) throw new CodexInstallationError("not_installed", message);
}

async function atomicWriteJson(path: string, value: unknown, mode: number): Promise<void> {
  await ensureProtectedDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, mode);
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readInstallationState(path: string): Promise<InstallationState | null> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new CodexInstallationError("invalid_installation_state", "Installation state is invalid");
  }
  if (
    !isRecord(payload) ||
    payload.version !== INSTALLATION_VERSION ||
    typeof payload.pluginName !== "string" ||
    typeof payload.marketplaceName !== "string" ||
    typeof payload.marketplaceRoot !== "string" ||
    typeof payload.installedVersion !== "string" ||
    typeof payload.installedAt !== "string" ||
    typeof payload.updatedAt !== "string" ||
    (payload.projectDir !== undefined || payload.configFile !== undefined) && (
      (payload.projectDir !== undefined && typeof payload.projectDir !== "string") ||
      (payload.configFile !== undefined && typeof payload.configFile !== "string")
    ) ||
    (payload.reviewedHooksSha256 !== undefined &&
      (typeof payload.reviewedHooksSha256 !== "string" ||
       !/^[a-f0-9]{64}$/.test(payload.reviewedHooksSha256)))
  ) {
    throw new CodexInstallationError("invalid_installation_state", "Installation state is invalid");
  }
  return {
    version: INSTALLATION_VERSION,
    pluginName: payload.pluginName,
    marketplaceName: payload.marketplaceName,
    marketplaceRoot: payload.marketplaceRoot,
    installedVersion: payload.installedVersion,
    installedAt: payload.installedAt,
    updatedAt: payload.updatedAt,
    ...(typeof payload.projectDir === "string" ? { projectDir: payload.projectDir } : {}),
    ...(typeof payload.configFile === "string" ? { configFile: payload.configFile } : {}),
    ...(typeof payload.reviewedHooksSha256 === "string"
      ? { reviewedHooksSha256: payload.reviewedHooksSha256 }
      : {}),
  };
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new CodexInstallationError("invalid_package", `${label} must be valid JSON`);
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(value);
    if (!isRecord(payload)) throw new Error("not an object");
    return payload;
  } catch {
    throw new CodexInstallationError("malformed_codex_output", `${label} is malformed`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CodexInstallationError("invalid_package", `${label} must be a non-empty string`);
  }
  return value;
}

function loopbackUrl(value: string): URL {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error("not loopback");
  }
  return url;
}

function validTimeout(value: number): number {
  return Number.isSafeInteger(value) && value >= 50 && value <= 30_000
    ? value
    : DEFAULT_TIMEOUT_MS;
}

function defaultUserConfigDir(): string {
  return resolveUserConfigDir();
}

export async function assertProtectedStateOutsideProject(
  projectDir: string,
  stateDir: string,
): Promise<void> {
  let projectRoot: string;
  try {
    const projectStats = await stat(projectDir);
    if (!projectStats.isDirectory()) throw new Error("not a directory");
    projectRoot = await realpath(projectDir);
  } catch {
    throw new CodexInstallationError(
      "invalid_configuration",
      "Project root must be an existing directory",
    );
  }
  const stateRoot = await canonicalizeProspectivePath(stateDir);
  const child = relative(projectRoot, stateRoot);
  const stateInsideProject = child === "" || (
    child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  );
  const projectFromState = relative(stateRoot, projectRoot);
  const stateContainsProject = projectFromState === "" || (
    projectFromState !== ".." &&
    !projectFromState.startsWith(`..${sep}`) &&
    !isAbsolute(projectFromState)
  );
  if (stateInsideProject || stateContainsProject) {
    throw new CodexInstallationError(
      "state_in_project",
      "Writable sidecar state must be outside the project",
    );
  }
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

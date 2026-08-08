import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { verifyUserKeyWithConfig } from "../auth.js";
import { MetadataClient } from "../meta/client.js";

export const PROJECT_BINDING_RELATIVE_PATH = join(".codex", "memory-binding.json");
const CREDENTIAL_FILE_NAME = "credentials.json";
const CONFIG_VERSION = 1;
const CREDENTIAL_LOCK_RETRY_MS = 25;
const CREDENTIAL_LOCK_TIMEOUT_MS = 5_000;
const MALFORMED_LOCK_STALE_MS = 30_000;

export interface CodexProjectBinding {
  version: 1;
  source: "codex";
  service_id: string;
  team_id: string;
  agent_id: string;
  task_id: string;
  preferences?: Record<string, string | number | boolean>;
}

interface CredentialFile {
  version: 1;
  user_keys: Record<string, string>;
}

function emptyCredentialFile(): CredentialFile {
  return {
    version: CONFIG_VERSION,
    user_keys: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function setUserKey(
  userKeys: Record<string, string>,
  serviceId: string,
  userKey: string,
): void {
  Object.defineProperty(userKeys, serviceId, {
    configurable: true,
    enumerable: true,
    value: userKey,
    writable: true,
  });
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface BindCodexProjectInput {
  projectDir: string;
  /** Injectable root for tests; defaults to the protected user config root. */
  userConfigDir?: string;
  endpoint: string;
  authUrl?: string;
  serviceId: string;
  serviceToken: string;
  userKey: string;
  teamId: string;
  agentId: string;
  taskId: string;
  preferences?: Record<string, string | number | boolean>;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface BindCodexProjectResult {
  binding: CodexProjectBinding;
  projectConfigPath: string;
  credentialPath: string;
  userId: string;
}

export interface CodexBindingPaths {
  projectDir: string;
  userConfigDir?: string;
}

export interface CodexBindingStatus {
  bound: boolean;
  binding?: CodexProjectBinding;
  credentialConfigured: boolean;
  projectConfigPath: string;
  credentialPath: string;
}

/** Internal sidecar view; never serialize this value into hook output or logs. */
export interface CodexRuntimeCredential {
  binding: CodexProjectBinding;
  userKey: string;
}

export interface BindingDoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

export interface CodexBindingDiagnosis {
  ok: boolean;
  checks: BindingDoctorCheck[];
}

export class CodexBindingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexBindingError";
  }
}

export function resolveUserConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg
    ? join(xdg, "tencentdb-agent-memory", "codex")
    : join(homedir(), ".config", "tencentdb-agent-memory", "codex");
}

export function resolveCredentialPath(userConfigDir = resolveUserConfigDir()): string {
  return join(resolve(userConfigDir), CREDENTIAL_FILE_NAME);
}

export function resolveProjectBindingPath(projectDir: string): string {
  return join(resolve(projectDir), PROJECT_BINDING_RELATIVE_PATH);
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CodexBindingError("invalid_binding", `${label} is required`);
  }
  return normalized;
}

function validatedUrl(label: string, value: string): string {
  let url: URL;
  try {
    url = new URL(required(label, value));
  } catch {
    throw new CodexBindingError("invalid_configuration", `${label} must be a valid HTTP(S) URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new CodexBindingError(
      "invalid_configuration",
      `${label} must be an HTTP(S) URL without embedded credentials`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

function validatedTimeout(value: number | undefined): number {
  const timeoutMs = value ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CodexBindingError(
      "invalid_configuration",
      "Timeout must be a positive integer number of milliseconds",
    );
  }
  return timeoutMs;
}

function classifyValidationFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : "";
  if (/malformed|unexpected (?:null|token|end|verify response)|JSON/i.test(detail)) {
    return "returned malformed data";
  }
  if (/timeout|timed out|abort/i.test(detail)) return "timed out";
  const status = Number(detail.match(/\bHTTP (\d{3})\b/)?.[1]);
  if (status === 429) return "throttled the request";
  if (status >= 500) return "is unavailable";
  if (status >= 400) return "rejected the request";
  if (/envelope error/i.test(detail)) return "rejected the response";
  if (/fetch failed/i.test(detail)) return "could not be reached";
  return "request failed";
}

function wrapValidationError(scope: string, error: unknown): CodexBindingError {
  return new CodexBindingError(
    "validation_failed",
    `Unable to validate ${scope}: MemoryCore metadata ${classifyValidationFailure(error)}`,
  );
}

function wrapAuthenticationError(rejectReason: string | undefined): CodexBindingError {
  if (rejectReason === "invalid user_key") {
    return new CodexBindingError(
      "authentication_failed",
      "User key is invalid or unauthorized for the selected Memory service",
    );
  }
  return new CodexBindingError(
    "validation_failed",
    `Unable to validate user key: MemoryCore authentication ${
      classifyValidationFailure(new Error(rejectReason ?? "malformed response"))
    }`,
  );
}

function assertMetadataEntities(
  scope: string,
  items: unknown[],
  requiredFields: string[],
): void {
  const malformed = items.some((item) => (
    !isRecord(item) ||
    requiredFields.some((field) => (
      typeof item[field] !== "string" ||
      !item[field].trim()
    ))
  ));
  if (malformed) {
    throw new CodexBindingError(
      "validation_failed",
      `Unable to validate ${scope}: MemoryCore metadata returned malformed data`,
    );
  }
}

async function atomicWriteJson(path: string, value: unknown, mode: number): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: mode === 0o600 ? 0o700 : 0o755 });
  if (mode === 0o600) await chmod(parent, 0o700);

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
    await syncPath(path);
    await syncPath(parent);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

interface CredentialLockOwner {
  pid: number;
  token: string;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function lockCanBeRemoved(lockPath: string): Promise<boolean> {
  try {
    const [text, lockStat] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0) {
      return !processIsRunning(Number(parsed.pid));
    }
    return Date.now() - lockStat.mtimeMs >= MALFORMED_LOCK_STALE_MS;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    return false;
  }
}

async function withCredentialStoreLock<T>(
  credentialPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${credentialPath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + CREDENTIAL_LOCK_TIMEOUT_MS;
  const owner: CredentialLockOwner = { pid: process.pid, token: randomUUID() };
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        handle = null;
        await unlink(lockPath).catch(() => undefined);
      }
      if (errorCode(error) !== "EEXIST") throw error;
      if (await lockCanBeRemoved(lockPath)) {
        await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CodexBindingError(
          "credential_store_busy",
          "Protected credential store is busy; retry the local operation",
        );
      }
      await delay(CREDENTIAL_LOCK_RETRY_MS);
    }
  }

  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    try {
      const current: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      if (isRecord(current) && current.token === owner.token) await unlink(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function readCredentialFile(path: string): Promise<CredentialFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.version !== CONFIG_VERSION ||
      !isRecord(parsed.user_keys) ||
      Object.keys(parsed).some((key) => !["version", "user_keys"].includes(key))
    ) {
      throw new Error("unsupported credential file format");
    }
    const userKeys: Record<string, string> = {};
    for (const [serviceId, userKey] of Object.entries(parsed.user_keys)) {
      if (
        !serviceId.trim() ||
        serviceId !== serviceId.trim() ||
        typeof userKey !== "string" ||
        !userKey.trim()
      ) {
        throw new Error("unsupported credential file format");
      }
      setUserKey(userKeys, serviceId, userKey);
    }
    return { version: CONFIG_VERSION, user_keys: userKeys };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return emptyCredentialFile();
    }
    throw new CodexBindingError(
      "credential_store_invalid",
      `Cannot read protected credential store: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const FORBIDDEN_SECRET_FIELDS = new Set([
  "access_token",
  "auth_token",
  "api_key",
  "authorization",
  "bearer_token",
  "client_secret",
  "cookie",
  "credential",
  "credentials",
  "id_token",
  "password",
  "passphrase",
  "private_key",
  "refresh_token",
  "secret",
  "secret_key",
  "service_token",
  "session_token",
  "token",
  "user_key",
]);

const COMPOUND_SECRET_FIELD_RE = /(?:^|_)(?:access_token|auth_token|api_key|bearer_token|client_secret|cookie|credentials?|id_token|password|passphrase|private_key|refresh_token|secret(?:_key)?|service_token|session_token|user_key)(?:_|$)/;

function normalizeFieldName(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function findForbiddenSecretField(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeFieldName(key);
    if (
      FORBIDDEN_SECRET_FIELDS.has(normalized) ||
      COMPOUND_SECRET_FIELD_RE.test(normalized) ||
      normalized.endsWith("_token")
    ) return key;
    const nested = findForbiddenSecretField(child);
    if (nested) return nested;
  }
  return null;
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

function pathIsWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

async function assertCredentialOutsideProject(
  projectDir: string,
  credentialPath: string,
): Promise<void> {
  let projectRoot: string;
  try {
    const projectStats = await stat(projectDir);
    if (!projectStats.isDirectory()) throw new Error("not a directory");
    projectRoot = await realpath(projectDir);
  } catch {
    throw new CodexBindingError(
      "invalid_configuration",
      "Project root must be an existing directory",
    );
  }

  const credentialLocation = await canonicalizeProspectivePath(credentialPath);
  if (pathIsWithin(projectRoot, credentialLocation)) {
    throw new CodexBindingError(
      "secret_in_project_config",
      "Credential store must be outside the project",
    );
  }
}

function parsePreferences(
  value: unknown,
): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexBindingError("invalid_project_binding", "Binding preferences must be an object");
  }
  const forbidden = findForbiddenSecretField(value);
  if (forbidden) {
    throw new CodexBindingError(
      "secret_in_project_config",
      `Project binding contains forbidden secret field '${forbidden}'`,
    );
  }
  const preferences: Record<string, string | number | boolean> = {};
  for (const [key, preference] of Object.entries(value)) {
    if (
      typeof preference !== "string" &&
      typeof preference !== "number" &&
      typeof preference !== "boolean"
    ) {
      throw new CodexBindingError(
        "invalid_project_binding",
        `Binding preference '${key}' must be a string, number, or boolean`,
      );
    }
    if (typeof preference === "number" && !Number.isFinite(preference)) {
      throw new CodexBindingError(
        "invalid_project_binding",
        `Binding preference '${key}' must be JSON-safe`,
      );
    }
    preferences[key] = preference;
  }
  return preferences;
}

function parseProjectBinding(value: unknown): CodexProjectBinding {
  if (!isRecord(value)) {
    throw new CodexBindingError("invalid_project_binding", "Project binding must be a JSON object");
  }
  const forbidden = findForbiddenSecretField(value);
  if (forbidden) {
    throw new CodexBindingError(
      "secret_in_project_config",
      `Project binding contains forbidden secret field '${forbidden}'`,
    );
  }
  const record = value;
  const allowed = new Set([
    "version",
    "source",
    "service_id",
    "team_id",
    "agent_id",
    "task_id",
    "preferences",
  ]);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new CodexBindingError(
      "invalid_project_binding",
      `Project binding contains unsupported field '${unknown}'`,
    );
  }
  if (record.version !== CONFIG_VERSION || record.source !== "codex") {
    throw new CodexBindingError(
      "invalid_project_binding",
      "Project binding must use version 1 and source 'codex'",
    );
  }
  const binding: CodexProjectBinding = {
    version: CONFIG_VERSION,
    source: "codex",
    service_id: required("Service ID", typeof record.service_id === "string" ? record.service_id : ""),
    team_id: required("Team ID", typeof record.team_id === "string" ? record.team_id : ""),
    agent_id: required("Agent ID", typeof record.agent_id === "string" ? record.agent_id : ""),
    task_id: required("Task ID", typeof record.task_id === "string" ? record.task_id : ""),
  };
  if (record.preferences !== undefined) {
    binding.preferences = parsePreferences(record.preferences);
  }
  return binding;
}

export async function readCodexProjectBinding(projectDir: string): Promise<CodexProjectBinding | null> {
  try {
    return parseProjectBinding(JSON.parse(await readFile(resolveProjectBindingPath(projectDir), "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof CodexBindingError) throw error;
    throw new CodexBindingError(
      "invalid_project_binding",
      `Cannot read project binding: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Resolve the validated project binding and its protected user-level key. */
export async function resolveCodexRuntimeCredential(
  paths: CodexBindingPaths,
): Promise<CodexRuntimeCredential | null> {
  const binding = await readCodexProjectBinding(paths.projectDir);
  if (!binding) return null;
  const credentialPath = resolveCredentialPath(paths.userConfigDir);
  await assertCredentialOutsideProject(paths.projectDir, credentialPath);
  const credentials = await readCredentialFile(credentialPath);
  const userKey = credentials.user_keys[binding.service_id];
  if (typeof userKey !== "string" || userKey.trim().length === 0) return null;
  return { binding, userKey };
}

/** Validate the complete current runtime scope, then persist it locally. */
export async function bindCodexProject(
  input: BindCodexProjectInput,
): Promise<BindCodexProjectResult> {
  const serviceId = required("Service ID", input.serviceId);
  const userKey = required("User key", input.userKey);
  const serviceToken = required("Service token", input.serviceToken);
  const teamId = required("Team ID", input.teamId);
  const agentId = required("Agent ID", input.agentId);
  const taskId = required("Task ID", input.taskId);
  const preferences = input.preferences === undefined
    ? undefined
    : parsePreferences(input.preferences);
  const endpoint = validatedUrl("MemoryCore endpoint", input.endpoint);
  const authUrl = validatedUrl("Auth URL", input.authUrl ?? endpoint);
  const timeoutMs = validatedTimeout(input.timeoutMs);
  const fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis);
  const credentialPath = resolveCredentialPath(input.userConfigDir);

  await assertCredentialOutsideProject(input.projectDir, credentialPath);

  const verified = await verifyUserKeyWithConfig(
    { url: authUrl, timeoutMs, serviceToken },
    userKey,
    serviceId,
    fetcher,
  );
  if (verified.rejected || !verified.userId) {
    throw wrapAuthenticationError(verified.rejectReason);
  }

  const metadata = new MetadataClient(
    { endpoint, serviceToken, timeoutMs },
    serviceId,
    userKey,
    fetcher,
  );

  let teams;
  try {
    teams = await metadata.listTeams(verified.userId);
  } catch (error) {
    throw wrapValidationError("Team", error);
  }
  assertMetadataEntities("Team", teams, ["team_id"]);
  if (!teams.some((team) => team.team_id === teamId)) {
    throw new CodexBindingError(
      "invalid_team",
      `Team '${teamId}' is missing or unauthorized for the verified user`,
    );
  }

  let agents;
  let tasks;
  try {
    [agents, tasks] = await Promise.all([
      metadata.listAgents(teamId, verified.userId),
      metadata.listTasks(teamId),
    ]);
  } catch (error) {
    throw wrapValidationError("Agent/Task scope", error);
  }
  assertMetadataEntities("Agent", agents, ["agent_id", "team_id"]);
  assertMetadataEntities("Task", tasks, ["task_id", "team_id"]);
  if (!agents.some((agent) => agent.agent_id === agentId && agent.team_id === teamId)) {
    throw new CodexBindingError(
      "invalid_agent",
      `Agent '${agentId}' is missing or unauthorized for Team '${teamId}'`,
    );
  }
  if (!tasks.some((task) => task.task_id === taskId && task.team_id === teamId)) {
    throw new CodexBindingError(
      "invalid_task",
      `Task '${taskId}' is missing or unauthorized for Team '${teamId}'`,
    );
  }

  const binding: CodexProjectBinding = {
    version: CONFIG_VERSION,
    source: "codex",
    service_id: serviceId,
    team_id: teamId,
    agent_id: agentId,
    task_id: taskId,
    ...(preferences && Object.keys(preferences).length > 0
      ? { preferences }
      : {}),
  };
  const projectConfigPath = resolveProjectBindingPath(input.projectDir);
  await withCredentialStoreLock(credentialPath, async () => {
    const credentials = await readCredentialFile(credentialPath);
    setUserKey(credentials.user_keys, serviceId, userKey);

    // Serialize the two-file update so concurrent binds cannot lose a key or
    // leave the winning project binding paired with another writer's key.
    await atomicWriteJson(credentialPath, credentials, 0o600);
    await atomicWriteJson(projectConfigPath, binding, 0o644);
  });

  return {
    binding,
    projectConfigPath,
    credentialPath,
    userId: verified.userId,
  };
}

/** Used by doctor checks without ever exposing the stored credential. */
export async function credentialFileMode(userConfigDir?: string): Promise<number | null> {
  try {
    return (await stat(resolveCredentialPath(userConfigDir))).mode & 0o777;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** Return binding health without exposing the credential value. */
export async function getCodexBindingStatus(
  paths: CodexBindingPaths,
): Promise<CodexBindingStatus> {
  const binding = await readCodexProjectBinding(paths.projectDir);
  const credentialPath = resolveCredentialPath(paths.userConfigDir);
  const credentials = await readCredentialFile(credentialPath);
  return {
    bound: binding !== null,
    ...(binding ? { binding } : {}),
    credentialConfigured: binding
      ? typeof credentials.user_keys[binding.service_id] === "string"
      : Object.keys(credentials.user_keys).length > 0,
    projectConfigPath: resolveProjectBindingPath(paths.projectDir),
    credentialPath,
  };
}

/** Local-only diagnostics; this operation never invokes a model or network API. */
export async function doctorCodexBinding(
  paths: CodexBindingPaths,
): Promise<CodexBindingDiagnosis> {
  const checks: BindingDoctorCheck[] = [];
  let status: CodexBindingStatus;
  try {
    status = await getCodexBindingStatus(paths);
    checks.push({
      name: "project_binding",
      status: status.bound ? "pass" : "fail",
      message: status.bound
        ? "Project has a valid Codex Team/Agent/Task binding"
        : "Project is not bound",
    });
  } catch (error) {
    checks.push({
      name: "project_binding",
      status: "fail",
      message: error instanceof CodexBindingError
        ? error.message
        : "Project binding could not be inspected",
    });
    return { ok: false, checks };
  }

  checks.push({
    name: "credential_present",
    status: status.credentialConfigured ? "pass" : "fail",
    message: status.credentialConfigured
      ? "A protected user credential is configured for this service"
      : "No user credential is configured for this service",
  });

  try {
    await assertCredentialOutsideProject(paths.projectDir, status.credentialPath);
    checks.push({
      name: "credential_location",
      status: "pass",
      message: "Credential store is outside the project",
    });
  } catch (error) {
    checks.push({
      name: "credential_location",
      status: "fail",
      message: error instanceof CodexBindingError
        ? error.message
        : "Credential store location could not be inspected",
    });
  }

  let credentialMode: number | null = null;
  let directoryMode: number | null = null;
  try {
    credentialMode = (await stat(status.credentialPath)).mode & 0o777;
    directoryMode = (await stat(dirname(status.credentialPath))).mode & 0o777;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      checks.push({
        name: "credential_permissions",
        status: "fail",
        message: "Credential permissions could not be inspected",
      });
    }
  }
  if (credentialMode !== null) {
    checks.push({
      name: "credential_permissions",
      status: (credentialMode & 0o077) === 0 ? "pass" : "fail",
      message: (credentialMode & 0o077) === 0
        ? "Credential file is accessible only to its owner"
        : `Credential file permissions are too broad (${credentialMode.toString(8)}; expected 600)`,
    });
  }
  if (directoryMode !== null) {
    checks.push({
      name: "credential_directory_permissions",
      status: (directoryMode & 0o077) === 0 ? "pass" : "fail",
      message: (directoryMode & 0o077) === 0
        ? "Credential directory is accessible only to its owner"
        : `Credential directory permissions are too broad (${directoryMode.toString(8)}; expected 700)`,
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

export interface UnbindCodexProjectInput extends CodexBindingPaths {
  forgetCredential?: boolean;
}

export interface UnbindCodexProjectResult {
  removed: boolean;
  credentialRemoved: boolean;
}

async function removeProjectBindingFile(projectDir: string): Promise<boolean> {
  let removed = false;
  const projectBindingPath = resolveProjectBindingPath(projectDir);
  await unlink(projectBindingPath)
    .then(() => { removed = true; })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  if (removed) await syncPath(dirname(projectBindingPath));
  return removed;
}

/** Remove local binding state without invoking a model or network API. */
export async function unbindCodexProject(
  input: UnbindCodexProjectInput,
): Promise<UnbindCodexProjectResult> {
  if (!input.forgetCredential) {
    return {
      removed: await removeProjectBindingFile(input.projectDir),
      credentialRemoved: false,
    };
  }

  const credentialPath = resolveCredentialPath(input.userConfigDir);
  await assertCredentialOutsideProject(input.projectDir, credentialPath);
  return withCredentialStoreLock(credentialPath, async () => {
    let binding: CodexProjectBinding | null = null;
    try {
      binding = await readCodexProjectBinding(input.projectDir);
    } catch (error) {
      if (!(error instanceof CodexBindingError)) throw error;
    }
    let credentialRemoved = false;

    if (binding) {
      const credentials = await readCredentialFile(credentialPath);
      if (Object.hasOwn(credentials.user_keys, binding.service_id)) {
        delete credentials.user_keys[binding.service_id];
        credentialRemoved = true;
        if (Object.keys(credentials.user_keys).length === 0) {
          let removedCredentialFile = false;
          await unlink(credentialPath)
            .then(() => { removedCredentialFile = true; })
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
          if (removedCredentialFile) await syncPath(dirname(credentialPath));
        } else {
          await atomicWriteJson(credentialPath, credentials, 0o600);
        }
      }
    }

    return {
      removed: await removeProjectBindingFile(input.projectDir),
      credentialRemoved,
    };
  });
}

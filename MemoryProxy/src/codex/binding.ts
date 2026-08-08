import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { verifyUserKeyWithConfig } from "../auth.js";
import { MetadataClient } from "../meta/client.js";

export const PROJECT_BINDING_RELATIVE_PATH = join(".codex", "memory-binding.json");
const CREDENTIAL_FILE_NAME = "credentials.json";
const CONFIG_VERSION = 1;

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
    user_keys: Object.create(null) as Record<string, string>,
  };
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

function redact(message: string, secrets: string[]): string {
  return secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join("[REDACTED]"), message);
}

function wrapValidationError(scope: string, error: unknown, secrets: string[]): CodexBindingError {
  const detail = error instanceof Error ? error.message : String(error);
  return new CodexBindingError(
    "validation_failed",
    redact(`Unable to validate ${scope}: ${detail}`, secrets),
  );
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
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readCredentialFile(path: string): Promise<CredentialFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CredentialFile>;
    if (
      parsed.version !== CONFIG_VERSION ||
      !parsed.user_keys ||
      typeof parsed.user_keys !== "object" ||
      Array.isArray(parsed.user_keys)
    ) {
      throw new Error("unsupported credential file format");
    }
    const userKeys = Object.create(null) as Record<string, string>;
    for (const [serviceId, userKey] of Object.entries(parsed.user_keys)) {
      if (typeof userKey === "string" && userKey) userKeys[serviceId] = userKey;
    }
    return { version: CONFIG_VERSION, user_keys: userKeys };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
  "api_key",
  "authorization",
  "credential",
  "credentials",
  "password",
  "refresh_token",
  "secret",
  "service_token",
  "token",
  "user_key",
]);

function normalizeFieldName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function findForbiddenSecretField(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_FIELDS.has(normalizeFieldName(key))) return key;
    const nested = findForbiddenSecretField(child);
    if (nested) return nested;
  }
  return null;
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
    if (!["string", "number", "boolean"].includes(typeof preference)) {
      throw new CodexBindingError(
        "invalid_project_binding",
        `Binding preference '${key}' must be a string, number, or boolean`,
      );
    }
    preferences[key] = preference as string | number | boolean;
  }
  return preferences;
}

function parseProjectBinding(value: unknown): CodexProjectBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexBindingError("invalid_project_binding", "Project binding must be a JSON object");
  }
  const forbidden = findForbiddenSecretField(value);
  if (forbidden) {
    throw new CodexBindingError(
      "secret_in_project_config",
      `Project binding contains forbidden secret field '${forbidden}'`,
    );
  }
  const record = value as Record<string, unknown>;
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof CodexBindingError) throw error;
    throw new CodexBindingError(
      "invalid_project_binding",
      `Cannot read project binding: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  const timeoutMs = input.timeoutMs ?? 5_000;
  const fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis);
  const secrets = [userKey, serviceToken];

  const verified = await verifyUserKeyWithConfig(
    { url: authUrl, timeoutMs },
    userKey,
    serviceId,
    fetcher,
  );
  if (verified.rejected || !verified.userId) {
    throw new CodexBindingError(
      "authentication_failed",
      "User key is invalid or unauthorized for the selected Memory service",
    );
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
    throw wrapValidationError("Team", error, secrets);
  }
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
    throw wrapValidationError("Agent/Task scope", error, secrets);
  }
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
  const credentialPath = resolveCredentialPath(input.userConfigDir);
  const credentials = await readCredentialFile(credentialPath);
  credentials.user_keys[serviceId] = userKey;

  // Both writes happen only after every remote validation has succeeded.
  await atomicWriteJson(credentialPath, credentials, 0o600);
  const projectConfigPath = resolveProjectBindingPath(input.projectDir);
  await atomicWriteJson(projectConfigPath, binding, 0o644);

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
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

  let credentialMode: number | null = null;
  let directoryMode: number | null = null;
  try {
    credentialMode = (await stat(status.credentialPath)).mode & 0o777;
    directoryMode = (await stat(dirname(status.credentialPath))).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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

/** Remove local binding state without invoking a model or network API. */
export async function unbindCodexProject(
  input: UnbindCodexProjectInput,
): Promise<UnbindCodexProjectResult> {
  const binding = await readCodexProjectBinding(input.projectDir);
  let credentialRemoved = false;

  if (input.forgetCredential && binding) {
    const credentialPath = resolveCredentialPath(input.userConfigDir);
    const credentials = await readCredentialFile(credentialPath);
    if (Object.hasOwn(credentials.user_keys, binding.service_id)) {
      delete credentials.user_keys[binding.service_id];
      credentialRemoved = true;
      if (Object.keys(credentials.user_keys).length === 0) {
        await unlink(credentialPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else {
        await atomicWriteJson(credentialPath, credentials, 0o600);
      }
    }
  }

  let removed = false;
  await unlink(resolveProjectBindingPath(input.projectDir))
    .then(() => { removed = true; })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });

  return { removed, credentialRemoved };
}

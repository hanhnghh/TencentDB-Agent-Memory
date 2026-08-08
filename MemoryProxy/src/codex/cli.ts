import { pathToFileURL } from "node:url";

import {
  bindCodexProject,
  doctorCodexBinding,
  getCodexBindingStatus,
  unbindCodexProject,
  type BindCodexProjectInput,
  type BindCodexProjectResult,
  type CodexBindingDiagnosis,
  type CodexBindingPaths,
  type CodexBindingStatus,
  type UnbindCodexProjectInput,
  type UnbindCodexProjectResult,
} from "./binding.js";

export interface CodexBindingCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CodexBindingCliDependencies {
  bind(input: BindCodexProjectInput): Promise<BindCodexProjectResult>;
  status(input: CodexBindingPaths): Promise<CodexBindingStatus>;
  doctor(input: CodexBindingPaths): Promise<CodexBindingDiagnosis>;
  unbind(input: UnbindCodexProjectInput): Promise<UnbindCodexProjectResult>;
}

const defaultDependencies: CodexBindingCliDependencies = {
  bind: bindCodexProject,
  status: getCodexBindingStatus,
  doctor: doctorCodexBinding,
  unbind: unbindCodexProject,
};

const defaultIo: CodexBindingCliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

class CliUsageError extends Error {}

interface ParsedOptions {
  values: Map<string, string>;
  flags: Set<string>;
}

const BOOLEAN_FLAGS = new Set(["forget-credential", "help"]);
const VALUE_OPTIONS = new Set([
  "agent-id",
  "auth-url",
  "endpoint",
  "project",
  "service-id",
  "task-id",
  "team-id",
  "user-config-dir",
]);
const SECRET_OPTION_ENV = new Map([
  ["service-token", "MEMORY_CORE_SERVICE_TOKEN"],
  ["user-key", "MEMORY_HUB_USER_KEY"],
]);

function parseOptions(args: string[]): ParsedOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new CliUsageError("Unexpected positional argument");
    }
    const rawName = argument.slice(2);
    const equalsIndex = rawName.indexOf("=");
    const name = equalsIndex === -1 ? rawName : rawName.slice(0, equalsIndex);
    const secretEnv = SECRET_OPTION_ENV.get(name);
    if (secretEnv) {
      throw new CliUsageError(
        `--${name} is not accepted because command-line values may be exposed; set ${secretEnv} instead`,
      );
    }
    if (equalsIndex !== -1) {
      throw new CliUsageError("Inline --option=value syntax is not supported");
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      throw new CliUsageError("Unknown option");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliUsageError(`--${name} requires a value`);
    }
    values.set(name, value);
    index++;
  }
  return { values, flags };
}

function requiredOption(
  options: ParsedOptions,
  name: string,
  env: NodeJS.ProcessEnv,
  envName?: string,
): string {
  const value = options.values.get(name) ?? (envName ? env[envName] : undefined);
  if (!value?.trim()) throw new CliUsageError(`--${name} is required`);
  return value.trim();
}

function paths(options: ParsedOptions): CodexBindingPaths {
  return {
    projectDir: options.values.get("project") ?? process.cwd(),
    ...(options.values.get("user-config-dir")
      ? { userConfigDir: options.values.get("user-config-dir") }
      : {}),
  };
}

function usage(): string {
  return [
    "Usage: npm run codex -- <command> [options]",
    "",
    "Commands:",
    "  bind            Validate and store a Codex project binding",
    "  unbind          Remove the project binding",
    "  status          Show local binding status",
    "  binding-status  Alias for status",
    "  doctor          Diagnose local binding and credential permissions",
    "",
    "Bind options:",
    "  --service-id --team-id --agent-id --task-id",
    "  --endpoint (or MEMORY_CORE_ENDPOINT)",
    "  MEMORY_CORE_SERVICE_TOKEN (environment only)",
    "  MEMORY_HUB_USER_KEY (environment only)",
    "  --auth-url (or MEMORY_AUTH_URL; defaults to endpoint)",
    "",
    "Common options:",
    "  --project <path>  Project root (defaults to current directory)",
    "  --user-config-dir <path>  Protected credential root (must be outside the project)",
  ].join("\n");
}

function redactCliError(message: string, env: NodeJS.ProcessEnv, options: ParsedOptions): string {
  const secrets = [
    env.MEMORY_CORE_SERVICE_TOKEN,
    env.MEMORY_HUB_USER_KEY,
    options.values.get("service-token"),
    options.values.get("user-key"),
  ].filter((value): value is string => Boolean(value));
  return secrets
    .sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join("[REDACTED]"), message);
}

export async function runCodexBindingCli(
  argv: string[],
  io: CodexBindingCliIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CodexBindingCliDependencies = defaultDependencies,
): Promise<number> {
  const command = argv[0];
  let options: ParsedOptions;
  try {
    options = parseOptions(argv.slice(1));
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (!command || command === "help" || options.flags.has("help")) {
    io.stdout(usage());
    return command ? 0 : 2;
  }

  try {
    if (command === "bind") {
      const endpoint = requiredOption(options, "endpoint", env, "MEMORY_CORE_ENDPOINT");
      const result = await dependencies.bind({
        ...paths(options),
        endpoint,
        authUrl: options.values.get("auth-url") ?? env.MEMORY_AUTH_URL ?? endpoint,
        serviceId: requiredOption(options, "service-id", env, "MEMORY_SERVICE_ID"),
        serviceToken: requiredOption(options, "service-token", env, "MEMORY_CORE_SERVICE_TOKEN"),
        userKey: requiredOption(options, "user-key", env, "MEMORY_HUB_USER_KEY"),
        teamId: requiredOption(options, "team-id", env),
        agentId: requiredOption(options, "agent-id", env),
        taskId: requiredOption(options, "task-id", env),
      });
      io.stdout(
        `Bound Codex to Team ${result.binding.team_id}, Agent ${result.binding.agent_id}, ` +
        `Task ${result.binding.task_id}.`,
      );
      io.stdout(`Project config: ${result.projectConfigPath}`);
      io.stdout(`User credential: protected at ${result.credentialPath}`);
      return 0;
    }

    if (command === "status" || command === "binding-status") {
      const status = await dependencies.status(paths(options));
      io.stdout(JSON.stringify(status, null, 2));
      return status.bound && status.credentialConfigured ? 0 : 1;
    }

    if (command === "doctor") {
      const diagnosis = await dependencies.doctor(paths(options));
      for (const check of diagnosis.checks) {
        io.stdout(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
      }
      return diagnosis.ok ? 0 : 1;
    }

    if (command === "unbind") {
      const result = await dependencies.unbind({
        ...paths(options),
        forgetCredential: options.flags.has("forget-credential"),
      });
      io.stdout(result.removed ? "Codex project binding removed." : "Codex project was not bound.");
      if (result.credentialRemoved) io.stdout("User credential removed from the protected store.");
      return 0;
    }

    throw new CliUsageError(`Unknown command '${command}'`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(redactCliError(message, env, options));
    return error instanceof CliUsageError ? 2 : 1;
  }
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isMain) {
  runCodexBindingCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

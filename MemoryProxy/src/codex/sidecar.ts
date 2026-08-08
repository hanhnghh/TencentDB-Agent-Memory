import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";

import { buildConfig } from "../config.js";
import type { ProxyConfig } from "../types.js";
import { startRuntime } from "../runtime/startup.js";
import {
  assertProtectedStateOutsideProject,
  resolveCodexInstallationPaths,
} from "./installation.js";

export interface CodexSidecarRuntime {
  stop(): Promise<void>;
}

export interface InstalledCodexSidecarRuntime extends CodexSidecarRuntime {
  waitUntilStopped(): Promise<void>;
}

export interface StartInstalledCodexSidecarInput {
  configFile?: string;
  projectDir?: string;
  userConfigDir?: string;
  env?: NodeJS.ProcessEnv;
  start?: (config: ProxyConfig) => Promise<CodexSidecarRuntime>;
}

/** Start hooks-only runtime with every writable SQLite artifact in protected user state. */
export async function startInstalledCodexSidecar(
  input: StartInstalledCodexSidecarInput = {},
): Promise<InstalledCodexSidecarRuntime> {
  const paths = resolveCodexInstallationPaths(input.userConfigDir);
  await assertProtectedStateOutsideProject(input.projectDir ?? process.cwd(), paths.rootDir);
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await chmod(paths.dataDir, 0o700);
  const dbPath = join(paths.dataDir, "proxy.db");
  const env = input.env ?? process.env;
  env.PROXY_DB_PATH = dbPath;
  env.PROXY_OUTBOX_PATH = dbPath;

  const loadedConfig = buildConfig({
    ...(input.configFile ? { configFile: input.configFile } : {}),
    runtimeMode: "hooks",
  });
  const serviceToken = env.MEMORY_CORE_SERVICE_TOKEN?.trim();
  const config: ProxyConfig = {
    ...loadedConfig,
    storage: {
      ...loadedConfig.storage,
      sqlite: { dbPath },
    },
    coreSkill: {
      ...loadedConfig.coreSkill,
      ...(serviceToken ? { serviceToken } : {}),
    },
    knowledge: {
      ...loadedConfig.knowledge,
      ...(serviceToken ? { serviceToken } : {}),
    },
  };
  const runtime = await (input.start ?? startRuntime)(config);
  const token = randomUUID();
  let stopSidecar: () => Promise<void>;
  const controlServer = createServer((socket) => {
    socket.setEncoding("utf8");
    let request = "";
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (request.length > 512) socket.destroy();
    });
    socket.once("end", () => {
      if (request.trim() !== token) {
        socket.end("DENIED\n");
        return;
      }
      socket.end("ACCEPTED\n");
      void stopSidecar().catch(() => undefined);
    });
  });
  try {
    const controlAddress = await listenOnLoopback(controlServer);
    const lease = {
      pid: process.pid,
      token,
      controlHost: "127.0.0.1",
      controlPort: controlAddress.port,
    };
    const handle = await open(paths.sidecarLeaseFile, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await closeServer(controlServer).catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    throw new Error("Another Agent Memory sidecar is already registered", { cause: error });
  }
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let resolveStopped: () => void = () => undefined;
  const stoppedSignal = new Promise<void>((resolve) => { resolveStopped = resolve; });
  stopSidecar = async (): Promise<void> => {
    if (stopped) return;
    if (stopping) return stopping;
    stopping = (async () => {
      await runtime.stop();
      await closeServer(controlServer);
      await removeOwnedLease(paths.sidecarLeaseFile, token);
      stopped = true;
      resolveStopped();
    })();
    try {
      await stopping;
    } catch (error) {
      stopping = null;
      throw error;
    }
  };
  return {
    stop: stopSidecar,
    waitUntilStopped: () => stoppedSignal,
  };
}

/** Keep the sidecar alive until SIGINT/SIGTERM, then drain durable work. */
export async function runInstalledCodexSidecar(
  input: StartInstalledCodexSidecarInput = {},
): Promise<void> {
  const runtime = await startInstalledCodexSidecar(input);
  await new Promise<void>((resolveDone, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      runtime.stop().then(resolveDone, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    runtime.waitUntilStopped().then(resolveDone, reject);
  });
}

async function listenOnLoopback(server: Server): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("Sidecar control listener has no TCP address"));
        return;
      }
      resolveListen(address);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function removeOwnedLease(path: string, token: string): Promise<void> {
  try {
    const current: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof current === "object" &&
      current !== null &&
      "token" in current &&
      current.token === token
    ) {
      await unlink(path);
    }
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

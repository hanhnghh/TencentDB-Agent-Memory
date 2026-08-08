import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface ProcessLockOwner {
  pid: number;
  token: string;
}

export interface ProcessLockOptions {
  lockDir: string;
  retryMs: number;
  timeoutMs: number;
  malformedStaleMs: number;
  busyError(): Error;
}

/**
 * Serialize cross-process mutations with an atomic directory claim.
 *
 * A stale generation is renamed to a deterministic, non-empty quarantine
 * directory. Concurrent stale observers therefore cannot move a newly-created
 * live lock: their rename destination already exists and directory replacement
 * fails atomically.
 */
export async function withProcessLock<T>(
  options: ProcessLockOptions,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(options.lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + options.timeoutMs;
  const owner: ProcessLockOwner = { pid: process.pid, token: randomUUID() };
  const ownerFile = join(options.lockDir, "owner.json");

  while (true) {
    try {
      await mkdir(options.lockDir, { mode: 0o700 });
      try {
        await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await rmdir(options.lockDir).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const stale = await inspectStaleLock(options.lockDir, options.malformedStaleMs);
      if (stale) {
        const quarantine = `${options.lockDir}.stale.${stale.generation}`;
        try {
          await rename(options.lockDir, quarantine);
          continue;
        } catch (renameError) {
          if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(errorCode(renameError) ?? "")) {
            throw renameError;
          }
        }
      }
      if (Date.now() >= deadline) throw options.busyError();
      await delay(options.retryMs);
    }
  }

  try {
    return await action();
  } finally {
    try {
      const current: unknown = JSON.parse(await readFile(ownerFile, "utf8"));
      if (isRecord(current) && current.token === owner.token) {
        await unlink(ownerFile);
        await rmdir(options.lockDir);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function inspectStaleLock(
  lockDir: string,
  malformedStaleMs: number,
): Promise<{ generation: string } | null> {
  try {
    const ownerFile = join(lockDir, "owner.json");
    const [text, lockStat] = await Promise.all([readFile(ownerFile, "utf8"), stat(lockDir)]);
    const value: unknown = JSON.parse(text);
    if (
      isRecord(value) &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.token === "string" &&
      value.token.length > 0
    ) {
      return processIsRunning(Number(value.pid)) ? null : { generation: value.token };
    }
    return Date.now() - lockStat.mtimeMs >= malformedStaleMs
      ? { generation: `${lockStat.dev}-${lockStat.ino}` }
      : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      const lockStat = await stat(lockDir).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs >= malformedStaleMs) {
        return { generation: `${lockStat.dev}-${lockStat.ino}` };
      }
      return null;
    }
    return null;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type LockPayload = { pid: number; createdAt: string };

export type LockOptions = {
  staleMs?: number;
  timeoutMs?: number;
  sleepMs?: number;
  sleepSync?: (ms: number) => void;
};

function positive(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function storeLockStaleMs(): number {
  return positive(process.env.CONTENT_STORE_LOCK_STALE_MS, 30_000, 1_000);
}

export function storeLockTimeoutMs(): number {
  return positive(process.env.CONTENT_STORE_LOCK_TIMEOUT_MS, 15_000, 0);
}

function sleepSyncDefault(ms: number): void {
  if (ms <= 0) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPayload(lockPath: string): LockPayload | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") return null;
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A lock is stale when its holder is gone or it is older than staleMs. */
export function lockIsStale(lockPath: string, staleMs: number): boolean {
  const age = lockAgeMs(lockPath);
  if (!Number.isFinite(age)) return true;
  const payload = readPayload(lockPath);
  if (!payload) return age >= staleMs;
  if (!pidAlive(payload.pid)) return true;
  return age >= staleMs;
}

/**
 * Exclusive cross-process lock. Create is atomic (`wx`). The critical section must be
 * synchronous: waiters block the thread, so the holder must not await while holding it.
 * Release only removes the lock this call created (a stale takeover is left alone).
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  const staleMs = opts.staleMs ?? storeLockStaleMs();
  const timeoutMs = opts.timeoutMs ?? storeLockTimeoutMs();
  const sleepMs = opts.sleepMs ?? 20;
  const sleepSync = opts.sleepSync ?? sleepSyncDefault;
  mkdirSync(dirname(lockPath), { recursive: true });

  const createdAt = `${new Date().toISOString()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, createdAt } satisfies LockPayload));
      closeSync(fd);
      fd = undefined;
      break;
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (lockIsStale(lockPath, staleMs)) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* another waiter took it */
        }
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`store_lock_timeout: ${lockPath}`);
      }
      sleepSync(sleepMs);
    }
  }

  try {
    return fn();
  } finally {
    const current = readPayload(lockPath);
    if (current && current.pid === process.pid && current.createdAt === createdAt) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already released */
      }
    }
  }
}

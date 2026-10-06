import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

let cachedOwner: string | undefined;

/** Stable id for this process. Claims record it so a different process cannot finish the job. */
export function schedulerOwner(): string {
  const fromEnv = process.env.CONTENT_SCHEDULER_OWNER?.trim();
  if (fromEnv) return fromEnv;
  if (!cachedOwner) cachedOwner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  return cachedOwner;
}

/** How long a claimed job may stay in `publishing` before it is left as needs_review. */
export function publishLeaseMs(): number {
  const n = Number(process.env.CONTENT_PUBLISH_LEASE_MS ?? 600_000);
  return Number.isFinite(n) && n >= 5_000 ? n : 600_000;
}

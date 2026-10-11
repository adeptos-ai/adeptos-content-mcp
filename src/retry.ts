import { MetaApiError } from "./meta-client.js";

const TRANSIENT_MESSAGE =
  /timed out|timeout|temporar|rate limit|too many calls|request limit|econnreset|etimedout|socket hang up|fetch failed|network|eai_again/i;

const NOT_READY_MESSAGE = /media id is not available|not ready (for|to be) publish|media is not ready/i;

/** Graph/network failures worth another attempt. Validation and container ERROR/EXPIRED are not. */
export function isTransientPublishError(err: unknown): boolean {
  // Errors from the media_publish stage were already retried there (with a double-post check).
  // Rebuilding containers and publishing again could post twice, so never retry them here.
  if (err && typeof err === "object" && (err as { noRebuild?: boolean }).noRebuild === true) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (NOT_READY_MESSAGE.test(message)) return true;
  if (TRANSIENT_MESSAGE.test(message)) return true;
  if (err instanceof MetaApiError) {
    const e = (err.body as { error?: { code?: number; error_subcode?: number } } | null)?.error;
    // 9007 / 2207027: "Media ID is not available" — the container is not ready yet.
    if (e?.code === 9007 || e?.error_subcode === 2207027) return true;
    if (err.status === 0 || err.status === 408 || err.status === 429) return true;
    if (err.status >= 500 && err.status <= 599) return true;
  }
  return false;
}

export function retryDelayMs(attempt: number, baseDelayMs: number): number {
  if (baseDelayMs <= 0 || attempt <= 1) return 0;
  return baseDelayMs * 2 ** (attempt - 2);
}

/**
 * Run `run` up to maxAttempts times. Backoff applies before attempts 2..N.
 * `onAttempt` fires after every try (error set when that try failed).
 */
export async function withTransientRetries<T>(opts: {
  maxAttempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  onAttempt?: (attempt: number, error?: string) => void;
  run: () => Promise<T>;
}): Promise<T> {
  const max = Math.max(1, opts.maxAttempts);
  let last: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    const delay = retryDelayMs(attempt, opts.baseDelayMs);
    if (delay > 0) await opts.sleep(delay);
    try {
      const value = await opts.run();
      opts.onAttempt?.(attempt);
      return value;
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      opts.onAttempt?.(attempt, message);
      if (attempt >= max || !isTransientPublishError(err)) throw err;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

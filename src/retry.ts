import { MetaApiError } from "./meta-client.js";

const TRANSIENT_MESSAGE =
  /timed out|timeout|temporar|rate limit|too many calls|request limit|econnreset|etimedout|socket hang up|fetch failed|network|eai_again/i;

/** Graph/network failures worth another attempt. Validation and container ERROR/EXPIRED are not. */
export function isTransientPublishError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (TRANSIENT_MESSAGE.test(message)) return true;
  if (err instanceof MetaApiError) {
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

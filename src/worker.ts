import { processDueJobs, type ServiceDeps } from "./content-service.js";
import { logInfo } from "./safety.js";

let timer: ReturnType<typeof setInterval> | undefined;
let lastTickAt: number | undefined;

/**
 * Late-tick detector. setInterval cannot fire while the process or the box is paused
 * (VM idle suspend, SIGSTOP), so a due job is picked up only on resume. Returns the gap in ms
 * when the time since the previous tick is over 3 intervals, else undefined.
 */
export function lateTickGapMs(prevMs: number | undefined, nowMs: number, intervalMs: number): number | undefined {
  if (prevMs === undefined) return undefined;
  const gap = nowMs - prevMs;
  return gap > intervalMs * 3 ? gap : undefined;
}

/**
 * The due-job poller runs only in the process that opts in.
 * Every other MCP copy (stdio agents sharing schedules.json) may enqueue, cancel, and list.
 * CONTENT_DISABLE_WORKER=1 still wins, including over CONTENT_SCHEDULER_ENABLED=1.
 */
export function workerEnabled(): boolean {
  if (process.env.CONTENT_DISABLE_WORKER === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  return process.env.CONTENT_SCHEDULER_ENABLED === "1";
}

export function scheduleWorkerActive(): boolean {
  return timer !== undefined;
}

export function workerIntervalMs(): number {
  const n = Number(process.env.CONTENT_WORKER_INTERVAL_MS ?? 30_000);
  return Number.isFinite(n) && n >= 5_000 ? n : 30_000;
}

export function startScheduleWorker(deps: ServiceDeps = {}): void {
  if (!workerEnabled() || timer) return;
  const interval = workerIntervalMs();
  logInfo("worker", `mcp_cron scheduler enabled; polling every ${interval}ms`);
  lastTickAt = Date.now();
  timer = setInterval(() => {
    const nowMs = Date.now();
    const gap = lateTickGapMs(lastTickAt, nowMs, interval);
    lastTickAt = nowMs;
    if (gap !== undefined) {
      logInfo("worker", `late tick: ${Math.round(gap / 1000)}s since the previous poll (process paused or box suspended?)`, {
        previous: new Date(nowMs - gap).toISOString(),
        now: new Date(nowMs).toISOString(),
      });
    }
    void processDueJobs(deps).catch((err) => {
      logInfo("worker", "tick failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }, interval);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

export function stopScheduleWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
    lastTickAt = undefined;
  }
}

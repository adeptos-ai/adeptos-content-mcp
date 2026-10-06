import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLockSync } from "./file-lock.js";
import type { BrandKey, MediaRecord, ScheduleJob, ScheduleStatus } from "./types.js";

export function defaultDataDir(): string {
  return process.env.CONTENT_DATA_DIR?.trim() || join(process.cwd(), "data");
}

export function storeLockPath(dataFile: string): string {
  return join(dirname(dataFile), "store.lock");
}

export class StoreParseError extends Error {
  constructor(
    public readonly file: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`store_parse_error: ${file}: ${detail}`);
    this.name = "StoreParseError";
  }
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") {
    throw new StoreParseError(file, new Error("file is empty"));
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    // Never substitute [] for a file that exists but will not parse. The next save would wipe it.
    throw new StoreParseError(file, err);
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export class MediaRegistry {
  constructor(private readonly file: string) {}

  static create(dir = defaultDataDir()): MediaRegistry {
    return new MediaRegistry(join(dir, "media.json"));
  }

  private locked<T>(fn: () => T): T {
    return withFileLockSync(storeLockPath(this.file), fn);
  }

  private all(): MediaRecord[] {
    const raw = readJson<{ items?: MediaRecord[] }>(this.file, { items: [] });
    return raw.items ?? [];
  }

  private save(items: MediaRecord[]): void {
    writeJson(this.file, { items });
  }

  put(record: MediaRecord): MediaRecord {
    return this.locked(() => {
      const items = this.all().filter((m) => m.media_id !== record.media_id);
      items.push(record);
      this.save(items);
      return record;
    });
  }

  get(mediaId: string): MediaRecord | undefined {
    return this.all().find((m) => m.media_id === mediaId);
  }

  listByBrand(brand?: BrandKey): MediaRecord[] {
    const items = this.all();
    return brand ? items.filter((m) => m.brand === brand) : items;
  }
}

export type FinishPublishPatch = {
  status: "published" | "failed";
  post_id?: string;
  published_at?: string;
  error?: string;
  attempts?: number;
};

export class ScheduleStore {
  constructor(private readonly file: string) {}

  static create(dir = defaultDataDir()): ScheduleStore {
    return new ScheduleStore(join(dir, "schedules.json"));
  }

  /** Path of the JSON file. Tests use this to corrupt it on purpose. */
  filePath(): string {
    return this.file;
  }

  private locked<T>(fn: () => T): T {
    return withFileLockSync(storeLockPath(this.file), fn);
  }

  private all(): ScheduleJob[] {
    const raw = readJson<{ jobs?: ScheduleJob[] }>(this.file, { jobs: [] });
    return raw.jobs ?? [];
  }

  private save(jobs: ScheduleJob[]): void {
    writeJson(this.file, { jobs });
  }

  insert(job: ScheduleJob): ScheduleJob {
    return this.locked(() => {
      const jobs = this.all();
      jobs.push(job);
      this.save(jobs);
      return job;
    });
  }

  get(id: string): ScheduleJob | undefined {
    return this.all().find((j) => j.id === id);
  }

  update(id: string, patch: Partial<ScheduleJob>): ScheduleJob {
    return this.locked(() => {
      const jobs = this.all();
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx < 0) throw new Error(`schedule_not_found: ${id}`);
      const next = { ...jobs[idx], ...patch, updated_at: new Date().toISOString() };
      jobs[idx] = next;
      this.save(jobs);
      return next;
    });
  }

  list(opts: { brand?: BrandKey; status?: ScheduleStatus | ScheduleStatus[] } = {}): ScheduleJob[] {
    let jobs = this.all();
    if (opts.brand) jobs = jobs.filter((j) => j.brand === opts.brand);
    if (opts.status) {
      const set = new Set(Array.isArray(opts.status) ? opts.status : [opts.status]);
      jobs = jobs.filter((j) => set.has(j.status));
    }
    return jobs.sort((a, b) => a.publish_at_utc.localeCompare(b.publish_at_utc));
  }

  due(now = new Date()): ScheduleJob[] {
    const ts = now.toISOString();
    return this.list({ status: "scheduled" }).filter((j) => j.path === "mcp_cron" && j.publish_at_utc <= ts);
  }

  /**
   * Publishing jobs whose lease has elapsed (or that have no lease) become needs_review.
   * They are not put back to scheduled, so a crashed publisher is not retried automatically.
   */
  expireLeases(now = new Date()): ScheduleJob[] {
    return this.locked(() => {
      const jobs = this.all();
      const ts = now.toISOString();
      const moved: ScheduleJob[] = [];
      let dirty = false;
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (job.status !== "publishing") continue;
        if (job.lease_until && job.lease_until > ts) continue;
        const next: ScheduleJob = {
          ...job,
          status: "needs_review",
          error:
            job.error ||
            "lease_expired: publishing lease elapsed before the post id was saved. Not auto-retried.",
          updated_at: ts,
        };
        jobs[i] = next;
        moved.push(next);
        dirty = true;
      }
      if (dirty) this.save(jobs);
      return moved;
    });
  }

  /**
   * Atomically move the earliest due mcp_cron job from scheduled → publishing.
   * Returns null when nothing is due. Only one caller wins each job.
   */
  claimDue(now: Date, owner: string, leaseMs: number): ScheduleJob | null {
    return this.locked(() => {
      const jobs = this.all();
      const ts = now.toISOString();
      let best = -1;
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (job.status !== "scheduled" || job.path !== "mcp_cron") continue;
        if (job.publish_at_utc > ts) continue;
        if (best < 0 || job.publish_at_utc < jobs[best].publish_at_utc) best = i;
      }
      if (best < 0) return null;
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const next: ScheduleJob = {
        ...jobs[best],
        status: "publishing",
        owner,
        lease_until: leaseUntil,
        updated_at: ts,
      };
      jobs[best] = next;
      this.save(jobs);
      return next;
    });
  }

  /** Bookkeeping while this owner still holds the claim. No-op if the job was cancelled or stolen. */
  recordAttempt(id: string, owner: string, attempt: number, error?: string): void {
    this.locked(() => {
      const jobs = this.all();
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx < 0) return;
      const cur = jobs[idx];
      if (cur.owner !== owner) return;
      if (cur.status !== "publishing" && cur.status !== "needs_review") return;
      jobs[idx] = { ...cur, attempts: attempt, error, updated_at: new Date().toISOString() };
      this.save(jobs);
    });
  }

  /**
   * Save the outcome only if this owner still holds the job.
   * A cancel wins: status stays cancelled, and a post id is still recorded when we have one.
   * needs_review is the same in-flight owner finishing, not a second worker retrying.
   */
  finishPublish(id: string, owner: string, patch: FinishPublishPatch): ScheduleJob | null {
    return this.locked(() => {
      const jobs = this.all();
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx < 0) return null;
      const cur = jobs[idx];
      if (cur.owner !== owner) return null;
      const updated_at = new Date().toISOString();
      if (cur.status === "cancelled") {
        const next: ScheduleJob = {
          ...cur,
          post_id: patch.post_id ?? cur.post_id,
          error: cur.error || (patch.post_id ? "published_after_cancel" : cur.error),
          updated_at,
        };
        jobs[idx] = next;
        this.save(jobs);
        return next;
      }
      if (cur.status !== "publishing" && cur.status !== "needs_review") return null;
      const next: ScheduleJob = { ...cur, ...patch, updated_at };
      jobs[idx] = next;
      this.save(jobs);
      return next;
    });
  }
}

export function newScheduleId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `sch_${Date.now()}_${rand}`;
}

export function newMediaId(brand: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `med_${brand}_${Date.now().toString(36)}_${rand}`;
}

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrandKey, MediaRecord, ScheduleJob, ScheduleStatus } from "./types.js";

export function defaultDataDir(): string {
  return process.env.CONTENT_DATA_DIR?.trim() || join(process.cwd(), "data");
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export class MediaRegistry {
  constructor(private readonly file: string) {}

  static create(dir = defaultDataDir()): MediaRegistry {
    return new MediaRegistry(join(dir, "media.json"));
  }

  private all(): MediaRecord[] {
    const raw = readJson<{ items?: MediaRecord[] }>(this.file, { items: [] });
    return raw.items ?? [];
  }

  private save(items: MediaRecord[]): void {
    writeJson(this.file, { items });
  }

  put(record: MediaRecord): MediaRecord {
    const items = this.all().filter((m) => m.media_id !== record.media_id);
    items.push(record);
    this.save(items);
    return record;
  }

  get(mediaId: string): MediaRecord | undefined {
    return this.all().find((m) => m.media_id === mediaId);
  }

  listByBrand(brand?: BrandKey): MediaRecord[] {
    const items = this.all();
    return brand ? items.filter((m) => m.brand === brand) : items;
  }
}

export class ScheduleStore {
  constructor(private readonly file: string) {}

  static create(dir = defaultDataDir()): ScheduleStore {
    return new ScheduleStore(join(dir, "schedules.json"));
  }

  private all(): ScheduleJob[] {
    const raw = readJson<{ jobs?: ScheduleJob[] }>(this.file, { jobs: [] });
    return raw.jobs ?? [];
  }

  private save(jobs: ScheduleJob[]): void {
    writeJson(this.file, { jobs });
  }

  insert(job: ScheduleJob): ScheduleJob {
    const jobs = this.all();
    jobs.push(job);
    this.save(jobs);
    return job;
  }

  get(id: string): ScheduleJob | undefined {
    return this.all().find((j) => j.id === id);
  }

  update(id: string, patch: Partial<ScheduleJob>): ScheduleJob {
    const jobs = this.all();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx < 0) throw new Error(`schedule_not_found: ${id}`);
    const next = { ...jobs[idx], ...patch, updated_at: new Date().toISOString() };
    jobs[idx] = next;
    this.save(jobs);
    return next;
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
    return this.list({ status: "scheduled" }).filter((j) => j.publish_at_utc <= ts);
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

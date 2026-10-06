import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processDueJobs, type ServiceDeps } from "../src/content-service.js";
import { ScheduleStore, storeLockPath } from "../src/store.js";
import type { ScheduleJob } from "../src/types.js";

let dataDir: string;

function job(id: string, patch: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id,
    brand: "hamill",
    platform: "meta_ig",
    status: "scheduled",
    path: "mcp_cron",
    publish_at_utc: "2020-01-01T00:00:00.000Z",
    publish_at_bogota: "2019-12-31T19:00:00-05:00",
    also_post_fb: false,
    media: [{ media_type: "photo", url: "https://cdn.example/a.jpg" }],
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
    confirm: true,
    ...patch,
  };
}

function runWorker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const worker = join(dirname(fileURLToPath(import.meta.url)), "helpers/race-worker.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, ...args], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf) => {
      stdout += String(buf);
    });
    child.stderr.on("data", (buf) => {
      stderr += String(buf);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe("schedule store lock and claim", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "content-store-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("throws on a parse error and does not replace the file", () => {
    const store = ScheduleStore.create(dataDir);
    const file = store.filePath();
    writeFileSync(file, "{not-json");
    const before = readFileSync(file, "utf8");
    assert.throws(() => store.list(), /store_parse_error/);
    assert.throws(() => store.get("sch_x"), /store_parse_error/);
    assert.throws(() => store.insert(job("sch_should_not_write")), /store_parse_error/);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(existsSync(storeLockPath(file)), false);
  });

  it("treats a missing file as an empty queue", () => {
    const store = ScheduleStore.create(dataDir);
    assert.deepEqual(store.list(), []);
    store.insert(job("sch_new"));
    assert.equal(store.list().length, 1);
  });

  it("acquires a stale lock left by a dead pid", () => {
    const store = ScheduleStore.create(dataDir);
    const lock = storeLockPath(store.filePath());
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 2_147_000_001, createdAt: "2000-01-01T00:00:00.000Z" }));
    store.insert(job("sch_after_stale"));
    assert.equal(existsSync(lock), false);
    assert.equal(store.get("sch_after_stale")?.id, "sch_after_stale");
  });

  it("moves an expired publishing lease to needs_review and does not claim it", () => {
    const store = ScheduleStore.create(dataDir);
    store.insert(
      job("sch_stuck", {
        status: "publishing",
        owner: "dead-process",
        lease_until: "2000-01-01T00:00:00.000Z",
      }),
    );
    store.insert(job("sch_future", { publish_at_utc: "2099-01-01T00:00:00.000Z", path: "graph_native", platform: "meta_fb" }));
    const moved = store.expireLeases(new Date("2026-10-06T12:00:00.000Z"));
    assert.equal(moved.length, 1);
    assert.equal(moved[0]?.status, "needs_review");
    assert.match(moved[0]?.error ?? "", /not auto-retried/i);
    assert.equal(store.claimDue(new Date("2026-10-06T12:00:00.000Z"), "other", 60_000), null);
    assert.equal(store.get("sch_stuck")?.status, "needs_review");
  });

  it("claims one scheduled job at a time and will not finish another owner's job", () => {
    const store = ScheduleStore.create(dataDir);
    const now = new Date("2026-10-06T12:00:00.000Z");
    store.insert(job("sch_a"));
    store.insert(job("sch_b"));
    const first = store.claimDue(now, "owner-a", 60_000);
    const second = store.claimDue(now, "owner-b", 60_000);
    assert.ok(first && second);
    assert.notEqual(first!.id, second!.id);
    assert.equal(first!.status, "publishing");
    assert.equal(first!.owner, "owner-a");
    assert.ok(first!.lease_until);
    assert.equal(store.claimDue(now, "owner-c", 60_000), null);
    assert.equal(
      store.finishPublish(first!.id, "owner-b", {
        status: "published",
        post_id: "stolen",
        published_at: now.toISOString(),
      }),
      null,
    );
    assert.equal(store.get(first!.id)?.status, "publishing");
    assert.equal(store.get(first!.id)?.post_id, undefined);
  });

  it("keeps a cancelled job cancelled when publish later learns the post id", () => {
    const store = ScheduleStore.create(dataDir);
    store.insert(job("sch_cancel"));
    const claimed = store.claimDue(new Date(), "owner-a", 60_000);
    assert.ok(claimed);
    store.update(claimed!.id, { status: "cancelled" });
    const saved = store.finishPublish(claimed!.id, "owner-a", {
      status: "published",
      post_id: "ig_after_cancel",
      published_at: new Date().toISOString(),
    });
    assert.equal(saved?.status, "cancelled");
    assert.equal(saved?.post_id, "ig_after_cancel");
  });

  it("skips a job cancelled after claim and before the network call", async () => {
    const store = ScheduleStore.create(dataDir);
    store.insert(job("sch_skip"));
    let calls = 0;
    const deps: ServiceDeps = {
      schedules: store,
      owner: "worker-1",
      leaseMs: 60_000,
      beforePublish: (claimed) => {
        store.update(claimed.id, { status: "cancelled" });
      },
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 500 });
      },
    };
    const out = await processDueJobs(deps, new Date("2026-10-06T12:00:00.000Z"));
    assert.equal(calls, 0);
    assert.equal(out.results[0]?.status, "cancelled");
    assert.equal(store.get("sch_skip")?.status, "cancelled");
  });

  it("two processes publish each due job once and do not drop inserts", async () => {
    const store = ScheduleStore.create(dataDir);
    for (let i = 0; i < 20; i++) store.insert(job(`sch_due_${i}`));

    const [a, b] = await Promise.all([
      runWorker([dataDir, "proc-a", "claim"]),
      runWorker([dataDir, "proc-b", "claim"]),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const publishedA = (JSON.parse(a.stdout) as { published: string[] }).published;
    const publishedB = (JSON.parse(b.stdout) as { published: string[] }).published;
    const all = [...publishedA, ...publishedB].sort();
    assert.equal(new Set(all).size, 20);
    assert.equal(all.length, 20);
    const jobs = store.list();
    assert.equal(jobs.length, 20);
    for (const saved of jobs) {
      assert.equal(saved.status, "published");
      assert.equal(saved.post_id, `post_${saved.id}`);
    }

    const insertDir = mkdtempSync(join(tmpdir(), "content-insert-"));
    try {
      const [left, right] = await Promise.all([
        runWorker([insertDir, "left", "insert", "12"]),
        runWorker([insertDir, "right", "insert", "12"]),
      ]);
      assert.equal(left.code, 0, left.stderr);
      assert.equal(right.code, 0, right.stderr);
      const ids = [
        ...(JSON.parse(left.stdout) as { ids: string[] }).ids,
        ...(JSON.parse(right.stdout) as { ids: string[] }).ids,
      ];
      const inserted = ScheduleStore.create(insertDir).list();
      assert.equal(inserted.length, 24);
      assert.deepEqual(inserted.map((row) => row.id).sort(), [...ids].sort());
    } finally {
      rmSync(insertDir, { recursive: true, force: true });
    }
  });
});

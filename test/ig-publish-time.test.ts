import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processDueJobs, schedulePost, type ServiceDeps } from "../src/content-service.js";
import { MetaClient } from "../src/meta-client.js";
import { MediaRegistry, ScheduleStore } from "../src/store.js";
import type { ScheduleJob } from "../src/types.js";

let dataDir: string;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function baseJob(patch: Partial<ScheduleJob>): ScheduleJob {
  return {
    id: "sch_old",
    brand: "hamill",
    platform: "meta_ig",
    status: "scheduled",
    path: "mcp_cron",
    publish_at_utc: "2020-01-01T00:00:00.000Z",
    publish_at_bogota: "2019-12-31T19:00:00-05:00",
    also_post_fb: false,
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
    confirm: true,
    ...patch,
  };
}

describe("Instagram containers are created at publish time", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ig-publish-"));
    process.env.META_ACCESS_TOKEN = "EAABTESTTOKEN";
    process.env.BRAND_HAMILL_IG_USER_ID = "1784140001";
    process.env.BRAND_HAMILL_PAGE_ID = "111";
    process.env.CONTENT_DISABLE_WORKER = "1";
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.BRAND_HAMILL_IG_USER_ID;
    delete process.env.BRAND_HAMILL_PAGE_ID;
  });

  function deps(fetchImpl: typeof fetch, extra: Partial<ServiceDeps> = {}): ServiceDeps {
    return {
      client: new MetaClient({ accessToken: "EAABTESTTOKEN", fetchImpl }),
      fetchImpl,
      media: MediaRegistry.create(dataDir),
      schedules: ScheduleStore.create(dataDir),
      igRetryBaseMs: 0,
      igWaitIntervalMs: 0,
      igWaitTimeoutMs: 5_000,
      sleep: async () => {},
      ...extra,
    };
  }

  it("rebuilds an expired stored container id instead of reusing it", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, body });
      if (url.includes("media_publish")) return json({ id: "ig_post_rebuilt" });
      if (url.includes("/media")) return json({ id: "fresh_container" });
      return json({ id: "fresh_container", status_code: "FINISHED" });
    };
    const d = deps(fetchImpl);
    d.schedules!.insert(
      baseJob({
        container_id: "OLD_EXPIRED_CONTAINER",
        caption: "later",
        media: [{ media_type: "photo", url: "https://cdn.example/a.jpg" }],
      }),
    );
    const out = await processDueJobs(d, new Date("2026-10-06T12:00:00.000Z"));
    assert.equal(out.results[0]?.status, "published");
    assert.equal((out.results[0] as { post_id?: string }).post_id, "ig_post_rebuilt");
    const publish = calls.find((c) => c.url.includes("media_publish"));
    assert.ok(publish);
    assert.match(decodeURIComponent(publish!.body), /creation_id=fresh_container/);
    assert.ok(calls.every((c) => !c.url.includes("OLD_EXPIRED_CONTAINER") && !c.body.includes("OLD_EXPIRED_CONTAINER")));
    const saved = d.schedules!.get("sch_old");
    assert.equal(saved?.status, "published");
    assert.equal(saved?.post_id, "ig_post_rebuilt");
  });

  it("creates carousel children, waits until FINISHED, then the parent with collaborators", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ method, url, body });
      if (url.includes("media_publish")) return json({ id: "ig_carousel_post" });
      if (method === "POST" && body.includes("media_type=CAROUSEL")) return json({ id: "parent_1" });
      if (method === "POST" && url.includes("/media")) {
        n += 1;
        return json({ id: `child_${n}` });
      }
      const id = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "x";
      return json({ id, status_code: "FINISHED" });
    };
    const d = deps(fetchImpl);
    d.schedules!.insert(
      baseJob({
        id: "sch_carousel",
        container_id: "OLD_PARENT",
        caption: "slides",
        collaborators: ["zono"],
        media: [
          { media_type: "photo", url: "https://cdn.example/1.jpg" },
          { media_type: "photo", url: "https://cdn.example/2.jpg" },
          { media_type: "photo", url: "https://cdn.example/3.jpg" },
        ],
      }),
    );
    const out = await processDueJobs(d, new Date("2026-10-06T12:00:00.000Z"));
    assert.equal((out.results[0] as { post_id?: string }).post_id, "ig_carousel_post");

    const posts = calls.filter((c) => c.method === "POST");
    const children = posts.filter((c) => c.body.includes("is_carousel_item=true"));
    assert.equal(children.length, 3);
    for (const child of children) {
      assert.equal(child.body.includes("collaborators"), false);
      assert.equal(child.body.includes("caption"), false);
    }
    const parent = posts.find((c) => c.body.includes("media_type=CAROUSEL"));
    assert.ok(parent);
    const parentBody = decodeURIComponent(parent!.body);
    assert.match(parentBody, /child_1/);
    assert.match(parentBody, /child_2/);
    assert.match(parentBody, /child_3/);
    assert.match(parentBody, /zono/);
    const publish = posts.find((c) => c.url.includes("media_publish"));
    assert.match(decodeURIComponent(publish?.body ?? ""), /creation_id=parent_1/);

    const parentIdx = calls.findIndex((c) => c.body.includes("media_type=CAROUSEL"));
    const finishedBeforeParent = calls
      .slice(0, parentIdx)
      .filter((c) => c.method === "GET" && c.url.includes("child_"));
    assert.equal(finishedBeforeParent.length, 3, "each child is polled to FINISHED before the parent is created");
    assert.ok(calls.every((c) => !c.url.includes("OLD_PARENT") && !c.body.includes("OLD_PARENT")));
  });

  it("polls a video container until FINISHED before media_publish", async () => {
    const seen: string[] = [];
    let polls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("media_publish")) {
        seen.push("publish");
        return json({ id: "ig_video_post" });
      }
      if (method === "POST") {
        seen.push("create");
        return json({ id: "vid_1" });
      }
      polls += 1;
      const code = polls === 1 ? "IN_PROGRESS" : "FINISHED";
      seen.push(code);
      return json({ id: "vid_1", status_code: code });
    };
    const d = deps(fetchImpl);
    d.schedules!.insert(
      baseJob({
        id: "sch_video",
        container_id: "EXPIRED_VIDEO",
        media: [{ media_type: "video", url: "https://cdn.example/clip.mp4" }],
      }),
    );
    const out = await processDueJobs(d, new Date("2026-10-06T12:00:00.000Z"));
    assert.equal((out.results[0] as { post_id?: string }).post_id, "ig_video_post");
    assert.deepEqual(seen, ["create", "IN_PROGRESS", "FINISHED", "publish"]);
    assert.equal(polls, 2);
  });

  it("retries transient Graph errors, records attempts, then publishes", async () => {
    let creates = 0;
    const delays: number[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("media_publish")) return json({ id: "ig_post_retry" });
      if (method === "POST" && url.includes("/media")) {
        creates += 1;
        if (creates === 1) return json({ error: { message: "temporarily unavailable" } }, 503);
        return json({ id: "fresh_after_retry" });
      }
      return json({ id: "fresh_after_retry", status_code: "FINISHED" });
    };
    const d = deps(fetchImpl, {
      igMaxAttempts: 3,
      igRetryBaseMs: 25,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    d.schedules!.insert(
      baseJob({
        id: "sch_retry",
        media: [{ media_type: "photo", url: "https://cdn.example/a.jpg" }],
      }),
    );
    const out = await processDueJobs(d, new Date("2026-10-06T12:00:00.000Z"));
    assert.equal((out.results[0] as { post_id?: string }).post_id, "ig_post_retry");
    assert.equal(creates, 2);
    assert.deepEqual(delays, [25]);
    const saved = d.schedules!.get("sch_retry");
    assert.equal(saved?.status, "published");
    assert.equal(saved?.attempts, 2);
    assert.equal(saved?.post_id, "ig_post_retry");
    assert.equal(saved?.error, undefined);
  });

  it("marks the job failed after transient retries are exhausted", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/media")) return json({ error: { message: "service unavailable" } }, 503);
      return json({ id: "x", status_code: "FINISHED" });
    };
    const d = deps(fetchImpl, { igMaxAttempts: 2, igRetryBaseMs: 0 });
    d.schedules!.insert(
      baseJob({
        id: "sch_fail",
        media: [{ media_type: "photo", url: "https://cdn.example/a.jpg" }],
      }),
    );
    const out = await processDueJobs(d, new Date("2026-10-06T12:00:00.000Z"));
    assert.equal(out.results[0]?.status, "failed");
    const saved = d.schedules!.get("sch_fail");
    assert.equal(saved?.status, "failed");
    assert.equal(saved?.attempts, 2);
    assert.match(saved?.error ?? "", /service unavailable/);
    assert.equal(saved?.post_id, undefined);
  });

  it("does not retry a permanent Graph error", async () => {
    let creates = 0;
    const fetchImpl: typeof fetch = async () => {
      creates += 1;
      return json({ error: { message: "Invalid image" } }, 400);
    };
    const d = deps(fetchImpl, { igMaxAttempts: 3, igRetryBaseMs: 0 });
    d.schedules!.insert(
      baseJob({
        id: "sch_perm",
        media: [{ media_type: "photo", url: "https://cdn.example/a.jpg" }],
      }),
    );
    await processDueJobs(d, new Date("2026-10-06T12:00:00.000Z"));
    assert.equal(creates, 1);
    const saved = d.schedules!.get("sch_perm");
    assert.equal(saved?.status, "failed");
    assert.equal(saved?.attempts, 1);
    assert.match(saved?.error ?? "", /Invalid image/);
  });

  it("stores scheduled jobs without a container id", async () => {
    const d = deps(async () => json({}));
    const out = await schedulePost(
      {
        brand: "hamill",
        platforms: ["meta_ig"],
        image_url: "https://cdn.example/later.jpg",
        caption: "booked ahead",
        publish_at: "2026-12-01T09:00:00",
        confirm: true,
        container_id: "SHOULD_NOT_BE_STORED",
      },
      d,
    );
    const id = (out as { results: Array<{ schedule_id?: string }> }).results[0]?.schedule_id;
    assert.ok(id);
    const job = d.schedules!.get(id!);
    assert.equal(job?.container_id, undefined);
    assert.equal(job?.media?.[0]?.url, "https://cdn.example/later.jpg");
    assert.equal(job?.media?.[0]?.media_type, "photo");
    assert.equal(job?.caption, "booked ahead");
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processDueJobs, type ServiceDeps } from "../src/content-service.js";
import { waitForContainer, isIgNotReadyError } from "../src/graph-content.js";
import { MetaApiError, MetaClient } from "../src/meta-client.js";
import { isTransientPublishError } from "../src/retry.js";
import { MediaRegistry, ScheduleStore } from "../src/store.js";
import type { ScheduleJob } from "../src/types.js";

const NOT_READY = {
  error: {
    message: "Media ID is not available",
    type: "OAuthException",
    code: 9007,
    error_subcode: 2207027,
    is_transient: false,
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const idOf = (url: string) => new URL(url).pathname.split("/").filter(Boolean).pop() ?? "x";

function job(patch: Partial<ScheduleJob>): ScheduleJob {
  return {
    id: "sch_t",
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

let dataDir: string;
function deps(fetchImpl: typeof fetch): ServiceDeps {
  return {
    client: new MetaClient({ accessToken: "EAABTESTTOKEN", fetchImpl }),
    fetchImpl,
    media: MediaRegistry.create(dataDir),
    schedules: ScheduleStore.create(dataDir),
    igRetryBaseMs: 0,
    igWaitIntervalMs: 0,
    igWaitTimeoutMs: 5_000,
    sleep: async () => {},
  };
}

describe("waitForContainer", () => {
  it("keeps polling through empty and IN_PROGRESS, returns on FINISHED", async () => {
    const seq = ["", "IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    let i = 0;
    const sleeps: number[] = [];
    const client = new MetaClient({
      accessToken: "EAABTESTTOKEN",
      fetchImpl: async () => json(seq[i] ? { id: "c1", status_code: seq[i++] } : (i++, { id: "c1" })),
    });
    const st = await waitForContainer(client, "c1", {
      intervalMs: 1000,
      maxIntervalMs: 2000,
      sleep: async (ms) => void sleeps.push(ms),
    });
    assert.equal(st.status_code, "FINISHED");
    assert.equal(i, 4);
    assert.deepEqual(sleeps, [1000, 1500, 2000]); // backoff, capped
  });

  it("an empty status never counts as ready (times out instead)", async () => {
    let t = 0;
    const client = new MetaClient({ accessToken: "EAABTESTTOKEN", fetchImpl: async () => json({ id: "c1" }) });
    await assert.rejects(
      waitForContainer(client, "c1", { timeoutMs: 10_000, intervalMs: 3000, now: () => t, sleep: async (ms) => void (t += ms) }),
      /Timed out waiting for IG container c1 \(last status_code=empty\)/,
    );
  });

  it("ERROR fails with the status message", async () => {
    const client = new MetaClient({
      accessToken: "EAABTESTTOKEN",
      fetchImpl: async () => json({ id: "c1", status_code: "ERROR", status: "Error: image could not be fetched" }),
    });
    await assert.rejects(waitForContainer(client, "c1", { sleep: async () => {} }), /status_code=ERROR \(Error: image could not be fetched\)/);
  });
});

describe("not-ready errors are transient", () => {
  it("9007 / 2207027 is retryable", () => {
    const err = new MetaApiError("Media ID is not available", 400, NOT_READY);
    assert.equal(isIgNotReadyError(err), true);
    assert.equal(isTransientPublishError(err), true);
    assert.equal(isTransientPublishError(new MetaApiError("Invalid parameter", 400, { error: { code: 100 } })), false);
  });
});

describe("scheduled carousel publish", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ig-ready-"));
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

  const carousel = (id: string) =>
    job({
      id,
      caption: "slides",
      media: [1, 2, 3].map((n) => ({ media_type: "photo" as const, url: `https://adeptos.ai/content-mcp/x/${n}.jpg` })),
    });

  it("waits for every child and the parent, retries 2207027, and posts exactly once", async () => {
    const polls = new Map<string, number>();
    const order: string[] = [];
    let n = 0;
    let publishCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.includes("media_publish")) {
        publishCalls += 1;
        order.push(`publish#${publishCalls}`);
        return publishCalls === 1 ? json(NOT_READY, 400) : json({ id: "ig_post_ok" });
      }
      if (method === "POST" && body.includes("media_type=CAROUSEL")) return json({ id: "parent_1" });
      if (method === "POST") return json({ id: `child_${++n}` });
      const id = idOf(url);
      const k = (polls.get(id) ?? 0) + 1;
      polls.set(id, k);
      // empty -> IN_PROGRESS -> FINISHED for each container
      const code = k === 1 ? undefined : k === 2 ? "IN_PROGRESS" : "FINISHED";
      if (code === "FINISHED") order.push(`ready:${id}`);
      return json(code ? { id, status_code: code } : { id });
    };
    const d = deps(fetchImpl);
    d.schedules!.insert(carousel("sch_c"));
    const out = await processDueJobs(d, new Date("2026-10-06T12:00:00.000Z"));
    assert.equal(out.results[0]?.status, "published");
    assert.equal(publishCalls, 2);
    for (const id of ["child_1", "child_2", "child_3", "parent_1"]) assert.ok(order.includes(`ready:${id}`), id);
    assert.ok(order.indexOf("ready:parent_1") < order.indexOf("publish#1"));
    assert.equal(n, 3, "containers are not rebuilt on a not-ready retry");
    const saved = d.schedules!.get("sch_c");
    assert.equal(saved?.status, "published");
    assert.equal(saved?.post_id, "ig_post_ok");
  });

  it("an ambiguous publish error with the container PUBLISHED goes to needs_review, never re-posts", async () => {
    let publishCalls = 0;
    let n = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.includes("media_publish")) {
        publishCalls += 1;
        return json({ error: { message: "An unexpected error has occurred", code: 2 } }, 500);
      }
      if (method === "POST" && body.includes("media_type=CAROUSEL")) return json({ id: "parent_1" });
      if (method === "POST") return json({ id: `child_${++n}` });
      const id = idOf(url);
      return json({ id, status_code: id === "parent_1" && publishCalls > 0 ? "PUBLISHED" : "FINISHED" });
    };
    const d = deps(fetchImpl);
    d.schedules!.insert(carousel("sch_amb"));
    const out = await processDueJobs(d, new Date("2026-10-06T12:00:00.000Z"));
    assert.equal(out.results[0]?.status, "needs_review");
    assert.equal(publishCalls, 1);
    assert.equal(n, 3, "no rebuild");
    const saved = d.schedules!.get("sch_amb");
    assert.equal(saved?.status, "needs_review");
    assert.match(saved?.error ?? "", /ig_publish_uncertain/);
  });

  it("gives up after the publish attempt cap and marks the job failed (one build, no rebuild)", async () => {
    let publishCalls = 0;
    let n = 0;
    process.env.CONTENT_IG_MEDIA_PUBLISH_ATTEMPTS = "4";
    try {
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : "";
        if (url.includes("media_publish")) return (publishCalls++, json(NOT_READY, 400));
        if (method === "POST" && body.includes("media_type=CAROUSEL")) return json({ id: "parent_1" });
        if (method === "POST") return json({ id: `child_${++n}` });
        return json({ id: idOf(url), status_code: "FINISHED" });
      };
      const d = deps(fetchImpl);
      d.schedules!.insert(carousel("sch_cap"));
      const out = await processDueJobs(d, new Date("2026-10-06T12:00:00.000Z"));
      assert.equal(out.results[0]?.status, "failed");
      assert.equal(publishCalls, 4);
      assert.equal(n, 3);
    } finally {
      delete process.env.CONTENT_IG_MEDIA_PUBLISH_ATTEMPTS;
    }
  });
});

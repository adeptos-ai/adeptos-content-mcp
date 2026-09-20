import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelScheduled, listAccounts, schedulePost } from "../src/content-service.js";
import { MediaRegistry, ScheduleStore } from "../src/store.js";
import { PLATFORM_LIMITS } from "../src/media-limits.js";
import { normalizePlatforms } from "../src/platforms.js";

let dataDir: string;

function deps() {
  return {
    media: MediaRegistry.create(dataDir),
    schedules: ScheduleStore.create(dataDir),
    client: null,
    waitForReady: false,
    now: () => new Date("2026-09-18T15:00:00Z"),
  };
}

describe("unified schedule gates", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "content-mcp-"));
    process.env.CONTENT_DISABLE_WORKER = "1";
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("dry-runs a multi-platform Canva photo post without confirm", async () => {
    const out = await schedulePost(
      {
        brand: "hamill",
        platforms: ["meta_ig", "meta_fb", "tiktok", "youtube", "linkedin", "x"],
        image_url: "https://cdn.canva.com/export/slide1.png",
        caption: "Canva plantilla — dry run",
        publish_now: true,
      },
      deps(),
    );
    assert.equal("dry_run" in out && out.dry_run, true);
    assert.equal("confirm_required" in out && out.confirm_required, true);
    const plan = (out as { plan: { platforms: string[]; per_platform: Array<{ platform: string; warning?: string }> } })
      .plan;
    assert.deepEqual(plan.platforms, ["meta_ig", "meta_fb", "tiktok", "youtube", "linkedin", "x"]);
    const yt = plan.per_platform.find((p) => p.platform === "youtube");
    assert.match(yt?.warning ?? "", /youtube_community_unsupported/);
  });

  it("cancel without confirm is preview", async () => {
    const out = await cancelScheduled({ id: "sch_missing" }, deps());
    assert.equal("dry_run" in out && out.dry_run, true);
    assert.equal("confirm_required" in out && out.confirm_required, true);
  });

  it("stores mcp_cron TikTok job when confirm:true", async () => {
    process.env.BRAND_HAMILL_TIKTOK_OPEN_ID = "tt_open";
    process.env.BRAND_HAMILL_TIKTOK_ACCESS_TOKEN = "act.fake";
    const d = deps();
    const out = await schedulePost(
      {
        brand: "hamill",
        platforms: ["tiktok"],
        image_url: "https://cdn.canva.com/a.png",
        caption: "ok",
        publish_at: "2026-09-20T09:00:00",
        confirm: true,
      },
      d,
    );
    assert.equal("results" in out, true);
    const results = (out as { results: Array<{ platform: string; status: string; schedule_id?: string }> }).results;
    assert.equal(results[0].platform, "tiktok");
    assert.equal(results[0].status, "scheduled");
    assert.match(results[0].schedule_id ?? "", /^sch_/);
    delete process.env.BRAND_HAMILL_TIKTOK_OPEN_ID;
    delete process.env.BRAND_HAMILL_TIKTOK_ACCESS_TOKEN;
  });

  it("lists accounts with all six Opus Clip destinations and limits", async () => {
    const listed = await listAccounts({}, deps());
    assert.equal(listed.lane, "canva_posts");
    assert.match(listed.note, /Opus Clip = clips/);
    assert.equal(listed.accounts.length, 3);
    const hamill = listed.accounts.find((a) => a.brand === "hamill");
    const names = hamill?.platforms.map((p) => p.platform);
    assert.deepEqual(names, ["meta_ig", "meta_fb", "tiktok", "youtube", "linkedin", "x"]);
    assert.equal(listed.limits.length, 6);
    assert.equal(PLATFORM_LIMITS.youtube.photo, false);
    assert.equal(PLATFORM_LIMITS.meta_ig.carousel.max, 10);
    assert.equal(PLATFORM_LIMITS.x.carousel.max, 4);
    assert.equal(PLATFORM_LIMITS.linkedin.carousel.max, 20);
  });

  it("normalizes aliases", () => {
    assert.deepEqual(normalizePlatforms({ platforms: ["ig", "fb", "twitter", "yt"] }), [
      "meta_ig",
      "meta_fb",
      "x",
      "youtube",
    ]);
  });
});

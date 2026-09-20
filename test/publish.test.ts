import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../src/meta-client.js";
import { schedulePost, createCarousel } from "../src/content-service.js";
import { MediaRegistry, ScheduleStore } from "../src/store.js";
import { TikTokClient } from "../src/tiktok-client.js";
import { YouTubeClient } from "../src/youtube-client.js";
import { LinkedInClient } from "../src/linkedin-client.js";
import { XClient } from "../src/x-client.js";

let dataDir: string;
const savedEnv: Record<string, string | undefined> = {};

function stash(keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restore() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("confirm publish paths (mocked HTTP)", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "content-pub-"));
    stash([
      "META_ACCESS_TOKEN",
      "BRAND_HAMILL_IG_USER_ID",
      "BRAND_HAMILL_PAGE_ID",
      "BRAND_HAMILL_TIKTOK_OPEN_ID",
      "BRAND_HAMILL_TIKTOK_ACCESS_TOKEN",
      "BRAND_HAMILL_YOUTUBE_CHANNEL_ID",
      "BRAND_HAMILL_YOUTUBE_REFRESH_TOKEN",
      "YOUTUBE_CLIENT_ID",
      "YOUTUBE_CLIENT_SECRET",
      "BRAND_HAMILL_LINKEDIN_AUTHOR_URN",
      "BRAND_HAMILL_LINKEDIN_ACCESS_TOKEN",
      "LINKEDIN_ACCESS_TOKEN",
      "X_API_KEY",
      "X_API_SECRET",
      "BRAND_HAMILL_X_ACCESS_TOKEN",
      "BRAND_HAMILL_X_ACCESS_TOKEN_SECRET",
    ]);
    process.env.META_ACCESS_TOKEN = "EAABTESTTOKEN";
    process.env.BRAND_HAMILL_IG_USER_ID = "1784140001";
    process.env.BRAND_HAMILL_PAGE_ID = "111";
    process.env.BRAND_HAMILL_TIKTOK_OPEN_ID = "tt_open";
    process.env.BRAND_HAMILL_TIKTOK_ACCESS_TOKEN = "act.fake";
    process.env.BRAND_HAMILL_YOUTUBE_CHANNEL_ID = "UCtest";
    process.env.BRAND_HAMILL_YOUTUBE_REFRESH_TOKEN = "1//refresh";
    process.env.YOUTUBE_CLIENT_ID = "yt.client";
    process.env.YOUTUBE_CLIENT_SECRET = "yt.secret";
    process.env.BRAND_HAMILL_LINKEDIN_AUTHOR_URN = "urn:li:organization:9";
    process.env.LINKEDIN_ACCESS_TOKEN = "li.token";
    process.env.X_API_KEY = "xk";
    process.env.X_API_SECRET = "xs";
    process.env.BRAND_HAMILL_X_ACCESS_TOKEN = "xt";
    process.env.BRAND_HAMILL_X_ACCESS_TOKEN_SECRET = "xts";
  });
  afterEach(() => {
    restore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("Meta IG publish_now with confirm calls media_publish", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.replace(/access_token=[^&]+/, "access_token=[REDACTED]")}`);
      if (url.includes("media_publish")) return jsonRes({ id: "ig_post_1" });
      if (url.includes("/media")) return jsonRes({ id: "ig_container_1" });
      return jsonRes({ id: "ok", status_code: "FINISHED" });
    };
    const client = new MetaClient({ accessToken: "EAABTESTTOKEN", fetchImpl });
    const out = await schedulePost(
      {
        brand: "hamill",
        platforms: ["meta_ig"],
        image_url: "https://cdn.canva.com/a.png",
        publish_now: true,
        confirm: true,
        caption: "live",
      },
      {
        client,
        fetchImpl,
        media: MediaRegistry.create(dataDir),
        schedules: ScheduleStore.create(dataDir),
        waitForReady: false,
      },
    );
    assert.equal("results" in out, true);
    const r = (out as { results: Array<{ status: string; post_id?: string; platform: string }> }).results[0];
    assert.equal(r.platform, "meta_ig");
    assert.equal(r.status, "published");
    assert.equal(r.post_id, "ig_post_1");
    assert.ok(calls.some((c) => c.includes("media_publish")));
    assert.ok(calls.every((c) => !c.includes("EAABTESTTOKEN")));
  });

  it("TikTok photo Direct Post with confirm", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("creator_info")) {
        return jsonRes({ data: { privacy_level_options: ["SELF_ONLY"], creator_username: "hamill" }, error: { code: "ok" } });
      }
      if (url.includes("content/init")) {
        return jsonRes({ data: { publish_id: "p_photo_1" }, error: { code: "ok" } });
      }
      return jsonRes({ error: { code: "ok" } });
    };
    const tt = TikTokClient.fromBrand("hamill", fetchImpl);
    const res = await tt.directPostPhoto({
      imageUrls: ["https://cdn.canva.com/a.png", "https://cdn.canva.com/b.png"],
      caption: "carousel stills",
    });
    assert.equal("publish_id" in res && res.publish_id, "p_photo_1");
  });

  it("YouTube short mp4 upload with confirm (resumable mock)", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) return jsonRes({ access_token: "ya29.mock" });
      if (url.includes("cdn.canva.com/short.mp4")) {
        return new Response(Buffer.from("fake-mp4"), { status: 200, headers: { "content-type": "video/mp4" } });
      }
      if (url.includes("uploadType=resumable") && init?.method === "POST") {
        return new Response(null, { status: 200, headers: { location: "https://youtube.googleapis.com/upload/session/1" } });
      }
      if (url.includes("/upload/session/1")) return jsonRes({ id: "yt_vid_1" });
      return jsonRes({});
    };
    const yt = YouTubeClient.fromBrand("hamill", fetchImpl);
    const res = await yt.uploadVideo({
      videoUrl: "https://cdn.canva.com/short.mp4",
      title: "Short",
      description: "Canva mp4",
    });
    assert.equal("video_id" in res && res.video_id, "yt_vid_1");
  });

  it("LinkedIn MultiImage with confirm", async () => {
    let images = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("action=initializeUpload")) {
        images += 1;
        return jsonRes({
          value: { uploadUrl: `https://www.linkedin.com/upload/${images}`, image: `urn:li:image:${images}` },
        });
      }
      if (url.includes("linkedin.com/upload/")) return new Response(null, { status: 201 });
      if (url.includes("/rest/posts")) {
        return jsonRes({ id: "urn:li:ugcPost:99" }, 201, { "x-restli-id": "urn:li:ugcPost:99" });
      }
      if (url.includes("cdn.canva.com")) {
        return new Response(Buffer.from("img"), { status: 200, headers: { "content-type": "image/png" } });
      }
      return jsonRes({});
    };
    const li = LinkedInClient.fromBrand("hamill", fetchImpl);
    const res = await li.publishImages({
      imageUrls: ["https://cdn.canva.com/1.png", "https://cdn.canva.com/2.png"],
      caption: "MultiImage",
    });
    assert.equal("post_id" in res && res.post_id, "urn:li:ugcPost:99");
  });

  it("X image tweet with confirm", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("media/upload")) return jsonRes({ media_id_string: "m1" });
      if (url.includes("/2/tweets")) return jsonRes({ data: { id: "tw1" } });
      if (url.includes("cdn.canva.com")) {
        return new Response(Buffer.from("img"), { status: 200, headers: { "content-type": "image/png" } });
      }
      return jsonRes({});
    };
    const xc = XClient.fromBrand("hamill", fetchImpl);
    const res = await xc.publishImages({ imageUrls: ["https://cdn.canva.com/1.png"], caption: "hi" });
    assert.equal("post_id" in res && res.post_id, "tw1");
  });

  it("rejects carousel length outside 2–10", async () => {
    await assert.rejects(
      () =>
        createCarousel(
          { brand: "hamill", media_ids: ["only-one"] },
          { media: MediaRegistry.create(dataDir), client: new MetaClient({ accessToken: "x", fetchImpl: async () => jsonRes({}) }) },
        ),
      /2–10/,
    );
  });
});

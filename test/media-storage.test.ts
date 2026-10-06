import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { schedulePost } from "../src/content-service.js";
import { GitHubStaticStorage, mediaStorageFromEnv, type MediaStorage } from "../src/media-storage.js";
import { ScheduleStore, MediaRegistry } from "../src/store.js";

let dataDir: string;

function tinyPng(): Uint8Array {
  const png = new PNG({ width: 1, height: 1 });
  png.data[0] = 200;
  png.data[1] = 10;
  png.data[2] = 10;
  png.data[3] = 255;
  return new Uint8Array(PNG.sync.write(png));
}

describe("durable media adapter", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "content-host-"));
    delete process.env.CONTENT_MEDIA_STORAGE;
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.CONTENT_MEDIA_STORAGE;
    delete process.env.GITHUB_STATIC_TOKEN;
  });

  it("is off unless CONTENT_MEDIA_STORAGE=github-static", () => {
    assert.equal(mediaStorageFromEnv({}), null);
    assert.equal(mediaStorageFromEnv({ CONTENT_MEDIA_STORAGE: "off" }), null);
    assert.throws(() => mediaStorageFromEnv({ CONTENT_MEDIA_STORAGE: "s3" }), /unknown CONTENT_MEDIA_STORAGE/);
    assert.throws(
      () => mediaStorageFromEnv({ CONTENT_MEDIA_STORAGE: "github-static" }),
      /GITHUB_STATIC_TOKEN/,
    );
  });

  it("commits JPEG bytes and waits for a 200 HEAD on adeptos.ai", async () => {
    const calls: Array<{ url: string; method: string; auth: string | null; body?: string }> = [];
    let heads = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, method, auth: headers.get("authorization"), body });
      if (method === "PUT") return new Response(JSON.stringify({ content: { path: "ok" } }), { status: 201 });
      if (method === "HEAD") {
        heads += 1;
        return new Response(null, { status: heads === 1 ? 404 : 200 });
      }
      return new Response("no", { status: 500 });
    };
    const storage = new GitHubStaticStorage({
      token: "ghp_SUPERSECRET",
      repo: "adeptos-ai/landing-adeptos",
      branch: "main",
      pathPrefix: "public/content-mcp",
      publicBase: "https://adeptos.ai",
      waitMs: 5_000,
      pollMs: 1,
      apiBase: "https://api.github.com",
      fetchImpl,
      sleep: async () => {},
      now: () => new Date("2026-10-06T15:00:00.000Z"),
    });
    const png = tinyPng();
    const saved = await storage.put({
      bytes: png,
      contentType: "image/png",
      filename: "slide.png",
    });
    assert.match(saved.url, /^https:\/\/adeptos\.ai\/content-mcp\/2026-10-06\/[a-f0-9]+\.jpg$/);
    assert.match(saved.path, /^public\/content-mcp\/2026-10-06\/[a-f0-9]+\.jpg$/);
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put);
    assert.match(put!.url, /\/repos\/adeptos-ai\/landing-adeptos\/contents\/public\/content-mcp\//);
    assert.equal(put!.auth, "Bearer ghp_SUPERSECRET");
    const payload = JSON.parse(put!.body ?? "{}") as { content?: string; branch?: string };
    assert.equal(payload.branch, "main");
    const committed = Buffer.from(payload.content ?? "", "base64");
    assert.equal(committed[0], 0xff);
    assert.equal(committed[1], 0xd8);
    assert.equal(heads, 2);
    const head = calls.find((c) => c.method === "HEAD");
    assert.equal(head?.auth, null);
    assert.equal(head?.url, saved.url);
  });

  it("does not echo the GitHub token when the contents API fails", async () => {
    const storage = new GitHubStaticStorage({
      token: "ghp_SUPERSECRET",
      repo: "adeptos-ai/landing-adeptos",
      branch: "main",
      pathPrefix: "public/content-mcp",
      publicBase: "https://adeptos.ai",
      waitMs: 0,
      pollMs: 0,
      apiBase: "https://api.github.com",
      fetchImpl: async () => new Response(JSON.stringify({ message: "bad credentials ghp_SUPERSECRET" }), { status: 401 }),
      sleep: async () => {},
    });
    await assert.rejects(
      () => storage.put({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg", filename: "a.jpg" }),
      (err: Error) => {
        assert.match(err.message, /github_static_put_failed: HTTP 401/);
        assert.equal(err.message.includes("ghp_SUPERSECRET"), false);
        return true;
      },
    );
  });

  it("rewrites booked media URLs when a storage adapter is injected, and preview does not upload", async () => {
    const puts: string[] = [];
    const storage: MediaStorage = {
      kind: "memory",
      isDurable: (url) => url.startsWith("https://adeptos.ai/"),
      put: async (input) => {
        puts.push(input.filename);
        return { url: "https://adeptos.ai/content-mcp/hosted.jpg", path: "public/content-mcp/hosted.jpg" };
      },
    };
    const schedules = ScheduleStore.create(dataDir);
    const deps = {
      schedules,
      media: MediaRegistry.create(dataDir),
      storage,
      fetchImpl: async () =>
        new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    };
    const preview = await schedulePost(
      {
        brand: "hamill",
        platforms: ["tiktok"],
        image_url: "https://scontent.xx.fbcdn.net/v/signed.jpg",
        publish_at: "2026-12-01T09:00:00",
      },
      deps,
    );
    assert.equal("dry_run" in preview && preview.dry_run, true);
    assert.equal(puts.length, 0);

    process.env.BRAND_HAMILL_TIKTOK_OPEN_ID = "tt_open";
    process.env.BRAND_HAMILL_TIKTOK_ACCESS_TOKEN = "act.fake";
    const out = await schedulePost(
      {
        brand: "hamill",
        platforms: ["tiktok"],
        image_url: "https://scontent.xx.fbcdn.net/v/signed.jpg",
        publish_at: "2026-12-01T09:00:00",
        confirm: true,
      },
      deps,
    );
    delete process.env.BRAND_HAMILL_TIKTOK_OPEN_ID;
    delete process.env.BRAND_HAMILL_TIKTOK_ACCESS_TOKEN;
    const id = (out as { results: Array<{ schedule_id?: string }> }).results[0]?.schedule_id;
    assert.equal(puts.length, 1);
    assert.equal(schedules.get(id!)?.media?.[0]?.url, "https://adeptos.ai/content-mcp/hosted.jpg");
  });
});

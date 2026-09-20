import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCollaborators, normalizeCollaborators, refuseStoriesCollaborators } from "../src/collaborators.js";
import { createIgCarouselContainer, createIgImageContainer } from "../src/graph-content.js";
import { MetaClient } from "../src/meta-client.js";
import { schedulePost } from "../src/content-service.js";
import { MediaRegistry, ScheduleStore } from "../src/store.js";

describe("normalizeCollaborators", () => {
  it("returns empty when omitted", () => {
    assert.deepEqual(normalizeCollaborators(undefined).usernames, []);
    assert.deepEqual(normalizeCollaborators([]).usernames, []);
  });

  it("strips @, lowercases, dedupes, clamps to 3", () => {
    const out = normalizeCollaborators(["@Zono", "hamill", "ZONO", "adeptos", "extra_brand"]);
    assert.deepEqual(out.usernames, ["zono", "hamill", "adeptos"]);
    assert.ok(out.warnings.some((w) => /at most 3/i.test(w)));
  });

  it("rejects invalid handles", () => {
    assert.throws(() => normalizeCollaborators(["https://instagram.com/zono"]), /invalid_collaborator/);
  });

  it("refuses Stories", () => {
    assert.throws(() => refuseStoriesCollaborators("STORIES"), /collaborators_not_supported/);
    assert.doesNotThrow(() => refuseStoriesCollaborators("REELS"));
  });

  it("does not set Graph field when empty", () => {
    const body: Record<string, unknown> = { image_url: "https://cdn.canva.com/a.png" };
    applyCollaborators(body, []);
    applyCollaborators(body, undefined);
    assert.equal("collaborators" in body, false);
    applyCollaborators(body, ["zono"]);
    assert.deepEqual(body.collaborators, ["zono"]);
  });
});

describe("Graph media create collaborators", () => {
  it("dry-run feed image includes collaborators; omit does not send the field", async () => {
    const client = new MetaClient({ accessToken: "EAABTEST", fetchImpl: async () => new Response("{}") });
    const withCollab = await createIgImageContainer(client, "1784140001", {
      imageUrl: "https://cdn.canva.com/a.png",
      caption: "hi",
      collaborators: ["zono", "adeptos"],
      dryRun: true,
    });
    assert.equal("dryRun" in withCollab, true);
    if ("dryRun" in withCollab) {
      assert.deepEqual(withCollab.body?.collaborators, ["zono", "adeptos"]);
    }

    const plain = await createIgImageContainer(client, "1784140001", {
      imageUrl: "https://cdn.canva.com/a.png",
      caption: "hi",
      dryRun: true,
    });
    assert.equal("dryRun" in plain, true);
    if ("dryRun" in plain) {
      assert.equal(plain.body && "collaborators" in plain.body, false);
    }

    const child = await createIgImageContainer(client, "1784140001", {
      imageUrl: "https://cdn.canva.com/a.png",
      isCarouselItem: true,
      collaborators: ["zono"],
      dryRun: true,
    });
    if ("dryRun" in child) {
      assert.equal(child.body && "collaborators" in child.body, false);
    }
  });

  it("carousel parent dry-run includes collaborators", async () => {
    const client = new MetaClient({ accessToken: "EAABTEST", fetchImpl: async () => new Response("{}") });
    const created = await createIgCarouselContainer(client, "1784140001", {
      children: ["c1", "c2"],
      caption: "deck",
      collaborators: ["zono"],
      dryRun: true,
    });
    assert.equal("dryRun" in created, true);
    if ("dryRun" in created) {
      assert.deepEqual(created.body?.collaborators, ["zono"]);
    }
  });
});

describe("schedule_post collaborator preview + confirm mock", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "collab-"));
    process.env.META_ACCESS_TOKEN = "EAABTESTTOKEN";
    process.env.BRAND_HAMILL_IG_USER_ID = "1784140001";
    process.env.BRAND_HAMILL_PAGE_ID = "111";
  });
  afterEach(() => {
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.BRAND_HAMILL_IG_USER_ID;
    delete process.env.BRAND_HAMILL_PAGE_ID;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function deps(fetchImpl?: typeof fetch) {
    const client = fetchImpl ? new MetaClient({ accessToken: "EAABTESTTOKEN", fetchImpl }) : null;
    return {
      client,
      fetchImpl,
      media: MediaRegistry.create(dataDir),
      schedules: ScheduleStore.create(dataDir),
      waitForReady: false as const,
    };
  }

  it("dry-run without confirm echoes planned collaborator usernames", async () => {
    const out = await schedulePost(
      {
        brand: "hamill",
        platforms: ["meta_ig"],
        image_url: "https://cdn.canva.com/a.png",
        caption: "collab dry-run",
        publish_now: true,
        collaborators: ["@Zono", "adeptos"],
      },
      deps(),
    );
    assert.equal("dry_run" in out && out.dry_run, true);
    assert.equal("confirm_required" in out && out.confirm_required, true);
    const plan = (out as { plan: { collaborators?: string[] } }).plan;
    assert.deepEqual(plan.collaborators, ["zono", "adeptos"]);
  });

  it("confirm path sends collaborators on Graph media create", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.body && typeof init.body === "string") bodies.push(init.body);
      if (url.includes("media_publish")) return new Response(JSON.stringify({ id: "ig_post_collab" }));
      if (url.includes("/collaborators")) {
        return new Response(JSON.stringify({ data: [{ username: "zono", invite_status: "pending" }] }));
      }
      if (url.includes("/media")) return new Response(JSON.stringify({ id: "ig_container_collab" }));
      return new Response(JSON.stringify({ id: "ok", status_code: "FINISHED" }));
    };
    const out = await schedulePost(
      {
        brand: "hamill",
        platforms: ["meta_ig"],
        image_url: "https://cdn.canva.com/a.png",
        caption: "with collabs",
        publish_now: true,
        confirm: true,
        collaborators: ["zono"],
      },
      deps(fetchImpl),
    );
    const r = (out as { results: Array<{ post_id?: string; collaborators?: string[] }> }).results[0];
    assert.equal(r.post_id, "ig_post_collab");
    assert.deepEqual(r.collaborators, ["zono"]);
    const mediaCreate = bodies.find((b) => b.includes("image_url"));
    assert.ok(mediaCreate, "expected media create body");
    assert.match(mediaCreate!, /collaborators/);
    assert.match(mediaCreate!, /zono/);
  });

  it("omitting collaborators does not send the field", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.body && typeof init.body === "string") bodies.push(init.body);
      const url = String(input);
      if (url.includes("media_publish")) return new Response(JSON.stringify({ id: "ig_post_plain" }));
      if (url.includes("/media")) return new Response(JSON.stringify({ id: "ig_container_plain" }));
      return new Response(JSON.stringify({ id: "ok", status_code: "FINISHED" }));
    };
    await schedulePost(
      {
        brand: "hamill",
        platforms: ["meta_ig"],
        image_url: "https://cdn.canva.com/a.png",
        publish_now: true,
        confirm: true,
      },
      deps(fetchImpl),
    );
    const mediaCreate = bodies.find((b) => b.includes("image_url"));
    assert.ok(mediaCreate);
    assert.equal(mediaCreate!.includes("collaborators"), false);
  });
});

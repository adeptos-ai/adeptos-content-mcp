import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertSameBrand, parseBrand, resolveBrand, loadBrand } from "../src/brands.js";

const saved: Record<string, string | undefined> = {};

function setEnv(map: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(map)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("brands", () => {
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(saved)) delete saved[k];
  });

  it("rejects unknown brands", () => {
    const parsed = parseBrand("nike");
    assert.equal(typeof parsed === "object" && "error" in parsed, true);
    assert.throws(() => resolveBrand("sas"), /unknown_brand/);
  });

  it("accepts hamill|zono|adeptos", () => {
    assert.equal(resolveBrand("Hamill"), "hamill");
    assert.equal(resolveBrand("zono"), "zono");
    assert.equal(resolveBrand("ADEPTOS"), "adeptos");
  });

  it("forbids cross-brand assets", () => {
    assert.throws(() => assertSameBrand("hamill", "zono", "123"), /cross_brand_forbidden/);
    assert.doesNotThrow(() => assertSameBrand("hamill", "hamill", "123"));
  });

  it("reports missing TikTok/YouTube/LinkedIn/X env separately", () => {
    setEnv({
      META_ACCESS_TOKEN: undefined,
      META_HAMILL_ACCESS_TOKEN: undefined,
      BRAND_HAMILL_META_ACCESS_TOKEN: undefined,
      BRAND_HAMILL_IG_USER_ID: undefined,
      BRAND_HAMILL_TIKTOK_OPEN_ID: undefined,
    });
    const cfg = loadBrand("hamill");
    assert.ok(cfg.missingMeta.length > 0);
    assert.ok(cfg.missingTikTok.length > 0);
    assert.ok(cfg.missingYouTube.length > 0);
    assert.ok(cfg.missingLinkedIn.length > 0);
    assert.ok(cfg.missingX.length > 0);
  });
});

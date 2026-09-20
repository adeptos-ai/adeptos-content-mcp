import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadBrand, requireMetaIg } from "../src/brands.js";
import { getAccessTokenFromEnv, tryGetAccessToken } from "../src/meta-client.js";
import {
  brandMetaTokenEnvKeys,
  metaPortfolioFor,
  missingMetaTokenEnvHint,
  requireBrandMetaAccessToken,
  resolveBrandMetaAccessToken,
} from "../src/meta-tokens.js";

const TOKEN_KEYS = [
  "META_ACCESS_TOKEN",
  "META_HAMILL_ACCESS_TOKEN",
  "META_ZONO_ACCESS_TOKEN",
  "BRAND_HAMILL_META_ACCESS_TOKEN",
  "BRAND_ADEPTOS_META_ACCESS_TOKEN",
  "BRAND_ZONO_META_ACCESS_TOKEN",
  "BRAND_HAMILL_IG_USER_ID",
  "BRAND_ADEPTOS_IG_USER_ID",
  "BRAND_ZONO_IG_USER_ID",
  "BRAND_HAMILL_PAGE_ID",
  "BRAND_ADEPTOS_PAGE_ID",
  "BRAND_ZONO_PAGE_ID",
] as const;

const saved: Record<string, string | undefined> = {};

function setEnv(map: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(map)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearMetaTokens() {
  const blank: Record<string, string | undefined> = {};
  for (const k of TOKEN_KEYS) blank[k] = undefined;
  setEnv(blank);
}

describe("Meta portfolio token resolution", () => {
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(saved)) delete saved[k];
  });

  it("maps two portfolios: Ryan Hamill (hamill+adeptos) and ZONO (zono)", () => {
    assert.equal(metaPortfolioFor("hamill"), "ryan_hamill");
    assert.equal(metaPortfolioFor("adeptos"), "ryan_hamill");
    assert.equal(metaPortfolioFor("zono"), "zono");
  });

  it("prefers BRAND_{BRAND}_META_ACCESS_TOKEN over portfolio aliases", () => {
    clearMetaTokens();
    setEnv({
      BRAND_HAMILL_META_ACCESS_TOKEN: "brand-hamill-override",
      META_ACCESS_TOKEN: "shared-hamill",
      META_HAMILL_ACCESS_TOKEN: "alias-hamill",
      BRAND_ADEPTOS_META_ACCESS_TOKEN: "brand-adeptos-override",
      BRAND_ZONO_META_ACCESS_TOKEN: "brand-zono-override",
      META_ZONO_ACCESS_TOKEN: "alias-zono",
    });
    assert.equal(resolveBrandMetaAccessToken("hamill"), "brand-hamill-override");
    assert.equal(resolveBrandMetaAccessToken("adeptos"), "brand-adeptos-override");
    assert.equal(resolveBrandMetaAccessToken("zono"), "brand-zono-override");
  });

  it("hamill and adeptos share META_ACCESS_TOKEN (Ryan Hamill portfolio)", () => {
    clearMetaTokens();
    setEnv({ META_ACCESS_TOKEN: "shared-ryan-hamill" });
    assert.equal(resolveBrandMetaAccessToken("hamill"), "shared-ryan-hamill");
    assert.equal(resolveBrandMetaAccessToken("adeptos"), "shared-ryan-hamill");
    assert.equal(resolveBrandMetaAccessToken("zono"), undefined);
  });

  it("META_HAMILL_ACCESS_TOKEN is an alias for the Ryan Hamill portfolio", () => {
    clearMetaTokens();
    setEnv({ META_HAMILL_ACCESS_TOKEN: "alias-ryan-hamill" });
    assert.equal(resolveBrandMetaAccessToken("hamill"), "alias-ryan-hamill");
    assert.equal(resolveBrandMetaAccessToken("adeptos"), "alias-ryan-hamill");
    assert.equal(tryGetAccessToken("adeptos"), "alias-ryan-hamill");
    assert.equal(getAccessTokenFromEnv("hamill"), "alias-ryan-hamill");
    assert.equal(resolveBrandMetaAccessToken("zono"), undefined);
  });

  it("zono uses META_ZONO_ACCESS_TOKEN or BRAND_ZONO_META_ACCESS_TOKEN only", () => {
    clearMetaTokens();
    setEnv({ META_ZONO_ACCESS_TOKEN: "zono-portfolio" });
    assert.equal(resolveBrandMetaAccessToken("zono"), "zono-portfolio");
    assert.equal(resolveBrandMetaAccessToken("hamill"), undefined);
    assert.equal(resolveBrandMetaAccessToken("adeptos"), undefined);

    clearMetaTokens();
    setEnv({ BRAND_ZONO_META_ACCESS_TOKEN: "zono-brand-key" });
    assert.equal(resolveBrandMetaAccessToken("zono"), "zono-brand-key");
  });

  it("never cross-brand: zono ignores Hamill tokens; hamill/adeptos ignore Zono tokens", () => {
    clearMetaTokens();
    setEnv({
      META_ACCESS_TOKEN: "shared-ryan-hamill",
      META_HAMILL_ACCESS_TOKEN: "alias-ryan-hamill",
      BRAND_HAMILL_META_ACCESS_TOKEN: "brand-hamill",
      BRAND_ADEPTOS_META_ACCESS_TOKEN: "brand-adeptos",
    });
    assert.equal(resolveBrandMetaAccessToken("zono"), undefined);

    clearMetaTokens();
    setEnv({
      META_ZONO_ACCESS_TOKEN: "zono-portfolio",
      BRAND_ZONO_META_ACCESS_TOKEN: "zono-brand",
    });
    assert.equal(resolveBrandMetaAccessToken("hamill"), undefined);
    assert.equal(resolveBrandMetaAccessToken("adeptos"), undefined);
  });

  it("loadBrand missingMeta does not demand a third Adeptos-only BM token when Hamill token is set", () => {
    clearMetaTokens();
    setEnv({
      META_HAMILL_ACCESS_TOKEN: "alias-ryan-hamill",
      BRAND_HAMILL_IG_USER_ID: "ig-h",
      BRAND_HAMILL_PAGE_ID: "pg-h",
      BRAND_ADEPTOS_IG_USER_ID: "ig-a",
      BRAND_ADEPTOS_PAGE_ID: "pg-a",
    });
    const hamill = loadBrand("hamill");
    const adeptos = loadBrand("adeptos");
    const zono = loadBrand("zono");
    assert.deepEqual(hamill.missingMeta, []);
    assert.deepEqual(adeptos.missingMeta, []);
    assert.ok(adeptos.missingMeta.every((m) => !m.includes("BRAND_ADEPTOS_META_ACCESS_TOKEN")));
    assert.ok(zono.missingMeta.some((m) => m.includes("META_ZONO_ACCESS_TOKEN")));
    assert.ok(zono.missingMeta.some((m) => m.includes("BRAND_ZONO_META_ACCESS_TOKEN")));
  });

  it("loadBrand missingMeta names portfolio keys when the token is absent", () => {
    clearMetaTokens();
    const hamill = loadBrand("hamill");
    const adeptos = loadBrand("adeptos");
    const zono = loadBrand("zono");
    assert.ok(hamill.missingMeta.includes(missingMetaTokenEnvHint("hamill")));
    assert.ok(adeptos.missingMeta.includes(missingMetaTokenEnvHint("adeptos")));
    assert.ok(zono.missingMeta.includes(missingMetaTokenEnvHint("zono")));
    assert.match(missingMetaTokenEnvHint("hamill"), /BRAND_HAMILL_META_ACCESS_TOKEN/);
    assert.match(missingMetaTokenEnvHint("hamill"), /META_ACCESS_TOKEN/);
    assert.match(missingMetaTokenEnvHint("hamill"), /META_HAMILL_ACCESS_TOKEN/);
    assert.match(missingMetaTokenEnvHint("adeptos"), /BRAND_ADEPTOS_META_ACCESS_TOKEN/);
    assert.match(missingMetaTokenEnvHint("adeptos"), /META_HAMILL_ACCESS_TOKEN/);
    assert.ok(!brandMetaTokenEnvKeys("zono").includes("META_ACCESS_TOKEN"));
    assert.ok(!brandMetaTokenEnvKeys("zono").includes("META_HAMILL_ACCESS_TOKEN"));
    assert.deepEqual(brandMetaTokenEnvKeys("zono"), [
      "BRAND_ZONO_META_ACCESS_TOKEN",
      "META_ZONO_ACCESS_TOKEN",
    ]);
  });

  it("requireMetaIg / requireBrandMetaAccessToken errors name the missing env keys", () => {
    clearMetaTokens();
    setEnv({ BRAND_ADEPTOS_IG_USER_ID: "ig-a" });
    assert.throws(() => requireMetaIg("adeptos"), /BRAND_ADEPTOS_META_ACCESS_TOKEN/);
    assert.throws(() => requireMetaIg("adeptos"), /META_ACCESS_TOKEN/);
    assert.throws(() => requireMetaIg("adeptos"), /META_HAMILL_ACCESS_TOKEN/);
    assert.throws(() => requireMetaIg("adeptos"), /Ryan Hamill/);
    assert.throws(() => requireBrandMetaAccessToken("zono"), /BRAND_ZONO_META_ACCESS_TOKEN/);
    assert.throws(() => requireBrandMetaAccessToken("zono"), /META_ZONO_ACCESS_TOKEN/);
    assert.throws(() => requireBrandMetaAccessToken("zono"), /ZONO Business Manager/);
    assert.throws(() => getAccessTokenFromEnv("zono"), /Never cross-brand/);
  });

  it("requireMetaIg accepts adeptos with the shared Ryan Hamill token", () => {
    clearMetaTokens();
    setEnv({
      META_ACCESS_TOKEN: "shared-ryan-hamill",
      BRAND_ADEPTOS_IG_USER_ID: "ig-a",
    });
    const cfg = requireMetaIg("adeptos");
    assert.equal(cfg.brand, "adeptos");
    assert.equal(cfg.igUserId, "ig-a");
    assert.equal(cfg.missingMeta.includes(missingMetaTokenEnvHint("adeptos")), false);
  });
});

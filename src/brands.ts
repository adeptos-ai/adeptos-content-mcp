import { missingMetaTokenEnvHint, missingMetaTokenError, resolveBrandMetaAccessToken } from "./meta-tokens.js";
import { BRAND_KEYS, type BrandKey } from "./types.js";

export type BrandConfig = {
  brand: BrandKey;
  name: string;
  igUserId: string | null;
  pageId: string | null;
  tiktokOpenId: string | null;
  tiktokAccessToken: string | null;
  tiktokRefreshToken: string | null;
  youtubeChannelId: string | null;
  youtubeRefreshToken: string | null;
  linkedinAuthorUrn: string | null;
  linkedinAccessToken: string | null;
  xAccessToken: string | null;
  xAccessTokenSecret: string | null;
  xUserId: string | null;
  missingMeta: string[];
  missingTikTok: string[];
  missingYouTube: string[];
  missingLinkedIn: string[];
  missingX: string[];
};

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function brandEnvPrefix(brand: BrandKey): string {
  return `BRAND_${brand.toUpperCase()}`;
}

export function isBrandKey(value: string): value is BrandKey {
  return (BRAND_KEYS as readonly string[]).includes(value);
}

export function parseBrand(value: string | undefined): BrandKey | { error: string } {
  if (!value) return { error: "brand is required (hamill | zono | adeptos)" };
  const key = value.trim().toLowerCase();
  if (!isBrandKey(key)) {
    return {
      error: `unknown_brand: ${value}. Allowed: ${BRAND_KEYS.join(", ")}. Never cross-brand assets.`,
    };
  }
  return key;
}

export function resolveBrand(value: string): BrandKey {
  const parsed = parseBrand(value);
  if (typeof parsed !== "string") throw new Error(parsed.error);
  return parsed;
}

export function defaultBrandName(brand: BrandKey): string {
  switch (brand) {
    case "hamill":
      return "Hamill";
    case "zono":
      return "Zono";
    case "adeptos":
      return "Adeptos";
  }
}

function linkedinAuthor(prefix: string): string | null {
  const urn = env(`${prefix}_LINKEDIN_AUTHOR_URN`);
  if (urn) return urn;
  const org = env(`${prefix}_LINKEDIN_ORG_ID`);
  if (org) return org.startsWith("urn:") ? org : `urn:li:organization:${org}`;
  const person = env(`${prefix}_LINKEDIN_PERSON_ID`);
  if (person) return person.startsWith("urn:") ? person : `urn:li:person:${person}`;
  return null;
}

export function loadBrand(brand: BrandKey): BrandConfig {
  const prefix = brandEnvPrefix(brand);
  const igUserId = env(`${prefix}_IG_USER_ID`) ?? null;
  const pageId = env(`${prefix}_PAGE_ID`) ?? null;
  const name = env(`${prefix}_NAME`) ?? defaultBrandName(brand);

  const tiktokOpenId = env(`${prefix}_TIKTOK_OPEN_ID`) ?? null;
  const tiktokAccessToken = env(`${prefix}_TIKTOK_ACCESS_TOKEN`) ?? env("TIKTOK_ACCESS_TOKEN") ?? null;
  const tiktokRefreshToken = env(`${prefix}_TIKTOK_REFRESH_TOKEN`) ?? env("TIKTOK_REFRESH_TOKEN") ?? null;

  const youtubeChannelId = env(`${prefix}_YOUTUBE_CHANNEL_ID`) ?? null;
  const youtubeRefreshToken = env(`${prefix}_YOUTUBE_REFRESH_TOKEN`) ?? env("YOUTUBE_REFRESH_TOKEN") ?? null;

  const linkedinAuthorUrn = linkedinAuthor(prefix);
  const linkedinAccessToken = env(`${prefix}_LINKEDIN_ACCESS_TOKEN`) ?? env("LINKEDIN_ACCESS_TOKEN") ?? null;

  const xAccessToken = env(`${prefix}_X_ACCESS_TOKEN`) ?? env("X_ACCESS_TOKEN") ?? null;
  const xAccessTokenSecret = env(`${prefix}_X_ACCESS_TOKEN_SECRET`) ?? env("X_ACCESS_TOKEN_SECRET") ?? null;
  const xUserId = env(`${prefix}_X_USER_ID`) ?? null;

  const missingMeta: string[] = [];
  if (!igUserId) missingMeta.push(`${prefix}_IG_USER_ID`);
  if (!pageId) missingMeta.push(`${prefix}_PAGE_ID`);
  if (!resolveBrandMetaAccessToken(brand)) missingMeta.push(missingMetaTokenEnvHint(brand));

  const missingTikTok: string[] = [];
  if (!tiktokOpenId) missingTikTok.push(`${prefix}_TIKTOK_OPEN_ID`);
  if (!tiktokAccessToken && !tiktokRefreshToken) {
    missingTikTok.push(`${prefix}_TIKTOK_ACCESS_TOKEN or ${prefix}_TIKTOK_REFRESH_TOKEN`);
  }
  if (tiktokRefreshToken && (!env("TIKTOK_CLIENT_KEY") || !env("TIKTOK_CLIENT_SECRET"))) {
    missingTikTok.push("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET");
  }

  const missingYouTube: string[] = [];
  if (!youtubeChannelId) missingYouTube.push(`${prefix}_YOUTUBE_CHANNEL_ID`);
  if (!youtubeRefreshToken) missingYouTube.push(`${prefix}_YOUTUBE_REFRESH_TOKEN or YOUTUBE_REFRESH_TOKEN`);
  if (!env("YOUTUBE_CLIENT_ID")) missingYouTube.push("YOUTUBE_CLIENT_ID");
  if (!env("YOUTUBE_CLIENT_SECRET")) missingYouTube.push("YOUTUBE_CLIENT_SECRET");

  const missingLinkedIn: string[] = [];
  if (!linkedinAuthorUrn) {
    missingLinkedIn.push(`${prefix}_LINKEDIN_AUTHOR_URN or ${prefix}_LINKEDIN_ORG_ID`);
  }
  if (!linkedinAccessToken) missingLinkedIn.push(`${prefix}_LINKEDIN_ACCESS_TOKEN or LINKEDIN_ACCESS_TOKEN`);

  const missingX: string[] = [];
  if (!env("X_API_KEY")) missingX.push("X_API_KEY");
  if (!env("X_API_SECRET")) missingX.push("X_API_SECRET");
  if (!xAccessToken) missingX.push(`${prefix}_X_ACCESS_TOKEN`);
  if (!xAccessTokenSecret) missingX.push(`${prefix}_X_ACCESS_TOKEN_SECRET`);

  return {
    brand,
    name,
    igUserId,
    pageId,
    tiktokOpenId,
    tiktokAccessToken,
    tiktokRefreshToken,
    youtubeChannelId,
    youtubeRefreshToken,
    linkedinAuthorUrn,
    linkedinAccessToken,
    xAccessToken,
    xAccessTokenSecret,
    xUserId,
    missingMeta,
    missingTikTok,
    missingYouTube,
    missingLinkedIn,
    missingX,
  };
}

export function loadAllBrands(): BrandConfig[] {
  return BRAND_KEYS.map(loadBrand);
}

export function requireMetaIg(brand: BrandKey): BrandConfig {
  const cfg = loadBrand(brand);
  if (!cfg.igUserId) {
    throw new Error(
      `missing_brand_config: ${brand} has no IG user id. Set ${brandEnvPrefix(brand)}_IG_USER_ID. Leo owns Meta (Rec0C3QKVTL0Y).`,
    );
  }
  if (!resolveBrandMetaAccessToken(brand)) {
    throw missingMetaTokenError(brand);
  }
  return cfg;
}

export function requireMetaPage(brand: BrandKey): BrandConfig {
  const cfg = requireMetaIg(brand);
  if (!cfg.pageId) {
    throw new Error(`missing_brand_config: ${brand} has no FB Page id. Set ${brandEnvPrefix(brand)}_PAGE_ID.`);
  }
  return cfg;
}

export function requireTikTok(brand: BrandKey): BrandConfig {
  const cfg = loadBrand(brand);
  if (cfg.missingTikTok.length) {
    throw new Error(`missing_brand_config: ${brand} TikTok needs ${cfg.missingTikTok.join(", ")}.`);
  }
  return cfg;
}

export function requireYouTube(brand: BrandKey): BrandConfig {
  const cfg = loadBrand(brand);
  if (cfg.missingYouTube.length) {
    throw new Error(
      `missing_brand_config: ${brand} YouTube needs ${cfg.missingYouTube.join(", ")}. ` +
        "OAuth refresh token per channel — service accounts cannot upload to a brand channel.",
    );
  }
  return cfg;
}

export function requireLinkedIn(brand: BrandKey): BrandConfig {
  const cfg = loadBrand(brand);
  if (cfg.missingLinkedIn.length) {
    throw new Error(`missing_brand_config: ${brand} LinkedIn needs ${cfg.missingLinkedIn.join(", ")}.`);
  }
  return cfg;
}

export function requireX(brand: BrandKey): BrandConfig {
  const cfg = loadBrand(brand);
  if (cfg.missingX.length) {
    throw new Error(`missing_brand_config: ${brand} X needs ${cfg.missingX.join(", ")}.`);
  }
  return cfg;
}

export function assertSameBrand(expected: BrandKey, actual: BrandKey, assetId: string): void {
  if (expected !== actual) {
    throw new Error(
      `cross_brand_forbidden: asset ${assetId} belongs to ${actual}, call used ${expected}. ` +
        "One brand per call — never reuse another brand's account or media.",
    );
  }
}

export const requireBrand = requireMetaIg;
export const requireBrandPage = requireMetaPage;

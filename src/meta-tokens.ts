/**
 * Two Meta Business Manager portfolios — never a third Adeptos-only BM token.
 *
 * 1. Ryan Hamill BM — Hamill + Adeptos AI Instagram/Page assets
 *    brands: hamill, adeptos (shared token)
 * 2. ZONO BM — Zono assets
 *    brand: zono (own token)
 *
 * Never use another brand/portfolio token. confirm:true still required on writes.
 */

import type { BrandKey } from "./types.js";

export type MetaPortfolio = "ryan_hamill" | "zono";

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function metaPortfolioFor(brand: BrandKey): MetaPortfolio {
  return brand === "zono" ? "zono" : "ryan_hamill";
}

export function metaPortfolioLabel(brand: BrandKey): string {
  return brand === "zono"
    ? "ZONO Business Manager"
    : "Ryan Hamill Business Manager (hamill + adeptos)";
}

/** Preference order: brand override, then that brand's portfolio aliases. */
export function brandMetaTokenEnvKeys(brand: BrandKey): readonly string[] {
  const brandKey = `BRAND_${brand.toUpperCase()}_META_ACCESS_TOKEN`;
  if (brand === "zono") {
    return [brandKey, "META_ZONO_ACCESS_TOKEN"];
  }
  return [brandKey, "META_ACCESS_TOKEN", "META_HAMILL_ACCESS_TOKEN"];
}

export function missingMetaTokenEnvHint(brand: BrandKey): string {
  return brandMetaTokenEnvKeys(brand).join(" or ");
}

export function resolveBrandMetaAccessToken(brand: BrandKey): string | undefined {
  for (const key of brandMetaTokenEnvKeys(brand)) {
    const v = env(key);
    if (v) return v;
  }
  return undefined;
}

export function missingMetaTokenError(brand: BrandKey): Error {
  return new Error(
    `missing_brand_config: ${brand} Meta Graph token is not set for ${metaPortfolioLabel(brand)}. ` +
      `Set ${missingMetaTokenEnvHint(brand)}. Leonardo owns token mint (Rec0C3QKVTL0Y). Never cross-brand.`,
  );
}

export function requireBrandMetaAccessToken(brand: BrandKey): string {
  const token = resolveBrandMetaAccessToken(brand);
  if (!token) throw missingMetaTokenError(brand);
  return token;
}

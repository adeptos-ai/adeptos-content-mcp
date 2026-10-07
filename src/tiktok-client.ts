/**
 * TikTok Content Posting API (Direct Post).
 * Login Kit user tokens with video.publish. No native schedule — use mcp_cron.
 * Never log tokens.
 */

import { brandEnvPrefix, loadBrand, type BrandConfig } from "./brands.js";
import { persistEnvValues, readEnvFileValue } from "./env-persist.js";
import { redactDeep, redactString, safeErrorMessage } from "./safety.js";
import type { BrandKey } from "./types.js";

export const TIKTOK_API_BASE = "https://open.tiktokapis.com";

export class TikTokApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(redactString(message));
    this.name = "TikTokApiError";
  }
}

export type TikTokCreatorInfo = {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
};

export type TikTokPublishResult = {
  publish_id: string;
  upload_url?: string;
  privacy_level: string;
  path: "tiktok_direct_post";
};

export class TikTokClient {
  constructor(
    private accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly cfg: BrandConfig,
  ) {}

  static fromBrand(brand: BrandKey, fetchImpl: typeof fetch = fetch): TikTokClient {
    const cfg = loadBrand(brand);
    const token = cfg.tiktokAccessToken;
    if (!token && !cfg.tiktokRefreshToken) {
      throw new Error(`TikTok token missing for ${brand}`);
    }
    return new TikTokClient(token ?? "", fetchImpl, cfg);
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (json) h["Content-Type"] = "application/json; charset=UTF-8";
    return h;
  }

  /** Refreshed at most once per client instance (hotfix 2026-10-06). */
  private refreshedOnce = false;

  /**
   * Env keys that hold this brand's tokens. Brand-scoped keys win; falls back to the global
   * TIKTOK_* keys only when the brand has no refresh token of its own (mirrors loadBrand()).
   */
  private tokenEnvKeys(): { access: string; refresh: string } {
    const prefix = brandEnvPrefix(this.cfg.brand);
    const brandRefresh = process.env[`${prefix}_TIKTOK_REFRESH_TOKEN`]?.trim();
    if (!brandRefresh && process.env.TIKTOK_REFRESH_TOKEN?.trim()) {
      return { access: "TIKTOK_ACCESS_TOKEN", refresh: "TIKTOK_REFRESH_TOKEN" };
    }
    return { access: `${prefix}_TIKTOK_ACCESS_TOKEN`, refresh: `${prefix}_TIKTOK_REFRESH_TOKEN` };
  }

  /**
   * Exchange the refresh token for a new access token, adopt it, and persist it (plus a rotated
   * refresh token) to process.env and .env so other clients/instances pick it up.
   */
  async refreshAccessToken(): Promise<string> {
    const keys = this.tokenEnvKeys();
    // Prefer the on-disk value: another instance may already have rotated the refresh token.
    const refreshToken = readEnvFileValue(keys.refresh) ?? this.cfg.tiktokRefreshToken;
    if (!refreshToken) throw new Error("TikTok access token expired/invalid and no refresh token is configured");
    const refreshed = await refreshTikTokTokenFull(refreshToken, this.fetchImpl);
    this.accessToken = refreshed.accessToken;
    this.refreshedOnce = true;
    const updates: Record<string, string> = { [keys.access]: refreshed.accessToken };
    if (refreshed.refreshToken && refreshed.refreshToken !== refreshToken) {
      updates[keys.refresh] = refreshed.refreshToken;
    }
    this.cfg.tiktokAccessToken = refreshed.accessToken;
    if (updates[keys.refresh]) this.cfg.tiktokRefreshToken = updates[keys.refresh];
    try {
      persistEnvValues(updates);
    } catch (err) {
      // process.env is already updated in persistEnvValues before the file write; keep serving.
      console.error(`[tiktok] could not persist refreshed token to .env: ${safeErrorMessage(err)}`);
    }
    return refreshed.accessToken;
  }

  async ensureAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    if (!this.cfg.tiktokRefreshToken) throw new Error("TikTok access token and refresh token are both empty");
    return this.refreshAccessToken();
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    opts: { dryRun?: boolean } = {},
  ): Promise<T | { dryRun: true; method: string; path: string; body?: Record<string, unknown> }> {
    if (opts.dryRun) {
      return { dryRun: true, method, path, body };
    }
    await this.ensureAccessToken();
    try {
      return await this.send<T>(method, path, body);
    } catch (err) {
      // TikTok access tokens live ~24h. On an expired/invalid token, refresh once and retry.
      if (isTikTokTokenError(err) && this.cfg.tiktokRefreshToken && !this.refreshedOnce) {
        await this.refreshAccessToken();
        return this.send<T>(method, path, body);
      }
      throw err;
    }
  }

  private async send<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const url = path.startsWith("http") ? path : `${TIKTOK_API_BASE}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.headers(Boolean(body)),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new TikTokApiError(`TikTok request failed: ${safeErrorMessage(err)}`, 0, null);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: redactString(text) };
    }
    parsed = redactDeep(parsed);
    const errObj =
      typeof parsed === "object" && parsed && "error" in parsed
        ? (parsed as { error?: { code?: string; message?: string } }).error
        : undefined;
    if (!res.ok || (errObj && errObj.code && errObj.code !== "ok")) {
      throw new TikTokApiError(errObj?.message || errObj?.code || `TikTok API ${res.status}`, res.status, parsed);
    }
    return parsed as T;
  }

  async creatorInfo(opts: { dryRun?: boolean } = {}) {
    return this.request<{ data: TikTokCreatorInfo }>("POST", "/v2/post/publish/creator_info/query/", {}, opts);
  }

  async directPostVideo(
    opts: {
      videoUrl: string;
      caption?: string;
      privacyLevel?: string;
      dryRun?: boolean;
    },
  ): Promise<TikTokPublishResult | { dryRun: true; method: string; path: string; body?: Record<string, unknown> }> {
    const creator = await this.creatorInfo({ dryRun: opts.dryRun });
    const options =
      !opts.dryRun && creator && "data" in creator
        ? creator.data.privacy_level_options ?? ["SELF_ONLY"]
        : ["SELF_ONLY", "PUBLIC_TO_EVERYONE"];
    const privacy = pickPrivacy(opts.privacyLevel, options);

    const body = {
      post_info: {
        title: opts.caption ?? "",
        privacy_level: privacy,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        brand_content_toggle: false,
        brand_organic_toggle: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        video_url: opts.videoUrl,
      },
    };

    const res = await this.request<{ data?: { publish_id?: string; upload_url?: string } }>(
      "POST",
      "/v2/post/publish/video/init/",
      body,
      { dryRun: opts.dryRun },
    );
    if ("dryRun" in res) return res;
    const publishId = res.data?.publish_id;
    if (!publishId) throw new TikTokApiError("TikTok did not return publish_id", 502, res);
    return {
      publish_id: publishId,
      upload_url: res.data?.upload_url,
      privacy_level: privacy,
      path: "tiktok_direct_post",
    };
  }

  async directPostPhoto(
    opts: {
      imageUrls: string[];
      caption?: string;
      privacyLevel?: string;
      dryRun?: boolean;
    },
  ): Promise<TikTokPublishResult | { dryRun: true; method: string; path: string; body?: Record<string, unknown> }> {
    const creator = await this.creatorInfo({ dryRun: opts.dryRun });
    const options =
      !opts.dryRun && creator && "data" in creator
        ? creator.data.privacy_level_options ?? ["SELF_ONLY"]
        : ["SELF_ONLY", "PUBLIC_TO_EVERYONE"];
    const privacy = pickPrivacy(opts.privacyLevel, options);
    const body = {
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
      post_info: {
        title: opts.caption ?? "",
        description: opts.caption ?? "",
        privacy_level: privacy,
        brand_content_toggle: false,
        brand_organic_toggle: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_images: opts.imageUrls,
        photo_cover_index: 0,
      },
    };
    const res = await this.request<{ data?: { publish_id?: string } }>(
      "POST",
      "/v2/post/publish/content/init/",
      body,
      { dryRun: opts.dryRun },
    );
    if ("dryRun" in res) return res;
    const publishId = res.data?.publish_id;
    if (!publishId) throw new TikTokApiError("TikTok did not return publish_id", 502, res);
    return { publish_id: publishId, privacy_level: privacy, path: "tiktok_direct_post" };
  }

  async fetchStatus(publishId: string) {
    return this.request<{ data?: { status?: string; fail_reason?: string } }>(
      "POST",
      "/v2/post/publish/status/fetch/",
      { publish_id: publishId },
    );
  }
}

export function pickPrivacy(requested: string | undefined, options: string[]): string {
  if (requested && options.includes(requested)) return requested;
  if (options.includes("PUBLIC_TO_EVERYONE")) return "PUBLIC_TO_EVERYONE";
  if (options.includes("FOLLOWER_OF_CREATOR")) return "FOLLOWER_OF_CREATOR";
  if (options.includes("MUTUAL_FOLLOW_FRIENDS")) return "MUTUAL_FOLLOW_FRIENDS";
  return options[0] ?? "SELF_ONLY";
}

export function isTikTokTokenError(err: unknown): boolean {
  if (!(err instanceof TikTokApiError)) return false;
  const code = (err.body as { error?: { code?: string } } | null)?.error?.code;
  if (code === "access_token_invalid" || code === "access_token_expired") return true;
  return err.status === 401;
}

export type TikTokRefreshResult = {
  accessToken: string;
  /** TikTok may rotate the refresh token; callers must persist it when it changes. */
  refreshToken?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
  openId?: string;
  scope?: string;
};

export async function refreshTikTokTokenFull(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TikTokRefreshResult> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim();
  if (!clientKey || !clientSecret) {
    throw new Error("TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET are required to refresh tokens");
  }
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  let res: Response;
  try {
    res = await fetchImpl(`${TIKTOK_API_BASE}/v2/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw new TikTokApiError(`TikTok token refresh request failed: ${safeErrorMessage(err)}`, 0, null);
  }
  let json: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
    open_id?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !json.access_token) {
    throw new TikTokApiError(json.error_description || json.error || "TikTok token refresh failed", res.status, {
      error: json.error,
    });
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || undefined,
    expiresIn: json.expires_in,
    refreshExpiresIn: json.refresh_expires_in,
    openId: json.open_id,
    scope: json.scope,
  };
}

/** Back-compat: returns only the access token. Prefer refreshTikTokTokenFull() so rotation is not lost. */
export async function refreshTikTokToken(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  return (await refreshTikTokTokenFull(refreshToken, fetchImpl)).accessToken;
}

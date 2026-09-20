/**
 * TikTok Content Posting API (Direct Post).
 * Login Kit user tokens with video.publish. No native schedule — use mcp_cron.
 * Never log tokens.
 */

import { loadBrand, type BrandConfig } from "./brands.js";
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

  async ensureAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    if (!this.cfg.tiktokRefreshToken) throw new Error("TikTok access token and refresh token are both empty");
    const refreshed = await refreshTikTokToken(this.cfg.tiktokRefreshToken, this.fetchImpl);
    this.accessToken = refreshed;
    return refreshed;
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

export async function refreshTikTokToken(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
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
  const res = await fetchImpl(`${TIKTOK_API_BASE}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new TikTokApiError(json.error_description || json.error || "TikTok token refresh failed", res.status, {
      error: json.error,
    });
  }
  return json.access_token;
}

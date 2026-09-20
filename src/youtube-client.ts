/**
 * YouTube Data API v3 uploads.
 * Auth: OAuth refresh token per brand channel (not a service account).
 * Schedule: status.privacyStatus=private + status.publishAt (UTC ISO).
 * Never log tokens.
 */

import { loadBrand, type BrandConfig } from "./brands.js";
import { redactDeep, redactString, safeErrorMessage } from "./safety.js";
import type { BrandKey } from "./types.js";

export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(redactString(message));
    this.name = "YouTubeApiError";
  }
}

export type YouTubeChannel = {
  id: string;
  title?: string;
  customUrl?: string;
};

export type YouTubePublishResult = {
  video_id: string;
  privacy_status: string;
  publish_at?: string;
  path: "youtube_native";
};

export class YouTubeClient {
  private accessToken: string | undefined;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly cfg: BrandConfig,
  ) {}

  static fromBrand(brand: BrandKey, fetchImpl: typeof fetch = fetch): YouTubeClient {
    return new YouTubeClient(fetchImpl, loadBrand(brand));
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const refresh = this.cfg.youtubeRefreshToken;
    const clientId = process.env.YOUTUBE_CLIENT_ID?.trim();
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim();
    if (!refresh || !clientId || !clientSecret) {
      throw new Error("YouTube OAuth is not configured (client id/secret + refresh token)");
    }
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new YouTubeApiError(json.error_description || json.error || "YouTube token refresh failed", res.status, {
        error: json.error,
      });
    }
    this.accessToken = json.access_token;
    return json.access_token;
  }

  private async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    opts: {
      headers?: Record<string, string>;
      body?: BodyInit | null;
      dryRun?: boolean;
      planned?: Record<string, unknown>;
    } = {},
  ): Promise<T | { dryRun: true; method: string; path: string; body?: Record<string, unknown> }> {
    if (opts.dryRun) {
      return { dryRun: true, method, path: url, body: opts.planned };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: await this.authHeaders(opts.headers),
        body: opts.body,
      });
    } catch (err) {
      throw new YouTubeApiError(`YouTube request failed: ${safeErrorMessage(err)}`, 0, null);
    }
    const text = await res.text();
    let parsed: unknown = text ? text : null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: redactString(text) };
    }
    parsed = redactDeep(parsed);
    if (!res.ok) {
      const msg =
        typeof parsed === "object" &&
        parsed &&
        "error" in parsed &&
        typeof (parsed as { error?: { message?: string } }).error?.message === "string"
          ? (parsed as { error: { message: string } }).error.message
          : `YouTube API ${res.status}`;
      throw new YouTubeApiError(msg, res.status, parsed);
    }
    return parsed as T;
  }

  async getChannel(opts: { dryRun?: boolean } = {}): Promise<YouTubeChannel> {
    const url = `${YOUTUBE_API}/channels?part=id,snippet&mine=true`;
    const res = await this.request<{ items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string } }> }>(
      "GET",
      url,
      { dryRun: opts.dryRun, planned: { part: "id,snippet", mine: true } },
    );
    if ("dryRun" in res) {
      return { id: this.cfg.youtubeChannelId ?? "dry_run_channel" };
    }
    const item = res.items?.[0];
    if (!item) throw new YouTubeApiError("No YouTube channel on this refresh token", 404, res);
    if (this.cfg.youtubeChannelId && item.id !== this.cfg.youtubeChannelId) {
      throw new YouTubeApiError(
        `cross_brand_forbidden: token channel ${item.id} != configured ${this.cfg.youtubeChannelId}`,
        403,
        { configured: this.cfg.youtubeChannelId },
      );
    }
    return { id: item.id, title: item.snippet?.title, customUrl: item.snippet?.customUrl };
  }

  async uploadVideo(opts: {
    videoUrl: string;
    title: string;
    description?: string;
    publishAtUtc?: string;
    privacyStatus?: "private" | "public" | "unlisted";
    dryRun?: boolean;
  }): Promise<YouTubePublishResult | { dryRun: true; method: string; path: string; body?: Record<string, unknown> }> {
    const scheduled = Boolean(opts.publishAtUtc);
    const privacy = scheduled ? "private" : (opts.privacyStatus ?? "public");
    const metadata = {
      snippet: {
        title: opts.title.slice(0, 100),
        description: opts.description ?? "",
        categoryId: process.env.YOUTUBE_CATEGORY_ID?.trim() || "22",
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
        ...(scheduled ? { publishAt: opts.publishAtUtc } : {}),
      },
    };

    if (opts.dryRun) {
      return {
        dryRun: true,
        method: "POST",
        path: `${YOUTUBE_API}/videos?uploadType=resumable&part=snippet,status`,
        body: { ...metadata, source: opts.videoUrl },
      };
    }

    const media = await this.fetchImpl(opts.videoUrl);
    if (!media.ok) {
      throw new YouTubeApiError(`Failed to download video_url (${media.status})`, media.status, null);
    }
    const bytes = new Uint8Array(await media.arrayBuffer());
    const contentType = media.headers.get("content-type") || "video/mp4";

    const initUrl = `${YOUTUBE_API}/videos?uploadType=resumable&part=snippet,status`;
    const initRes = await this.fetchImpl(initUrl, {
      method: "POST",
      headers: await this.authHeaders({
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": contentType,
        "X-Upload-Content-Length": String(bytes.byteLength),
      }),
      body: JSON.stringify(metadata),
    });
    if (!initRes.ok) {
      const errText = redactString(await initRes.text());
      throw new YouTubeApiError(`YouTube resumable init failed (${initRes.status})`, initRes.status, errText);
    }
    const location = initRes.headers.get("location") || initRes.headers.get("Location");
    if (!location) throw new YouTubeApiError("YouTube resumable upload missing Location header", 502, null);

    const putRes = await this.fetchImpl(location, {
      method: "PUT",
      headers: await this.authHeaders({
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
      }),
      body: bytes as unknown as BodyInit,
    });
    const putText = await putRes.text();
    let parsed: unknown = null;
    try {
      parsed = putText ? JSON.parse(putText) : null;
    } catch {
      parsed = { raw: redactString(putText) };
    }
    parsed = redactDeep(parsed);
    if (!putRes.ok) {
      throw new YouTubeApiError("YouTube upload PUT failed", putRes.status, parsed);
    }
    const videoId = (parsed as { id?: string })?.id;
    if (!videoId) throw new YouTubeApiError("YouTube upload returned no video id", 502, parsed);
    return {
      video_id: videoId,
      privacy_status: privacy,
      publish_at: opts.publishAtUtc,
      path: "youtube_native",
    };
  }

  async deleteVideo(videoId: string, opts: { dryRun?: boolean } = {}) {
    const url = `${YOUTUBE_API}/videos?id=${encodeURIComponent(videoId)}`;
    return this.request("DELETE", url, { dryRun: opts.dryRun, planned: { id: videoId } });
  }
}

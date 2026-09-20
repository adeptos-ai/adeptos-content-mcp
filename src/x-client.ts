/**
 * X (Twitter) image posts — OAuth 1.0a user context.
 * Media: POST upload.twitter.com/1.1/media/upload.json
 * Tweet: POST api.twitter.com/2/tweets
 * No native schedule. Up to 4 images. Never log tokens.
 */

import { loadBrand, type BrandConfig } from "./brands.js";
import { fetchBytes } from "./http-media.js";
import { oauth1Header, type OAuth1Creds } from "./oauth1.js";
import { redactDeep, redactString, safeErrorMessage } from "./safety.js";
import type { BrandKey } from "./types.js";

export const X_UPLOAD = "https://upload.twitter.com/1.1/media/upload.json";
export const X_TWEETS = "https://api.twitter.com/2/tweets";

export class XApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(redactString(message));
    this.name = "XApiError";
  }
}

export type XPublishResult = {
  post_id: string;
  path: "x_tweets";
};

export class XClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly cfg: BrandConfig,
  ) {}

  static fromBrand(brand: BrandKey, fetchImpl: typeof fetch = fetch): XClient {
    return new XClient(fetchImpl, loadBrand(brand));
  }

  private creds(): OAuth1Creds {
    const apiKey = process.env.X_API_KEY?.trim();
    const apiSecret = process.env.X_API_SECRET?.trim();
    if (!apiKey || !apiSecret || !this.cfg.xAccessToken || !this.cfg.xAccessTokenSecret) {
      throw new Error("X OAuth 1.0a credentials incomplete");
    }
    return {
      apiKey,
      apiSecret,
      accessToken: this.cfg.xAccessToken,
      accessSecret: this.cfg.xAccessTokenSecret,
    };
  }

  async uploadImage(imageUrl: string, opts: { dryRun?: boolean } = {}): Promise<string> {
    if (opts.dryRun) return "dry_run_media";
    const { bytes, contentType } = await fetchBytes(imageUrl, this.fetchImpl);
    const creds = this.creds();
    const auth = oauth1Header("POST", X_UPLOAD, creds);
    const form = new FormData();
    form.append("media", new Blob([bytes as BlobPart], { type: contentType }), "canva.jpg");
    form.append("media_category", "tweet_image");
    let res: Response;
    try {
      res = await this.fetchImpl(X_UPLOAD, { method: "POST", headers: { Authorization: auth }, body: form });
    } catch (err) {
      throw new XApiError(`X media upload failed: ${safeErrorMessage(err)}`, 0, null);
    }
    const json = redactDeep((await res.json()) as { media_id_string?: string; errors?: unknown });
    if (!res.ok || !json.media_id_string) {
      throw new XApiError("X media upload returned no media_id", res.status, json);
    }
    return json.media_id_string;
  }

  async publishImages(
    opts: {
      imageUrls: string[];
      caption?: string;
      dryRun?: boolean;
    },
  ): Promise<XPublishResult | { dryRun: true; method: string; path: string; body?: Record<string, unknown> }> {
    if (opts.imageUrls.length < 1) throw new Error("X image post needs at least one image");
    if (opts.imageUrls.length > 4) throw new Error("X allows at most 4 images per post");
    const text = (opts.caption ?? "").slice(0, 280);
    if (opts.dryRun) {
      return {
        dryRun: true,
        method: "POST",
        path: X_TWEETS,
        body: { text, media_urls: opts.imageUrls },
      };
    }
    const mediaIds: string[] = [];
    for (const url of opts.imageUrls) {
      mediaIds.push(await this.uploadImage(url));
    }
    const creds = this.creds();
    const auth = oauth1Header("POST", X_TWEETS, creds);
    let res: Response;
    try {
      res = await this.fetchImpl(X_TWEETS, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text, media: { media_ids: mediaIds } }),
      });
    } catch (err) {
      throw new XApiError(`X tweet failed: ${safeErrorMessage(err)}`, 0, null);
    }
    const json = redactDeep((await res.json()) as { data?: { id?: string } });
    const id = json.data?.id;
    if (!res.ok || !id) throw new XApiError("X tweet create returned no id", res.status, json);
    return { post_id: id, path: "x_tweets" };
  }
}

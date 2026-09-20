/**
 * LinkedIn Posts API — organic image + MultiImage (Canva stills).
 * No native schedule. Never log tokens.
 */

import { loadBrand, type BrandConfig } from "./brands.js";
import { fetchBytes } from "./http-media.js";
import { redactDeep, redactString, safeErrorMessage } from "./safety.js";
import type { BrandKey } from "./types.js";

export const LINKEDIN_API = "https://api.linkedin.com/rest";

export class LinkedInApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(redactString(message));
    this.name = "LinkedInApiError";
  }
}

export type LinkedInPublishResult = {
  post_id: string;
  author: string;
  path: "linkedin_posts";
};

export class LinkedInClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly cfg: BrandConfig,
  ) {}

  static fromBrand(brand: BrandKey, fetchImpl: typeof fetch = fetch): LinkedInClient {
    return new LinkedInClient(fetchImpl, loadBrand(brand));
  }

  private version(): string {
    return process.env.LINKEDIN_VERSION?.trim() || "202507";
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.cfg.linkedinAccessToken;
    if (!token) throw new Error("LINKEDIN_ACCESS_TOKEN is not set");
    return {
      Authorization: `Bearer ${token}`,
      "Linkedin-Version": this.version(),
      "X-Restli-Protocol-Version": "2.0.0",
      ...extra,
    };
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      dryRun?: boolean;
      planned?: Record<string, unknown>;
      rawBody?: BodyInit;
    } = {},
  ): Promise<T | { dryRun: true; method: string; path: string; body?: Record<string, unknown> }> {
    if (opts.dryRun) {
      return { dryRun: true, method, path: url, body: opts.planned };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.headers(opts.headers),
        body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      });
    } catch (err) {
      throw new LinkedInApiError(`LinkedIn request failed: ${safeErrorMessage(err)}`, 0, null);
    }
    const text = await res.text();
    let parsed: unknown = text || null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: redactString(text) };
    }
    parsed = redactDeep(parsed);
    if (!res.ok) {
      const msg =
        typeof parsed === "object" && parsed && "message" in parsed
          ? String((parsed as { message: string }).message)
          : `LinkedIn API ${res.status}`;
      throw new LinkedInApiError(msg, res.status, parsed);
    }
    const restliId = res.headers.get("x-restli-id") || res.headers.get("X-RestLi-Id");
    if (restliId && (parsed == null || parsed === "")) {
      return { id: restliId } as T;
    }
    return parsed as T;
  }

  async uploadImage(imageUrl: string, opts: { dryRun?: boolean } = {}): Promise<string> {
    const owner = this.cfg.linkedinAuthorUrn;
    if (!owner) throw new Error("LinkedIn author URN missing");
    const init = await this.request<{ value?: { uploadUrl?: string; image?: string } }>(
      "POST",
      `${LINKEDIN_API}/images?action=initializeUpload`,
      {
        body: { initializeUploadRequest: { owner } },
        headers: { "Content-Type": "application/json" },
        dryRun: opts.dryRun,
        planned: { initializeUploadRequest: { owner }, source: imageUrl },
      },
    );
    if ("dryRun" in init) return "urn:li:image:dry_run";
    const uploadUrl = init.value?.uploadUrl;
    const imageUrn = init.value?.image;
    if (!uploadUrl || !imageUrn) throw new LinkedInApiError("initializeUpload missing uploadUrl/image", 502, init);
    const { bytes, contentType } = await fetchBytes(imageUrl, this.fetchImpl);
    const put = await this.fetchImpl(uploadUrl, {
      method: "PUT",
      headers: this.headers({ "Content-Type": contentType }),
      body: bytes as unknown as BodyInit,
    });
    if (!put.ok) {
      throw new LinkedInApiError(`LinkedIn image PUT failed (${put.status})`, put.status, redactString(await put.text()));
    }
    return imageUrn;
  }

  async publishImages(
    opts: {
      imageUrls: string[];
      caption?: string;
      dryRun?: boolean;
    },
  ): Promise<LinkedInPublishResult | { dryRun: true; method: string; path: string; body?: Record<string, unknown> }> {
    const author = this.cfg.linkedinAuthorUrn;
    if (!author) throw new Error("LinkedIn author URN missing");
    if (opts.imageUrls.length < 1) throw new Error("LinkedIn image post needs at least one image URL");
    if (opts.imageUrls.length > 20) throw new Error("LinkedIn MultiImage max is 20 images");

    if (opts.dryRun) {
      return {
        dryRun: true,
        method: "POST",
        path: `${LINKEDIN_API}/posts`,
        body: {
          author,
          commentary: opts.caption ?? "",
          images: opts.imageUrls,
          kind: opts.imageUrls.length > 1 ? "multiImage" : "media",
        },
      };
    }

    const urns: string[] = [];
    for (const url of opts.imageUrls) {
      urns.push(await this.uploadImage(url));
    }

    const content =
      urns.length === 1
        ? { media: { id: urns[0] } }
        : { multiImage: { images: urns.map((id) => ({ id })) } };

    const body = {
      author,
      commentary: opts.caption ?? "",
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content,
      lifecycleState: "PUBLISHED",
    };

    const res = await this.request<{ id?: string }>("POST", `${LINKEDIN_API}/posts`, {
      body,
      headers: { "Content-Type": "application/json" },
    });
    if ("dryRun" in res) return res;
    const id = res.id;
    if (!id) throw new LinkedInApiError("LinkedIn post create returned no id", 502, res);
    return { post_id: id, author, path: "linkedin_posts" };
  }
}

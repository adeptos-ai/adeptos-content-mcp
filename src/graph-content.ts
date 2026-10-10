/**
 * Instagram Content Publishing + Facebook Page feed helpers.
 * Graph has no native IG scheduled_publish_time — containers expire after ~24h,
 * so scheduled posts rebuild containers from stored media URLs at publish time.
 */

import { applyCollaborators, refuseStoriesCollaborators } from "./collaborators.js";
import { MetaApiError, type MetaClient } from "./meta-client.js";
import type { MediaType } from "./types.js";

export type ContainerStatus = {
  id: string;
  status_code?: string;
  status?: string;
};

export type GraphId = { id: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function detectMediaType(url: string, explicit?: MediaType): MediaType {
  if (explicit) return explicit;
  const clean = url.split("?")[0].toLowerCase();
  if (/\.(mp4|mov|m4v|webm)$/.test(clean)) return "video";
  return "photo";
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export type WaitForContainerOpts = {
  /** Total time to wait. Default 300s. */
  timeoutMs?: number;
  /** First poll delay. Grows x1.5 per poll up to maxIntervalMs. Default 3s. */
  intervalMs?: number;
  maxIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: (status: string, elapsedMs: number) => void;
  now?: () => number;
};

/**
 * Wait until an IG container is ready to publish.
 * Only FINISHED (or PUBLISHED) counts as ready. An empty status_code means Meta has not
 * processed the container yet, so it keeps polling, like IN_PROGRESS. ERROR/EXPIRED fail.
 */
export async function waitForContainer(
  client: MetaClient,
  containerId: string,
  opts: WaitForContainerOpts = {},
): Promise<ContainerStatus> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const maxIntervalMs = opts.maxIntervalMs ?? 15_000;
  const doSleep = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  let interval = opts.intervalMs ?? 3_000;
  const started = now();
  let last: ContainerStatus = { id: containerId };

  for (;;) {
    const data = (await client.get(containerId, {
      fields: "id,status_code,status",
    })) as ContainerStatus;
    last = { ...data, id: data.id ?? containerId };
    const code = (data.status_code ?? "").toUpperCase();
    opts.onPoll?.(code || "EMPTY", now() - started);
    if (code === "FINISHED" || code === "PUBLISHED") return last;
    if (code === "ERROR" || code === "EXPIRED") {
      const detail = data.status ? ` (${data.status})` : "";
      throw new MetaApiError(`IG container ${containerId} status_code=${code}${detail}`, 400, data);
    }
    if (now() - started >= timeoutMs) break;
    await doSleep(interval);
    interval = Math.min(maxIntervalMs, Math.max(interval, 1) * 1.5);
  }

  throw new MetaApiError(
    `Timed out waiting for IG container ${containerId} (last status_code=${last.status_code || "empty"})`,
    408,
    last,
  );
}

/** Meta says the container is not ready yet (code 9007 / subcode 2207027 and kin). Nothing was posted. */
export function isIgNotReadyError(err: unknown): boolean {
  if (err instanceof MetaApiError) {
    const e = (err.body as { error?: { code?: number; error_subcode?: number } } | null)?.error;
    if (e?.code === 9007 || e?.error_subcode === 2207027) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /media id is not available|not ready (for|to be) publish|media is not ready/i.test(message);
}

/** media_publish may have gone through (Meta reports the container PUBLISHED). Never retry it. */
export class IgPublishUncertainError extends Error {
  readonly noRebuild = true;
  constructor(
    message: string,
    public readonly containerId: string,
  ) {
    super(message);
    this.name = "IgPublishUncertainError";
  }
}

/** Mark an error from the publish stage so the outer retry does not rebuild containers. */
function noRebuild<T>(err: T): T {
  if (err && typeof err === "object") {
    try {
      (err as { noRebuild?: boolean }).noRebuild = true;
    } catch {
      /* frozen object */
    }
  }
  return err;
}

const TRANSIENT_PUBLISH_MESSAGE =
  /timed out|timeout|temporar|rate limit|too many calls|request limit|econnreset|etimedout|socket hang up|fetch failed|network|eai_again/i;

function isAmbiguousTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (TRANSIENT_PUBLISH_MESSAGE.test(message)) return true;
  if (err instanceof MetaApiError) {
    if (err.status === 0 || err.status === 408 || err.status === 429) return true;
    if (err.status >= 500 && err.status <= 599) return true;
  }
  return false;
}

export type PublishRetryOpts = {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  wait?: WaitForContainerOpts;
  log?: (event: string, extra: Record<string, unknown>) => void;
};

/**
 * media_publish with retries that can never double-post:
 * - "not ready" (9007/2207027): Meta refused, nothing posted. Wait for FINISHED again, retry.
 * - transport/5xx/timeout: ambiguous. Read the container first. PUBLISHED means it went out,
 *   so stop with IgPublishUncertainError (job goes to needs_review). Otherwise retry.
 * - anything else: fail.
 */
export async function publishIgContainerWithRetry(
  client: MetaClient,
  igUserId: string,
  creationId: string,
  opts: PublishRetryOpts = {},
): Promise<GraphId> {
  const max = Math.max(1, opts.maxAttempts ?? 5);
  const base = opts.baseDelayMs ?? 5_000;
  const doSleep = opts.sleep ?? sleep;
  const log = opts.log ?? (() => {});
  for (let attempt = 1; ; attempt++) {
    try {
      log("media_publish_attempt", { container_id: creationId, attempt, max });
      const published = (await publishIgContainer(client, igUserId, creationId)) as GraphId;
      log("media_publish_ok", { container_id: creationId, attempt, post_id: published?.id });
      return published;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const notReady = isIgNotReadyError(err);
      const ambiguous = !notReady && isAmbiguousTransportError(err);
      log("media_publish_failed", { container_id: creationId, attempt, max, error: message, not_ready: notReady, ambiguous });
      if (!notReady && !ambiguous) throw noRebuild(err);
      if (ambiguous) {
        let code = "";
        try {
          const st = (await client.get(creationId, { fields: "id,status_code" })) as ContainerStatus;
          code = (st.status_code ?? "").toUpperCase();
        } catch (readErr) {
          throw new IgPublishUncertainError(
            `ig_publish_uncertain: media_publish failed (${message}) and the container could not be read back (${readErr instanceof Error ? readErr.message : String(readErr)}). Check Instagram before retrying.`,
            creationId,
          );
        }
        if (code === "PUBLISHED") {
          throw new IgPublishUncertainError(
            `ig_publish_uncertain: media_publish errored (${message}) but container ${creationId} is PUBLISHED. The post is probably live; not retrying.`,
            creationId,
          );
        }
      }
      if (attempt >= max) throw noRebuild(err);
      const delay = base <= 0 ? 0 : base * 2 ** (attempt - 1);
      if (delay > 0) await doSleep(delay);
      if (notReady) await waitForContainer(client, creationId, { ...opts.wait, sleep: opts.wait?.sleep ?? doSleep });
    }
  }
}

export async function createIgImageContainer(
  client: MetaClient,
  igUserId: string,
  opts: {
    imageUrl: string;
    caption?: string;
    isCarouselItem?: boolean;
    collaborators?: string[];
    dryRun?: boolean;
  },
) {
  refuseStoriesCollaborators();
  const body: Record<string, unknown> = { image_url: opts.imageUrl };
  if (opts.isCarouselItem) body.is_carousel_item = true;
  else if (opts.caption) body.caption = opts.caption;
  // Collabs go on the feed/carousel parent, never on a carousel child.
  if (!opts.isCarouselItem) applyCollaborators(body, opts.collaborators);
  return client.post<GraphId>(`${igUserId}/media`, body, { dryRun: opts.dryRun });
}

export async function createIgVideoContainer(
  client: MetaClient,
  igUserId: string,
  opts: {
    videoUrl: string;
    caption?: string;
    isCarouselItem?: boolean;
    mediaType?: "video" | "reels";
    coverUrl?: string;
    shareToFeed?: boolean;
    collaborators?: string[];
    dryRun?: boolean;
  },
) {
  refuseStoriesCollaborators(opts.mediaType);
  const carousel = opts.isCarouselItem === true;
  const mediaType = carousel ? "VIDEO" : opts.mediaType === "video" ? "VIDEO" : "REELS";
  const body: Record<string, unknown> = {
    video_url: opts.videoUrl,
    media_type: mediaType,
  };
  if (carousel) body.is_carousel_item = true;
  else {
    if (opts.caption) body.caption = opts.caption;
    if (mediaType === "REELS") body.share_to_feed = opts.shareToFeed !== false;
    applyCollaborators(body, opts.collaborators);
  }
  if (opts.coverUrl) body.cover_url = opts.coverUrl;
  return client.post<GraphId>(`${igUserId}/media`, body, { dryRun: opts.dryRun });
}

export async function createIgCarouselContainer(
  client: MetaClient,
  igUserId: string,
  opts: { children: string[]; caption?: string; collaborators?: string[]; dryRun?: boolean },
) {
  if (opts.children.length < 2 || opts.children.length > 10) {
    throw new Error("carousel requires 2–10 child media_id values");
  }
  const body: Record<string, unknown> = {
    media_type: "CAROUSEL",
    children: opts.children,
  };
  if (opts.caption) body.caption = opts.caption;
  applyCollaborators(body, opts.collaborators);
  return client.post<GraphId>(`${igUserId}/media`, body, { dryRun: opts.dryRun });
}

export type IgMediaSpec = {
  media_type: MediaType;
  url: string;
  cover_url?: string;
};

function graphIdOf(value: unknown, what: string): string {
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "string" &&
    (value as { id: string }).id
  ) {
    return (value as { id: string }).id;
  }
  throw new Error(`Graph did not return ${what}`);
}

/**
 * Create IG container(s) from media URLs and publish them.
 * Carousel: each child (no caption, no collaborators) → wait FINISHED → parent with caption
 * and collaborators → wait FINISHED → media_publish.
 * Single image or video: create → wait FINISHED → media_publish.
 * Does not accept or reuse an existing container id.
 */
export async function publishIgFromSpec(
  client: MetaClient,
  igUserId: string,
  opts: {
    media: IgMediaSpec[];
    caption?: string;
    collaborators?: string[];
    waitForReady?: boolean;
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    publishMaxAttempts?: number;
    publishRetryBaseMs?: number;
    log?: (event: string, extra: Record<string, unknown>) => void;
  },
): Promise<{ id: string; container_id: string }> {
  const media = opts.media.filter((item) => item.url?.trim());
  if (media.length === 0) {
    throw new Error(
      "ig_rebuild_missing_media: scheduled Instagram post has no media URLs. Refusing to reuse a stored container id (containers expire after ~24h).",
    );
  }
  if (media.length > 10) throw new Error("IG carousel requires 2–10 media items");

  const wait = opts.waitForReady !== false;
  const log = opts.log ?? (() => {});
  const waitFor = (id: string, role: string) =>
    waitForContainer(client, id, {
      timeoutMs: opts.timeoutMs ?? 300_000,
      intervalMs: opts.intervalMs ?? 3_000,
      sleep: opts.sleep,
    }).then((st) => {
      log("container_ready", { container_id: id, role, status_code: st.status_code });
      return st;
    });

  let creationId: string;
  if (media.length === 1) {
    const item = media[0];
    const created =
      item.media_type === "photo"
        ? await createIgImageContainer(client, igUserId, {
            imageUrl: item.url,
            caption: opts.caption,
            collaborators: opts.collaborators,
          })
        : await createIgVideoContainer(client, igUserId, {
            videoUrl: item.url,
            caption: opts.caption,
            mediaType: item.media_type === "video" ? "video" : "reels",
            coverUrl: item.cover_url,
            collaborators: opts.collaborators,
          });
    creationId = graphIdOf(created, "an IG container id");
    log("container_created", { container_id: creationId, role: "single" });
    if (wait) await waitFor(creationId, "single");
  } else {
    const childIds: string[] = [];
    for (const item of media) {
      const created =
        item.media_type === "photo"
          ? await createIgImageContainer(client, igUserId, {
              imageUrl: item.url,
              isCarouselItem: true,
            })
          : await createIgVideoContainer(client, igUserId, {
              videoUrl: item.url,
              isCarouselItem: true,
              coverUrl: item.cover_url,
              mediaType: "video",
            });
      const childId = graphIdOf(created, "a carousel child container id");
      log("container_created", { container_id: childId, role: "child", index: childIds.length + 1 });
      childIds.push(childId);
    }
    // Wait on every child before building the parent (children are created first so Meta can
    // process them in parallel).
    if (wait) for (const childId of childIds) await waitFor(childId, "child");
    const parent = await createIgCarouselContainer(client, igUserId, {
      children: childIds,
      caption: opts.caption,
      collaborators: opts.collaborators,
    });
    creationId = graphIdOf(parent, "a carousel container id");
    log("container_created", { container_id: creationId, role: "carousel", children: childIds.length });
    if (wait) await waitFor(creationId, "carousel");
  }

  const published = await publishIgContainerWithRetry(client, igUserId, creationId, {
    maxAttempts: opts.publishMaxAttempts,
    baseDelayMs: opts.publishRetryBaseMs,
    sleep: opts.sleep,
    wait: { timeoutMs: opts.timeoutMs ?? 300_000, intervalMs: opts.intervalMs ?? 3_000, sleep: opts.sleep },
    log,
  });
  return { id: graphIdOf(published, "an IG media id"), container_id: creationId };
}

export async function publishIgContainer(
  client: MetaClient,
  igUserId: string,
  creationId: string,
  opts: { dryRun?: boolean } = {},
) {
  return client.post<GraphId>(`${igUserId}/media_publish`, { creation_id: creationId }, { dryRun: opts.dryRun });
}

export async function getIgUser(
  client: MetaClient,
  igUserId: string,
): Promise<{ id: string; name?: string; username?: string }> {
  return (await client.get(igUserId, { fields: "id,name,username" })) as {
    id: string;
    name?: string;
    username?: string;
  };
}

/** Page metadata. Response stays redacted (access_token comes back as "[REDACTED]"); use getPageToken() for the token. */
export async function getPage(
  client: MetaClient,
  pageId: string,
): Promise<{ id: string; name?: string; access_token?: string; instagram_business_account?: { id: string } }> {
  return (await client.get(pageId, {
    fields: "id,name,access_token,instagram_business_account",
  })) as {
    id: string;
    name?: string;
    access_token?: string;
    instagram_business_account?: { id: string };
  };
}

export async function getPageToken(client: MetaClient, pageId: string): Promise<string> {
  // raw:true — the body carries the Page token we need; default redaction would return "[REDACTED]".
  // The raw body never leaves this function; only the token string goes to client.withToken().
  const page = (await client.get(pageId, { fields: "id,access_token" }, { raw: true })) as {
    id?: string;
    access_token?: string;
  };
  const token = typeof page?.access_token === "string" ? page.access_token.trim() : "";
  if (!token || token.startsWith("[REDACTED")) {
    throw new Error(
      `No Page access token for ${pageId}. System User needs pages_manage_posts on this Page.`,
    );
  }
  return token;
}

export async function publishFbPhoto(
  client: MetaClient,
  pageId: string,
  opts: {
    url: string;
    caption?: string;
    scheduledUnix?: number;
    dryRun?: boolean;
    pageToken?: string;
  },
) {
  const pageClient = opts.pageToken ? client.withToken(opts.pageToken) : client;
  const body: Record<string, unknown> = { url: opts.url };
  if (opts.caption) body.caption = opts.caption;
  if (opts.scheduledUnix) {
    body.published = false;
    body.scheduled_publish_time = opts.scheduledUnix;
    body.unpublished_content_type = "SCHEDULED";
  }
  return pageClient.post<GraphId>(`${pageId}/photos`, body, { dryRun: opts.dryRun });
}

export async function publishFbVideo(
  client: MetaClient,
  pageId: string,
  opts: {
    fileUrl: string;
    description?: string;
    scheduledUnix?: number;
    dryRun?: boolean;
    pageToken?: string;
  },
) {
  const pageClient = opts.pageToken ? client.withToken(opts.pageToken) : client;
  const body: Record<string, unknown> = { file_url: opts.fileUrl };
  if (opts.description) body.description = opts.description;
  if (opts.scheduledUnix) {
    body.published = false;
    body.scheduled_publish_time = opts.scheduledUnix;
    body.unpublished_content_type = "SCHEDULED";
  }
  return pageClient.post<GraphId>(`${pageId}/videos`, body, { dryRun: opts.dryRun });
}

export async function publishFbCarousel(
  client: MetaClient,
  pageId: string,
  opts: {
    urls: string[];
    message?: string;
    scheduledUnix?: number;
    dryRun?: boolean;
    pageToken?: string;
  },
) {
  const pageClient = opts.pageToken ? client.withToken(opts.pageToken) : client;

  const unpublished: string[] = [];
  for (const url of opts.urls) {
    const photo = (await pageClient.post<GraphId>(
      `${pageId}/photos`,
      {
        url,
        published: false,
        temporary: true,
      },
      { dryRun: opts.dryRun },
    )) as GraphId | { dryRun: true };
    if ("dryRun" in photo) {
      unpublished.push("dry_run_photo");
    } else if (photo.id) {
      unpublished.push(photo.id);
    }
  }

  const body: Record<string, unknown> = {
    message: opts.message ?? "",
    attached_media: unpublished.map((id) => ({ media_fbid: id })),
  };
  if (opts.scheduledUnix) {
    body.published = false;
    body.scheduled_publish_time = opts.scheduledUnix;
    body.unpublished_content_type = "SCHEDULED";
  }
  return pageClient.post<GraphId>(`${pageId}/feed`, body, { dryRun: opts.dryRun });
}

export async function listFbScheduled(client: MetaClient, pageId: string, pageToken?: string) {
  const pageClient = pageToken ? client.withToken(pageToken) : client;
  return pageClient.get(`${pageId}/scheduled_posts`, {
    fields: "id,message,created_time,scheduled_publish_time,is_published,status_type",
    limit: 50,
  });
}

export async function cancelFbPost(
  client: MetaClient,
  postId: string,
  opts: { dryRun?: boolean; pageToken?: string } = {},
) {
  const pageClient = opts.pageToken ? client.withToken(opts.pageToken) : client;
  return pageClient.delete(postId, { dryRun: opts.dryRun });
}

export type ContentPublishingLimit = {
  quota_usage?: number;
  config?: { quota_total?: number; quota_duration?: number };
};

export async function getPublishingLimit(client: MetaClient, igUserId: string) {
  return client.get(`${igUserId}/content_publishing_limit`, {
    fields: "config,quota_usage",
  });
}

export type IgCollaboratorInvite = {
  id?: string;
  username?: string;
  invite_status?: string;
};

/** GET /{ig-media-id}/collaborators — invite status after publish. */
export async function listIgCollaborators(client: MetaClient, igMediaId: string) {
  return client.get<{ data?: IgCollaboratorInvite[] }>(`${igMediaId}/collaborators`, {
    fields: "id,username,invite_status",
  });
}

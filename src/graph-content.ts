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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function detectMediaType(url: string, explicit?: MediaType): MediaType {
  if (explicit) return explicit;
  const clean = url.split("?")[0].toLowerCase();
  if (/\.(mp4|mov|m4v|webm)$/.test(clean)) return "video";
  return "photo";
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export async function waitForContainer(
  client: MetaClient,
  containerId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ContainerStatus> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const started = Date.now();
  let last: ContainerStatus = { id: containerId };

  while (Date.now() - started < timeoutMs) {
    const data = (await client.get(containerId, {
      fields: "id,status_code,status",
    })) as ContainerStatus;
    last = { ...data, id: data.id ?? containerId };
    const code = (data.status_code ?? "").toUpperCase();
    if (!code || code === "FINISHED" || code === "PUBLISHED") return last;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new MetaApiError(
        `IG container ${containerId} status_code=${code}`,
        400,
        data,
      );
    }
    await sleep(intervalMs);
  }

  throw new MetaApiError(
    `Timed out waiting for IG container ${containerId} (last status_code=${last.status_code ?? "unknown"})`,
    408,
    last,
  );
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
  const waitOpts = {
    timeoutMs: opts.timeoutMs ?? 180_000,
    intervalMs: opts.intervalMs ?? 3_000,
  };

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
    if (wait) await waitForContainer(client, creationId, waitOpts);
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
      if (wait) await waitForContainer(client, childId, waitOpts);
      childIds.push(childId);
    }
    const parent = await createIgCarouselContainer(client, igUserId, {
      children: childIds,
      caption: opts.caption,
      collaborators: opts.collaborators,
    });
    creationId = graphIdOf(parent, "a carousel container id");
    if (wait) await waitForContainer(client, creationId, waitOpts);
  }

  const published = await publishIgContainer(client, igUserId, creationId);
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

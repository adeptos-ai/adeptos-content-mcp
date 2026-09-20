import {
  assertSameBrand,
  loadAllBrands,
  loadBrand,
  requireLinkedIn,
  requireMetaIg,
  requireMetaPage,
  requireTikTok,
  requireX,
  requireYouTube,
  resolveBrand,
  type BrandConfig,
} from "./brands.js";
import { collaboratorsForIgOnly, normalizeCollaborators, refuseStoriesCollaborators } from "./collaborators.js";
import {
  createIgCarouselContainer,
  createIgImageContainer,
  createIgVideoContainer,
  detectMediaType,
  getIgUser,
  getPage,
  getPageToken,
  listFbScheduled,
  listIgCollaborators,
  publishFbCarousel,
  publishFbPhoto,
  publishFbVideo,
  publishIgContainer,
  waitForContainer,
} from "./graph-content.js";
import { resolveSource } from "./http-media.js";
import { LinkedInClient } from "./linkedin-client.js";
import { limitsList } from "./media-limits.js";
import { createMetaClientFromEnv, createMetaClientOptional, type MetaClient } from "./meta-client.js";
import { normalizePlatforms, schedulePathFor } from "./platforms.js";
import { requireConfirm, type WriteSafetyArgs } from "./safety.js";
import { MediaRegistry, ScheduleStore, newScheduleId } from "./store.js";
import { TikTokClient } from "./tiktok-client.js";
import { formatBogota, formatUtc, parsePublishAt, toUnixSeconds } from "./timezone.js";
import type {
  BrandAccount,
  BrandKey,
  MediaRecord,
  MediaType,
  PlatformAccount,
  PlatformResult,
  PreviewResult,
  PublishPlatform,
  ScheduleJob,
} from "./types.js";
import { XClient } from "./x-client.js";
import { YouTubeClient } from "./youtube-client.js";

export type ServiceDeps = {
  client?: MetaClient | null;
  media?: MediaRegistry;
  schedules?: ScheduleStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  waitForReady?: boolean;
};

function mediaStore(deps?: ServiceDeps): MediaRegistry {
  return deps?.media ?? MediaRegistry.create();
}
function scheduleStore(deps?: ServiceDeps): ScheduleStore {
  return deps?.schedules ?? ScheduleStore.create();
}
function fetchImpl(deps?: ServiceDeps): typeof fetch {
  return deps?.fetchImpl ?? fetch;
}
function metaClient(deps?: ServiceDeps): MetaClient {
  if (deps?.client) return deps.client;
  if (deps && "client" in deps && deps.client === null) {
    throw new Error("META_ACCESS_TOKEN is not set. Leonardo owns token mint (Rec0C3QKVTL0Y).");
  }
  return createMetaClientFromEnv(deps?.fetchImpl);
}

function platformRow(
  platform: PublishPlatform,
  id: string | null,
  missing: string[],
  extras: Partial<PlatformAccount> = {},
): PlatformAccount {
  return {
    platform,
    id,
    publish_ready: missing.length === 0 && extras.publish_ready !== false,
    missing,
    ...extras,
  };
}

export async function listAccounts(opts: { brand?: string } = {}, deps: ServiceDeps = {}) {
  const brands = opts.brand ? [loadBrand(resolveBrand(opts.brand))] : loadAllBrands();
  const client = deps.client === undefined ? createMetaClientOptional(deps.fetchImpl) : deps.client;
  const accounts: BrandAccount[] = [];

  for (const cfg of brands) {
    const platforms: PlatformAccount[] = [
      platformRow("meta_ig", cfg.igUserId, cfg.missingMeta.filter((m) => !m.includes("PAGE_ID"))),
      platformRow("meta_fb", cfg.pageId, cfg.missingMeta.filter((m) => !m.includes("IG_USER"))),
      platformRow("tiktok", cfg.tiktokOpenId, cfg.missingTikTok),
      platformRow("youtube", cfg.youtubeChannelId, cfg.missingYouTube, {
        note: "Community/image posts are not in YouTube Data API v3 — short mp4 only",
      }),
      platformRow("linkedin", cfg.linkedinAuthorUrn, cfg.missingLinkedIn),
      platformRow("x", cfg.xUserId, cfg.missingX),
    ];

    if (client && cfg.igUserId) {
      try {
        const ig = await getIgUser(client, cfg.igUserId);
        const igRow = platforms.find((p) => p.platform === "meta_ig");
        if (igRow) {
          igRow.username = ig.username;
          igRow.name = ig.name;
          igRow.publish_ready = true;
        }
      } catch (err) {
        const igRow = platforms.find((p) => p.platform === "meta_ig");
        if (igRow) {
          igRow.publish_ready = false;
          igRow.error = err instanceof Error ? err.message : String(err);
        }
      }
    }
    if (client && cfg.pageId) {
      try {
        const page = await getPage(client, cfg.pageId);
        const fb = platforms.find((p) => p.platform === "meta_fb");
        if (fb) fb.name = page.name;
      } catch {
        /* listing names is best-effort */
      }
    }

    const missing = [...new Set(platforms.flatMap((p) => p.missing))];
    accounts.push({
      brand: cfg.brand,
      name: cfg.name,
      platforms,
      ig_user_id: cfg.igUserId,
      page_id: cfg.pageId,
      publish_ready: platforms.some((p) => p.publish_ready),
      missing,
    });
  }

  return {
    lane: "canva_posts",
    opus_clip: "clips",
    note: "Opus Clip = clips; Content MCP = Canva photos/carousels/posts to the same destinations.",
    timezone: "America/Bogota",
    entity: "ADEPTOS AI LLC",
    accounts,
    limits: limitsList(),
  };
}

export async function uploadMedia(
  args: {
    brand: string;
    image_url?: string;
    video_url?: string;
    file_path?: string;
    is_carousel_item?: boolean;
    media_type?: MediaType;
    caption?: string;
    cover_url?: string;
    platforms?: string[];
    collaborators?: string[];
  },
  deps: ServiceDeps = {},
) {
  const brand = resolveBrand(args.brand);
  const { url, mediaType: detected } = resolveSource(args);
  const mediaType = args.media_type ?? detected;
  refuseStoriesCollaborators(mediaType);
  const isCarousel = args.is_carousel_item === true;
  const platforms = args.platforms?.length ? normalizePlatforms({ platforms: args.platforms }) : undefined;
  const wantsIg = !platforms || platforms.includes("meta_ig");
  const collab = normalizeCollaborators(args.collaborators);
  const igCollabs = !isCarousel ? collaboratorsForIgOnly(platforms, collab.usernames).ig : [];

  let mediaId = `med_${brand}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  let igUserId: string | undefined;

  if (wantsIg) {
    const cfg = requireMetaIg(brand);
    igUserId = cfg.igUserId!;
    const client = metaClient(deps);
    const created =
      mediaType === "photo"
        ? await createIgImageContainer(client, igUserId, {
            imageUrl: url,
            caption: isCarousel ? undefined : args.caption,
            isCarouselItem: isCarousel,
            collaborators: igCollabs,
          })
        : await createIgVideoContainer(client, igUserId, {
            videoUrl: url,
            caption: isCarousel ? undefined : args.caption,
            isCarouselItem: isCarousel,
            mediaType: mediaType === "reels" ? "reels" : "video",
            coverUrl: args.cover_url,
            collaborators: igCollabs,
          });
    if (!("dryRun" in created) && created.id) mediaId = created.id;
    if (deps.waitForReady !== false && mediaType !== "photo") {
      await waitForContainer(client, mediaId, { timeoutMs: 180_000 });
    }
  }

  const record = mediaStore(deps).put({
    media_id: mediaId,
    brand,
    media_type: mediaType,
    url,
    is_carousel_item: isCarousel,
    created_at: new Date().toISOString(),
    ig_user_id: igUserId,
    platforms,
    collaborators: igCollabs.length ? igCollabs : undefined,
  });

  return {
    media_id: mediaId,
    brand,
    media_type: mediaType,
    is_carousel_item: isCarousel,
    url,
    ig_user_id: igUserId,
    collaborators: igCollabs.length ? igCollabs : undefined,
    container: record,
    warnings: [
      ...collab.warnings,
      ...(isCarousel && collab.usernames.length
        ? ["Collaborators on a carousel child are ignored — pass them to content_create_carousel."]
        : []),
    ],
  };
}

export async function createCarousel(
  args: { brand: string; media_ids: string[]; caption?: string; collaborators?: string[] },
  deps: ServiceDeps = {},
) {
  const brand = resolveBrand(args.brand);
  const cfg = requireMetaIg(brand);
  const ids = args.media_ids.map((id) => id.trim()).filter(Boolean);
  if (ids.length < 2 || ids.length > 10) throw new Error("IG carousel requires 2–10 child media_id values");
  const collab = normalizeCollaborators(args.collaborators);

  const registry = mediaStore(deps);
  const children = ids.map((id) => {
    const rec = registry.get(id);
    if (rec) assertSameBrand(brand, rec.brand, id);
    return rec;
  });

  const client = metaClient(deps);
  if (deps.waitForReady !== false) {
    for (const id of ids) await waitForContainer(client, id, { timeoutMs: 180_000 });
  }
  const created = await createIgCarouselContainer(client, cfg.igUserId!, {
    children: ids,
    caption: args.caption,
    collaborators: collab.usernames,
  });
  if ("dryRun" in created) return created;
  const containerId = created.id;
  if (!containerId) throw new Error("Graph did not return a carousel container id");

  registry.put({
    media_id: containerId,
    brand,
    ig_user_id: cfg.igUserId!,
    media_type: "photo",
    url: children.find((m) => m)?.url ?? "",
    is_carousel_item: false,
    created_at: new Date().toISOString(),
    child_ids: ids,
    child_urls: children.map((c) => c?.url).filter((u): u is string => Boolean(u)),
    collaborators: collab.usernames.length ? collab.usernames : undefined,
  });

  return {
    container_id: containerId,
    brand,
    media_ids: ids,
    caption: args.caption ?? "",
    collaborators: collab.usernames.length ? collab.usernames : undefined,
    warnings: collab.warnings,
    note: "Carousel container is Meta IG only. Other nets assemble MultiImage/tweet media from the same child URLs at publish.",
  };
}

type ResolvedMedia = { media_type: MediaType; url: string; media_id?: string };

function resolveJobMedia(
  args: {
    brand: BrandKey;
    container_id?: string;
    media_id?: string;
    media_ids?: string[];
    image_url?: string;
    video_url?: string;
  },
  registry: MediaRegistry,
): { containerId?: string; media: ResolvedMedia[] } {
  const media: ResolvedMedia[] = [];
  const ids = [
    ...(args.media_ids ?? []),
    args.media_id,
    args.container_id,
  ].filter((v, i, a): v is string => Boolean(v) && a.indexOf(v) === i);

  for (const id of ids) {
    const rec = registry.get(id);
    if (rec) {
      assertSameBrand(args.brand, rec.brand, id);
      if (rec.child_urls?.length) {
        for (const url of rec.child_urls) media.push({ media_type: "photo", url, media_id: id });
      } else if (rec.url) {
        media.push({ media_type: rec.media_type, url: rec.url, media_id: rec.media_id });
      }
    }
  }
  if (args.image_url) media.push({ media_type: "photo", url: args.image_url.trim() });
  if (args.video_url) media.push({ media_type: detectMediaType(args.video_url, "video"), url: args.video_url.trim() });

  return { containerId: args.container_id || args.media_id, media };
}

export async function schedulePost(
  args: {
    brand: string;
    platforms?: string[];
    platform?: string;
    also_post_fb?: boolean;
    container_id?: string;
    media_id?: string;
    media_ids?: string[];
    image_url?: string;
    video_url?: string;
    publish_at?: string;
    publish_now?: boolean;
    caption?: string;
    title?: string;
    collaborators?: string[];
    confirm?: boolean;
    dryRun?: boolean;
  } & WriteSafetyArgs,
  deps: ServiceDeps = {},
) {
  const brand = resolveBrand(args.brand);
  const targets = normalizePlatforms(args);
  const now = deps.now?.() ?? new Date();
  const warnings: string[] = [];
  const registry = mediaStore(deps);
  const { containerId, media } = resolveJobMedia({ ...args, brand }, registry);
  if (!containerId && media.length === 0) {
    throw new Error("Provide container_id, media_id(s), image_url, or video_url (Canva export HTTPS).");
  }

  let publishAtUtc: Date;
  let publishAtBogota: string;
  if (args.publish_now) {
    publishAtUtc = now;
    publishAtBogota = formatBogota(now);
  } else {
    if (!args.publish_at) throw new Error("Provide publish_at (ISO, America/Bogotá if naive) or publish_now:true");
    const parsed = parsePublishAt(args.publish_at, now);
    publishAtUtc = parsed.utc;
    publishAtBogota = parsed.bogotaIso;
    warnings.push(...parsed.warnings);
  }

  const perPlatform = targets.map((platform) => {
    const photos = media.filter((m) => m.media_type === "photo");
    const videos = media.filter((m) => m.media_type !== "photo");
    let warning: string | undefined;
    if (platform === "youtube" && photos.length && !videos.length) {
      warning =
        "youtube_community_unsupported: YouTube Data API v3 has no Community/image post. Skip YouTube for this Canva still; Opus Clip / short mp4 for video.";
    }
    if (platform === "x" && (args.caption ?? "").length > 280) {
      warning = "X caption will be truncated to 280 characters.";
    }
    return {
      platform,
      path: schedulePathFor(platform, args.publish_now === true),
      media_count: media.length,
      warning,
    };
  });

  const collab = normalizeCollaborators(args.collaborators);
  const { ig: igCollaborators, ignoredWarning } = collaboratorsForIgOnly(targets, collab.usernames);
  if (ignoredWarning) warnings.push(ignoredWarning);
  warnings.push(...collab.warnings);
  if (igCollaborators.length && !targets.includes("meta_ig")) {
    warnings.push("collaborators apply only to Instagram (meta_ig). Other platforms ignore them.");
  }

  const plan = {
    brand,
    platforms: targets,
    caption: args.caption,
    title: args.title,
    publish_now: args.publish_now === true,
    publish_at_utc: formatUtc(publishAtUtc),
    publish_at_bogota: publishAtBogota,
    media,
    container_id: containerId,
    collaborators: igCollaborators.length ? igCollaborators : undefined,
    per_platform: perPlatform,
    note: "Opus Clip = clips. Content MCP = Canva photos/carousels/posts.",
  };

  const gate = requireConfirm(args);
  if (gate.mode === "preview") {
    const preview: PreviewResult = {
      dry_run: true,
      confirm_required: true,
      action: args.publish_now ? "publish_now" : "schedule_post",
      plan,
      warnings: [...warnings, ...perPlatform.map((p) => p.warning).filter((w): w is string => Boolean(w))],
    };
    return preview;
  }

  const results: PlatformResult[] = [];
  for (const platform of targets) {
    try {
      results.push(
        await executePlatform({
          platform,
          brand,
          media,
          containerId,
          caption: args.caption,
          title: args.title,
          collaborators: igCollaborators,
          publishNow: args.publish_now === true,
          publishAtUtc,
          publishAtBogota,
          dryRun: gate.dryRun,
          deps,
          registry,
        }),
      );
    } catch (err) {
      results.push({
        platform,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    brand,
    publish_at_utc: formatUtc(publishAtUtc),
    publish_at_bogota: publishAtBogota,
    dry_run: gate.dryRun || undefined,
    results,
    warnings,
  };
}

async function executePlatform(opts: {
  platform: PublishPlatform;
  brand: BrandKey;
  media: ResolvedMedia[];
  containerId?: string;
  caption?: string;
  title?: string;
  collaborators?: string[];
  publishNow: boolean;
  publishAtUtc: Date;
  publishAtBogota: string;
  dryRun: boolean;
  deps: ServiceDeps;
  registry: MediaRegistry;
}): Promise<PlatformResult> {
  const { platform, brand, media, publishNow, dryRun } = opts;
  const photos = media.filter((m) => m.media_type === "photo").map((m) => m.url);
  const videos = media.filter((m) => m.media_type !== "photo");
  const path = schedulePathFor(platform, publishNow);

  if (platform === "youtube" && photos.length && !videos.length) {
    return {
      platform,
      status: "skipped",
      error: "youtube_community_unsupported",
      note: "YouTube Data API v3 cannot create Community/image posts. Short mp4 uploads are supported.",
    };
  }

  if (!publishNow && path === "mcp_cron") {
    if (dryRun) {
      return { platform, status: "planned", path, note: `Would store mcp_cron job for ${platform}` };
    }
    const job: ScheduleJob = {
      id: newScheduleId(),
      brand,
      platform,
      status: "scheduled",
      path: "mcp_cron",
      publish_at_utc: formatUtc(opts.publishAtUtc),
      publish_at_bogota: opts.publishAtBogota,
      caption: opts.caption,
      title: opts.title,
      container_id: opts.containerId,
      media_ids: media.map((m) => m.media_id).filter((id): id is string => Boolean(id)),
      media,
      also_post_fb: platform === "meta_fb",
      collaborators: opts.collaborators?.length ? opts.collaborators : undefined,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      confirm: true,
    };
    scheduleStore(opts.deps).insert(job);
    return {
      platform,
      status: "scheduled",
      path: "mcp_cron",
      schedule_id: job.id,
      collaborators: job.collaborators,
    };
  }

  if (dryRun) {
    return {
      platform,
      status: "planned",
      path,
      note: `Would publish now / native-schedule on ${platform}`,
      collaborators: platform === "meta_ig" ? opts.collaborators : undefined,
    };
  }

  if (platform === "meta_ig") {
    const cfg = requireMetaIg(brand);
    const client = metaClient(opts.deps);
    let creation = opts.containerId;
    if (!creation) {
      const first = media[0];
      const uploaded = await uploadMedia(
        {
          brand,
          image_url: first.media_type === "photo" ? first.url : undefined,
          video_url: first.media_type !== "photo" ? first.url : undefined,
          media_type: first.media_type,
          caption: opts.caption,
          platforms: ["meta_ig"],
          collaborators: opts.collaborators,
        },
        opts.deps,
      );
      creation = uploaded.media_id;
    }
    if (opts.deps.waitForReady !== false) {
      await waitForContainer(client, creation, { timeoutMs: 180_000 });
    }
    const published = (await publishIgContainer(client, cfg.igUserId!, creation)) as { id?: string };
    let invites: PlatformResult["collaborator_invites"];
    if (published.id && opts.collaborators?.length) {
      try {
        const listed = (await listIgCollaborators(client, published.id)) as { data?: PlatformResult["collaborator_invites"] };
        invites = listed.data;
      } catch {
        invites = opts.collaborators.map((username) => ({ username, invite_status: "unknown" }));
      }
    }
    return {
      platform,
      status: "published",
      path: "graph_native",
      post_id: published.id,
      collaborators: opts.collaborators?.length ? opts.collaborators : undefined,
      collaborator_invites: invites,
    };
  }

  if (platform === "meta_fb") {
    return publishFacebook(opts, photos, videos, path);
  }

  if (platform === "tiktok") {
    requireTikTok(brand);
    const tt = TikTokClient.fromBrand(brand, fetchImpl(opts.deps));
    if (videos[0]) {
      const res = await tt.directPostVideo({ videoUrl: videos[0].url, caption: opts.caption });
      if ("dryRun" in res) return { platform, status: "planned", path: "tiktok_direct_post" };
      return { platform, status: "published", path: "tiktok_direct_post", post_id: res.publish_id };
    }
    const res = await tt.directPostPhoto({ imageUrls: photos, caption: opts.caption });
    if ("dryRun" in res) return { platform, status: "planned", path: "tiktok_direct_post" };
    return { platform, status: "published", path: "tiktok_direct_post", post_id: res.publish_id };
  }

  if (platform === "youtube") {
    requireYouTube(brand);
    const yt = YouTubeClient.fromBrand(brand, fetchImpl(opts.deps));
    const videoUrl = videos[0]?.url;
    if (!videoUrl) {
      return { platform, status: "skipped", error: "youtube_community_unsupported" };
    }
    const res = await yt.uploadVideo({
      videoUrl,
      title: (opts.title || opts.caption || "Canva export").slice(0, 100),
      description: opts.caption,
      publishAtUtc: publishNow ? undefined : formatUtc(opts.publishAtUtc),
    });
    if ("dryRun" in res) return { platform, status: "planned", path: "youtube_native" };
    if (!publishNow) {
      const job: ScheduleJob = {
        id: newScheduleId(),
        brand,
        platform,
        status: "scheduled",
        path: "youtube_native",
        publish_at_utc: formatUtc(opts.publishAtUtc),
        publish_at_bogota: opts.publishAtBogota,
        caption: opts.caption,
        title: opts.title,
        media,
        also_post_fb: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        post_id: res.video_id,
        confirm: true,
      };
      scheduleStore(opts.deps).insert(job);
      return { platform, status: "scheduled", path: "youtube_native", schedule_id: job.id, post_id: res.video_id };
    }
    return { platform, status: "published", path: "youtube_native", post_id: res.video_id };
  }

  if (platform === "linkedin") {
    requireLinkedIn(brand);
    const li = LinkedInClient.fromBrand(brand, fetchImpl(opts.deps));
    const urls = photos.length ? photos : videos.map((v) => v.url);
    const res = await li.publishImages({ imageUrls: urls, caption: opts.caption });
    if ("dryRun" in res) return { platform, status: "planned", path: "linkedin_posts" };
    return { platform, status: "published", path: "linkedin_posts", post_id: res.post_id };
  }

  if (platform === "x") {
    requireX(brand);
    const xc = XClient.fromBrand(brand, fetchImpl(opts.deps));
    const urls = photos.slice(0, 4);
    if (!urls.length) throw new Error("X image post needs photo URLs (Canva stills). Video tweets not in this Canva lane.");
    const res = await xc.publishImages({ imageUrls: urls, caption: opts.caption });
    if ("dryRun" in res) return { platform, status: "planned", path: "x_tweets" };
    return { platform, status: "published", path: "x_tweets", post_id: res.post_id };
  }

  return { platform, status: "error", error: `unhandled platform ${platform}` };
}

async function publishFacebook(
  opts: {
    brand: BrandKey;
    caption?: string;
    publishNow: boolean;
    publishAtUtc: Date;
    publishAtBogota: string;
    deps: ServiceDeps;
  },
  photos: string[],
  videos: ResolvedMedia[],
  path: ScheduleJob["path"],
): Promise<PlatformResult> {
  const cfg = requireMetaPage(opts.brand);
  const client = metaClient(opts.deps);
  const pageToken = await getPageToken(client, cfg.pageId!);
  const scheduledUnix = opts.publishNow ? undefined : toUnixSeconds(opts.publishAtUtc);
  let result: { id?: string };
  if (photos.length > 1) {
    result = (await publishFbCarousel(client, cfg.pageId!, {
      urls: photos,
      message: opts.caption,
      scheduledUnix,
      pageToken,
    })) as { id?: string };
  } else if (photos[0]) {
    result = (await publishFbPhoto(client, cfg.pageId!, {
      url: photos[0],
      caption: opts.caption,
      scheduledUnix,
      pageToken,
    })) as { id?: string };
  } else if (videos[0]) {
    result = (await publishFbVideo(client, cfg.pageId!, {
      fileUrl: videos[0].url,
      description: opts.caption,
      scheduledUnix,
      pageToken,
    })) as { id?: string };
  } else {
    throw new Error("Facebook Page post needs a photo or video URL");
  }
  if (!opts.publishNow) {
    const job: ScheduleJob = {
      id: newScheduleId(),
      brand: opts.brand,
      platform: "meta_fb",
      status: "scheduled",
      path: "graph_native",
      publish_at_utc: formatUtc(opts.publishAtUtc),
      publish_at_bogota: opts.publishAtBogota,
      caption: opts.caption,
      media: photos.map((url) => ({ media_type: "photo" as const, url })),
      also_post_fb: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      post_id: result.id,
      confirm: true,
    };
    scheduleStore(opts.deps).insert(job);
    return { platform: "meta_fb", status: "scheduled", path, schedule_id: job.id, post_id: result.id };
  }
  return { platform: "meta_fb", status: "published", path, post_id: result.id };
}

export async function listScheduled(opts: { brand?: string } = {}, deps: ServiceDeps = {}) {
  const brand = opts.brand ? resolveBrand(opts.brand) : undefined;
  const local = scheduleStore(deps).list(brand ? { brand } : {});
  const facebook_scheduled: Array<Record<string, unknown>> = [];
  const client = deps.client === undefined ? createMetaClientOptional(deps.fetchImpl) : deps.client;
  if (client) {
    const brands = brand ? [loadBrand(brand)] : loadAllBrands();
    for (const cfg of brands) {
      if (!cfg.pageId) continue;
      try {
        const pageToken = await getPageToken(client, cfg.pageId);
        const data = (await listFbScheduled(client, cfg.pageId, pageToken)) as { data?: Array<Record<string, unknown>> };
        for (const row of data.data ?? []) {
          facebook_scheduled.push({ ...row, brand: cfg.brand, source: "facebook_scheduled_posts" });
        }
      } catch {
        /* best-effort */
      }
    }
  }
  return { timezone: "America/Bogota", jobs: local, facebook_scheduled };
}

export async function cancelScheduled(
  args: { id: string; confirm?: boolean; dryRun?: boolean },
  deps: ServiceDeps = {},
) {
  const id = args.id.trim();
  if (!id) throw new Error("id is required");
  const store = scheduleStore(deps);
  const job = store.get(id);
  const gate = requireConfirm(args);
  if (gate.mode === "preview") {
    const preview: PreviewResult = {
      dry_run: true,
      confirm_required: true,
      action: "cancel",
      plan: { id, found: Boolean(job), current_status: job?.status, brand: job?.brand, path: job?.path },
      warnings: job ? [] : ["No MCP job with this id; confirm:true will try Facebook delete or YouTube delete."],
    };
    return preview;
  }
  if (gate.dryRun) return { dry_run: true, planned: { action: "cancel", id, status: job?.status } };

  if (job) {
    if (job.status === "published") throw new Error("cannot_cancel: job already published");
    if (job.status === "cancelled") return { cancelled: true, status: "cancelled", id, brand: job.brand };
    if (job.path === "youtube_native" && job.post_id) {
      const yt = YouTubeClient.fromBrand(job.brand, fetchImpl(deps));
      await yt.deleteVideo(job.post_id);
    }
    if (job.path === "graph_native" && job.post_id) {
      const client = metaClient(deps);
      await client.delete(job.post_id);
    }
    const updated = store.update(id, { status: "cancelled" });
    return { cancelled: true, status: updated.status, id, brand: updated.brand, path: updated.path };
  }

  try {
    const client = metaClient(deps);
    await client.delete(id);
    return { cancelled: true, status: "cancelled", id, path: "graph_native" };
  } catch {
    throw new Error(`schedule_not_found: ${id}`);
  }
}

export async function processDueJobs(deps: ServiceDeps = {}, now = deps.now?.() ?? new Date()) {
  const store = scheduleStore(deps);
  const due = store.due(now);
  const results: Array<Record<string, unknown>> = [];
  for (const job of due) {
    if (job.path !== "mcp_cron") continue;
    store.update(job.id, { status: "publishing" });
    try {
      const published = await executePlatform({
        platform: job.platform,
        brand: job.brand,
        media: job.media ?? [],
        containerId: job.container_id,
        caption: job.caption,
        title: job.title,
        collaborators: job.collaborators,
        publishNow: true,
        publishAtUtc: now,
        publishAtBogota: formatBogota(now),
        dryRun: false,
        deps,
        registry: mediaStore(deps),
      });
      store.update(job.id, {
        status: published.status === "error" ? "failed" : "published",
        post_id: published.post_id,
        published_at: now.toISOString(),
        error: published.error,
      });
      results.push({ id: job.id, ...published });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.update(job.id, { status: "failed", error: message });
      results.push({ id: job.id, status: "failed", error: message });
    }
  }
  return { processed: results.length, results };
}

export async function listCollaborators(
  args: { media_id: string; brand?: string },
  deps: ServiceDeps = {},
) {
  const mediaId = args.media_id.trim();
  if (!mediaId) throw new Error("media_id is required (published IG media id)");
  const client = metaClient(deps);
  const data = await listIgCollaborators(client, mediaId);
  return {
    media_id: mediaId,
    brand: args.brand ? resolveBrand(args.brand) : undefined,
    collaborators: (data as { data?: unknown }).data ?? data,
    note: "Instagram Graph only. If an invite is missing or failed, use Meta Business Suite as fallback.",
  };
}

export { limitsList };
export type { BrandConfig, MediaRecord };

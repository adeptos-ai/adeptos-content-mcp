import type { PublishPlatform } from "./types.js";

export type PlatformLimit = {
  platform: PublishPlatform;
  photo: boolean;
  video: boolean;
  carousel: { supported: boolean; min: number; max: number; kind: string };
  schedule: "mcp_cron" | "graph_native" | "youtube_native";
  notes: string;
};

export const PLATFORM_LIMITS: Record<PublishPlatform, PlatformLimit> = {
  meta_ig: {
    platform: "meta_ig",
    photo: true,
    video: true,
    carousel: { supported: true, min: 2, max: 10, kind: "IG CAROUSEL container" },
    schedule: "mcp_cron",
    notes:
      "Primary Canva lane. Graph Content Publishing. Containers expire in 24h. No native IG schedule.",
  },
  meta_fb: {
    platform: "meta_fb",
    photo: true,
    video: true,
    carousel: { supported: true, min: 2, max: 10, kind: "Page attached_media multi-photo" },
    schedule: "graph_native",
    notes: "Page feed. Native scheduled_publish_time (10 min–30 days).",
  },
  tiktok: {
    platform: "tiktok",
    photo: true,
    video: true,
    carousel: { supported: true, min: 1, max: 35, kind: "PHOTO Direct Post photo_images" },
    schedule: "mcp_cron",
    notes:
      "Content Posting API Direct Post. Photos via /content/init; video via /video/init PULL_FROM_URL. No native schedule. Unaudited apps: SELF_ONLY.",
  },
  youtube: {
    platform: "youtube",
    photo: false,
    video: true,
    carousel: { supported: false, min: 0, max: 0, kind: "none" },
    schedule: "youtube_native",
    notes:
      "YouTube Data API v3 has NO Community/image post endpoint. Photo/carousel jobs skip YouTube. Short mp4 uploads OK (videos.insert). Schedule: private + publishAt.",
  },
  linkedin: {
    platform: "linkedin",
    photo: true,
    video: true,
    carousel: { supported: true, min: 2, max: 20, kind: "organic MultiImage (not sponsored Carousel)" },
    schedule: "mcp_cron",
    notes: "Posts API /rest/posts. Organic multi-image is MultiImage. No native schedule.",
  },
  x: {
    platform: "x",
    photo: true,
    video: true,
    carousel: { supported: true, min: 2, max: 4, kind: "up to 4 images on one tweet" },
    schedule: "mcp_cron",
    notes: "X API v2 tweets + media upload. No native schedule. Caption ≤280.",
  },
};

export function limitsList(): PlatformLimit[] {
  return Object.values(PLATFORM_LIMITS);
}

import { PUBLISH_PLATFORMS, type PublishPlatform, type SchedulePath } from "./types.js";

const ALIASES: Record<string, PublishPlatform> = {
  meta_ig: "meta_ig",
  ig: "meta_ig",
  instagram: "meta_ig",
  meta_fb: "meta_fb",
  fb: "meta_fb",
  facebook: "meta_fb",
  ig_fb: "meta_ig",
  tiktok: "tiktok",
  youtube: "youtube",
  yt: "youtube",
  x: "x",
  twitter: "x",
  linkedin: "linkedin",
};

export function parsePlatform(value: string): PublishPlatform {
  const key = value.trim().toLowerCase();
  const mapped = ALIASES[key];
  if (!mapped) {
    throw new Error(`unknown_platform: ${value}. Allowed: ${PUBLISH_PLATFORMS.join(", ")}.`);
  }
  return mapped;
}

export function isPublishPlatform(value: string): value is PublishPlatform {
  return (PUBLISH_PLATFORMS as readonly string[]).includes(value);
}

export function normalizePlatforms(args: {
  platforms?: string[];
  platform?: string;
  also_post_fb?: boolean;
}): PublishPlatform[] {
  const raw: string[] = [];
  if (args.platforms?.length) raw.push(...args.platforms);
  else if (args.platform) {
    if (args.platform === "ig_fb") raw.push("meta_ig", "meta_fb");
    else raw.push(args.platform);
  } else {
    raw.push("meta_ig");
  }
  if (args.also_post_fb) raw.push("meta_fb");

  const targets: PublishPlatform[] = [];
  for (const item of raw) {
    const p = parsePlatform(item);
    if (!targets.includes(p)) targets.push(p);
  }
  return targets;
}

export function schedulePathFor(platform: PublishPlatform, publishNow: boolean): SchedulePath {
  if (publishNow) {
    if (platform === "youtube") return "youtube_native";
    if (platform === "meta_ig" || platform === "meta_fb") return "graph_native";
    return "mcp_cron";
  }
  if (platform === "meta_fb") return "graph_native";
  if (platform === "youtube") return "youtube_native";
  return "mcp_cron";
}

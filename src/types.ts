export const BRAND_KEYS = ["hamill", "zono", "adeptos"] as const;
export type BrandKey = (typeof BRAND_KEYS)[number];

/** Same destination set Opus Clip uses for clips. Content MCP posts Canva stills here. */
export const PUBLISH_PLATFORMS = ["meta_ig", "meta_fb", "tiktok", "youtube", "linkedin", "x"] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

export const MEDIA_TYPES = ["photo", "video", "reels"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export type PlatformAccount = {
  platform: PublishPlatform;
  id: string | null;
  publish_ready: boolean;
  missing: string[];
  name?: string;
  username?: string;
  error?: string;
  note?: string;
};

export type BrandAccount = {
  brand: BrandKey;
  name: string;
  platforms: PlatformAccount[];
  ig_user_id: string | null;
  page_id: string | null;
  publish_ready: boolean;
  missing: string[];
};

export type MediaRecord = {
  media_id: string;
  brand: BrandKey;
  media_type: MediaType;
  url: string;
  is_carousel_item: boolean;
  created_at: string;
  ig_user_id?: string;
  platforms?: PublishPlatform[];
  child_urls?: string[];
  child_ids?: string[];
  collaborators?: string[];
};

export type ScheduleStatus = "scheduled" | "publishing" | "published" | "cancelled" | "failed";

export type SchedulePath = "mcp_cron" | "graph_native" | "youtube_native";

export type ScheduleJob = {
  id: string;
  brand: BrandKey;
  platform: PublishPlatform;
  status: ScheduleStatus;
  path: SchedulePath;
  publish_at_utc: string;
  publish_at_bogota: string;
  caption?: string;
  title?: string;
  container_id?: string;
  media_ids?: string[];
  media?: Array<{ media_type: MediaType; url: string; media_id?: string }>;
  also_post_fb: boolean;
  collaborators?: string[];
  created_at: string;
  updated_at: string;
  post_id?: string;
  fb_post_id?: string;
  published_at?: string;
  error?: string;
  confirm: true;
};

export type PreviewResult = {
  dry_run: true;
  confirm_required: true;
  action: string;
  plan: Record<string, unknown>;
  warnings: string[];
};

export type PlatformResult = {
  platform: PublishPlatform;
  status: "preview" | "planned" | "published" | "scheduled" | "skipped" | "error";
  path?: SchedulePath | "tiktok_direct_post" | "linkedin_posts" | "x_tweets";
  schedule_id?: string;
  post_id?: string;
  error?: string;
  warning?: string;
  note?: string;
  collaborators?: string[];
  collaborator_invites?: Array<{ id?: string; username?: string; invite_status?: string }>;
};

export const SOFT_SLOTS_BOGOTA = [9, 12, 15, 18, 21] as const;
export const TIMEZONE = "America/Bogota";
export const IG_CONTAINER_TTL_HOURS = 24;

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  cancelScheduled,
  createCarousel,
  listAccounts,
  listCollaborators,
  listScheduled,
  schedulePost,
  uploadMedia,
} from "./content-service.js";
import { MetaApiError } from "./meta-client.js";
import { PUBLISH_PLATFORMS } from "./types.js";
import { textResult } from "./safety.js";
import { TikTokApiError } from "./tiktok-client.js";
import { YouTubeApiError } from "./youtube-client.js";
import { LinkedInApiError } from "./linkedin-client.js";
import { XApiError } from "./x-client.js";

const confirmField = z
  .boolean()
  .default(false)
  .describe("Must be true to publish/schedule/cancel. Default false = preview only.");
const dryRunField = z
  .boolean()
  .optional()
  .describe("If true with confirm:true, return the planned API call without executing.");
const brandField = z.string().describe("Brand key: hamill | zono | adeptos");
const platformsField = z
  .array(z.string())
  .optional()
  .describe(`Destinations: ${PUBLISH_PLATFORMS.join(", ")}. Same nets as Opus Clip. Default meta_ig.`);
const collaboratorsField = z
  .array(z.string())
  .optional()
  .describe(
    "Optional Instagram usernames to invite as collaborators (max 3). Graph only — feed image, Reels, carousel. Omitted/empty = normal post. Not sent to TikTok/YouTube/LinkedIn/X.",
  );

function handleError(err: unknown) {
  if (
    err instanceof MetaApiError ||
    err instanceof TikTokApiError ||
    err instanceof YouTubeApiError ||
    err instanceof LinkedInApiError ||
    err instanceof XApiError
  ) {
    return textResult({ error: err.message, status: err.status, body: err.body }, true);
  }
  return textResult({ error: err instanceof Error ? err.message : String(err) }, true);
}

export function registerContentTools(server: McpServer): void {
  server.tool(
    "content_list_accounts",
    "List Hamill/Zono/Adeptos destinations (IG, FB, TikTok, YouTube, LinkedIn, X) and media limits. Opus Clip = clips; this MCP = Canva stills.",
    { brand: z.string().optional().describe("Optional brand filter") },
    async ({ brand }) => {
      try {
        return textResult(await listAccounts({ brand }));
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.tool(
    "content_upload_media",
    "Register a Canva export URL (photo or mp4). Creates an IG container when meta_ig is in platforms or platforms is omitted.",
    {
      brand: brandField,
      image_url: z.string().optional().describe("Public HTTPS image URL (Canva export)"),
      video_url: z.string().optional().describe("Public HTTPS mp4 URL"),
      file_path: z.string().optional().describe("Rejected unless it is already an HTTPS URL"),
      is_carousel_item: z.boolean().optional().describe("true for IG carousel slides"),
      media_type: z.enum(["photo", "video", "reels"]).optional(),
      caption: z.string().optional(),
      cover_url: z.string().optional(),
      platforms: platformsField,
      collaborators: collaboratorsField,
    },
    async (args) => {
      try {
        return textResult(await uploadMedia(args));
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.tool(
    "content_create_carousel",
    "Meta IG only: build a CAROUSEL container from 2–10 child media_ids. Other nets assemble multi-image at publish from the same URLs.",
    {
      brand: brandField,
      media_ids: z.array(z.string()).describe("2–10 IG carousel item container ids"),
      caption: z.string().optional(),
      collaborators: collaboratorsField,
    },
    async (args) => {
      try {
        return textResult(await createCarousel(args));
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.tool(
    "content_schedule_post",
    "Publish now or schedule a Canva post. platforms[] = Opus Clip destination set. confirm:true required to mutate.",
    {
      brand: brandField,
      platforms: platformsField,
      platform: z.string().optional().describe("Legacy single platform (ig|fb|tiktok|youtube|linkedin|x)"),
      also_post_fb: z.boolean().optional(),
      container_id: z.string().optional(),
      media_id: z.string().optional(),
      media_ids: z.array(z.string()).optional(),
      image_url: z.string().optional(),
      video_url: z.string().optional(),
      publish_at: z.string().optional().describe("ISO. Naive times are America/Bogotá."),
      publish_now: z.boolean().optional(),
      caption: z.string().optional(),
      title: z.string().optional().describe("YouTube title (caption used if omitted)"),
      collaborators: collaboratorsField,
      confirm: confirmField,
      dryRun: dryRunField,
    },
    async (args) => {
      try {
        return textResult(await schedulePost(args));
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.tool(
    "content_list_scheduled",
    "List MCP cron jobs plus Facebook Page scheduled_posts when a token is present.",
    { brand: z.string().optional() },
    async ({ brand }) => {
      try {
        return textResult(await listScheduled({ brand }));
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.tool(
    "content_list_collaborators",
    "GET /{ig-media-id}/collaborators — invite status after an IG publish. Meta Graph only.",
    {
      media_id: z.string().describe("Published Instagram media id"),
      brand: z.string().optional(),
    },
    async (args) => {
      try {
        return textResult(await listCollaborators(args));
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.tool(
    "content_cancel",
    "Cancel a scheduled MCP job (or native FB/YouTube id). confirm:true required.",
    {
      id: z.string().describe("schedule_id (sch_…) or native post/video id"),
      confirm: confirmField,
      dryRun: dryRunField,
    },
    async (args) => {
      try {
        return textResult(await cancelScheduled(args));
      } catch (err) {
        return handleError(err);
      }
    },
  );
}

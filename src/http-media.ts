import { existsSync } from "node:fs";
import { detectMediaType, isHttpUrl } from "./graph-content.js";
import type { MediaType } from "./types.js";

export function resolveSource(args: {
  image_url?: string;
  video_url?: string;
  file_path?: string;
}): { url: string; mediaType: MediaType } {
  const source = (args.image_url || args.video_url || args.file_path || "").trim();
  if (!source) throw new Error("Provide image_url, video_url, or file_path (public HTTPS Canva export).");
  if (!isHttpUrl(source)) {
    if (existsSync(source)) {
      throw new Error(
        "public_url_required: Destinations fetch HTTPS URLs. Canva export links work; localhost files do not.",
      );
    }
    throw new Error(`invalid_media_source: ${source} is not a public URL`);
  }
  const mediaType = detectMediaType(source, args.video_url && !args.image_url ? "video" : undefined);
  return { url: source, mediaType };
}

export async function fetchBytes(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Failed to download media (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || guessContentType(url);
  return { bytes, contentType };
}

function guessContentType(url: string): string {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".mp4")) return "video/mp4";
  if (clean.endsWith(".mov")) return "video/quicktime";
  return "image/jpeg";
}

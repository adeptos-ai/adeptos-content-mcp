import jpeg from "jpeg-js";
import { PNG } from "pngjs";

export type HostedBytes = {
  bytes: Uint8Array;
  contentType: string;
  ext: string;
};

type Sniffed = "jpeg" | "png" | "webp" | "gif" | "mp4" | "mov" | "webm" | "unknown";

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

export function sniffMedia(bytes: Uint8Array, contentType: string, filename: string): Sniffed {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "webp";
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
    if (brand.startsWith("qt")) return "mov";
    return "mp4";
  }
  const hint = `${contentType} ${filename}`.toLowerCase();
  if (hint.includes("image/jpeg") || /\.jpe?g(\?|$)/.test(hint)) return "jpeg";
  if (hint.includes("image/png") || hint.includes(".png")) return "png";
  if (hint.includes("image/webp") || hint.includes(".webp")) return "webp";
  if (hint.includes("image/gif") || hint.includes(".gif")) return "gif";
  if (hint.includes("video/mp4") || hint.includes(".mp4")) return "mp4";
  if (hint.includes("video/quicktime") || hint.includes(".mov")) return "mov";
  if (hint.includes("video/webm") || hint.includes(".webm")) return "webm";
  return "unknown";
}

export function pngToJpeg(bytes: Uint8Array, quality = 90): Uint8Array {
  const png = PNG.sync.read(Buffer.from(bytes));
  const encoded = jpeg.encode({ data: png.data, width: png.width, height: png.height }, quality);
  return new Uint8Array(encoded.data);
}

/**
 * TikTok photo pull requires JPEG or WebP. PNG (typical Canva export) is converted to JPEG.
 * Video is stored as-is.
 */
export function prepareHostedBytes(bytes: Uint8Array, contentType: string, filename: string): HostedBytes {
  const kind = sniffMedia(bytes, contentType, filename);
  if (kind === "jpeg") return { bytes, contentType: "image/jpeg", ext: "jpg" };
  if (kind === "webp") return { bytes, contentType: "image/webp", ext: "webp" };
  if (kind === "png") {
    const converted = pngToJpeg(bytes);
    return { bytes: converted, contentType: "image/jpeg", ext: "jpg" };
  }
  if (kind === "mp4") return { bytes, contentType: "video/mp4", ext: "mp4" };
  if (kind === "mov") return { bytes, contentType: "video/quicktime", ext: "mov" };
  if (kind === "webm") return { bytes, contentType: "video/webm", ext: "webm" };
  if (kind === "gif") {
    throw new Error("unsupported_media_for_host: GIF is not a TikTok photo format. Export JPEG, WebP, or PNG.");
  }
  throw new Error(
    `unsupported_media_for_host: ${contentType || filename || "unknown type"}. Photos must be JPEG, WebP, or PNG (PNG is converted to JPEG).`,
  );
}

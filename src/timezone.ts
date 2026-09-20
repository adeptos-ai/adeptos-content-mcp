import { SOFT_SLOTS_BOGOTA, TIMEZONE } from "./types.js";

/** America/Bogotá is UTC−5 year-round (no DST). */
export const BOGOTA_OFFSET_MINUTES = -5 * 60;

export function parsePublishAt(input: string, now = new Date()): { utc: Date; bogotaIso: string; warnings: string[] } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("publish_at is required unless publish_now is true");
  }

  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  let utc: Date;
  if (hasZone) {
    utc = new Date(trimmed);
  } else {
    // Naive ISO → interpret as America/Bogotá wall time.
    const m = trimmed.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/,
    );
    if (!m) {
      utc = new Date(trimmed);
    } else {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      const hour = Number(m[4] ?? "0");
      const minute = Number(m[5] ?? "0");
      const second = Number(m[6] ?? "0");
      const ms = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
      utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - BOGOTA_OFFSET_MINUTES * 60_000);
    }
  }

  if (Number.isNaN(utc.getTime())) {
    throw new Error(`invalid publish_at: ${input}`);
  }

  const warnings: string[] = [];
  const deltaMs = utc.getTime() - now.getTime();
  if (deltaMs < 0) {
    warnings.push("publish_at is in the past");
  } else if (deltaMs < 15 * 60_000) {
    warnings.push("Acceptance target is ≥15 minutes in the future; this is sooner (soft warning).");
  }

  const bogota = bogotaParts(utc);
  if (!SOFT_SLOTS_BOGOTA.includes(bogota.hour as (typeof SOFT_SLOTS_BOGOTA)[number]) || bogota.minute !== 0) {
    warnings.push(
      `Soft slot preference is ${SOFT_SLOTS_BOGOTA.join("/")} :00 America/Bogotá (not a hard fail). ` +
        `This publish_at is ${pad(bogota.hour)}:${pad(bogota.minute)} Bogotá.`,
    );
  }

  return { utc, bogotaIso: formatBogota(utc), warnings };
}

export function formatBogota(date: Date): string {
  const p = bogotaParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}-05:00`;
}

export function formatUtc(date: Date): string {
  return date.toISOString();
}

export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function bogotaParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

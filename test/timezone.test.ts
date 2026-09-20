import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatBogota, parsePublishAt } from "../src/timezone.js";

describe("timezone America/Bogotá", () => {
  it("treats naive ISO as Bogotá (UTC−5)", () => {
    const { utc, bogotaIso } = parsePublishAt("2026-09-20T09:00:00", new Date("2026-09-18T00:00:00Z"));
    assert.equal(utc.toISOString(), "2026-09-20T14:00:00.000Z");
    assert.equal(bogotaIso.startsWith("2026-09-20T09:00:00"), true);
  });

  it("keeps explicit offsets", () => {
    const { utc } = parsePublishAt("2026-09-20T14:00:00Z", new Date("2026-09-18T00:00:00Z"));
    assert.equal(utc.toISOString(), "2026-09-20T14:00:00.000Z");
  });

  it("soft-warns off-slot and <15 min", () => {
    const now = new Date("2026-09-20T14:00:00Z");
    const off = parsePublishAt("2026-09-20T10:07:00", now);
    assert.ok(off.warnings.some((w) => /Soft slot/i.test(w)));
    const soon = parsePublishAt(new Date(now.getTime() + 5 * 60_000).toISOString(), now);
    assert.ok(soon.warnings.some((w) => /15 minutes/i.test(w)));
  });

  it("formats Bogotá", () => {
    assert.match(formatBogota(new Date("2026-09-20T14:00:00Z")), /2026-09-20T09:00:00-05:00/);
  });
});

#!/usr/bin/env node
// Merge two schedules.json stores by job id. Cancelled wins; otherwise the newer updated_at wins.
// Usage: node scripts/merge-stores.mjs <canonical.json> <stray.json> [--apply]
// Without --apply it prints a summary only. With --apply it backs up both files, writes the merged
// result to the canonical path (temp + rename), and drops a MIGRATED_TO marker next to the stray
// file. Stop every MCP instance first.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
if (args.length < 2) {
  console.error("usage: merge-stores.mjs <canonical> <stray> [--apply]");
  process.exit(2);
}
const [canon, stray] = args.map((p) => resolve(p));
const load = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).jobs ?? [] : []);
const a = load(canon);
const b = load(stray);
const rank = (j) => (j.status === "cancelled" ? 2 : 1);
const merged = new Map();
const conflicts = [];
for (const j of [...a, ...b]) {
  const prev = merged.get(j.id);
  if (!prev) {
    merged.set(j.id, j);
    continue;
  }
  if (prev.status !== j.status) conflicts.push(`${j.id}: ${prev.status} vs ${j.status}`);
  const win =
    rank(j) !== rank(prev) ? (rank(j) > rank(prev) ? j : prev) : (j.updated_at ?? "") > (prev.updated_at ?? "") ? j : prev;
  merged.set(j.id, win);
}
const jobs = [...merged.values()].sort((x, y) => (x.publish_at_utc ?? "").localeCompare(y.publish_at_utc ?? ""));
const count = (list) => list.reduce((acc, j) => ((acc[j.status] = (acc[j.status] ?? 0) + 1), acc), {});
console.log(
  JSON.stringify(
    {
      canonical: a.length,
      stray: b.length,
      merged: jobs.length,
      conflicts: conflicts.length,
      by_status: count(jobs),
      still_scheduled: jobs.filter((j) => j.status === "scheduled").length,
    },
    null,
    2,
  ),
);
conflicts.forEach((c) => console.log(`  ${c}`));
if (!apply) {
  console.log("dry run; pass --apply to write");
  process.exit(0);
}
const ts = new Date().toISOString().replace(/[:.]/g, "-");
for (const f of [canon, stray]) if (existsSync(f)) copyFileSync(f, `${f}.pre-store-merge-${ts}.bak`);
const tmp = `${canon}.tmp-${process.pid}`;
writeFileSync(tmp, `${JSON.stringify({ jobs }, null, 2)}\n`);
renameSync(tmp, canon);
writeFileSync(join(dirname(stray), "MIGRATED_TO"), `${canon}\n${new Date().toISOString()}\n`);
console.log(`wrote ${canon}; backups *.pre-store-merge-${ts}.bak; marker ${join(dirname(stray), "MIGRATED_TO")}`);

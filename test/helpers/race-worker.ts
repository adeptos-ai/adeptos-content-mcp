/**
 * Child process for the cross-process store race. Not a test file.
 * argv: <dataDir> <owner> <mode> [count]
 *   claim  — claim due jobs and mark each published once
 *   insert — insert `count` scheduled jobs
 */
import { ScheduleStore } from "../../src/store.js";
import type { ScheduleJob } from "../../src/types.js";

const dir = process.argv[2];
const owner = process.argv[3];
const mode = process.argv[4] ?? "claim";
const count = Number(process.argv[5] ?? "10");

if (!dir || !owner) {
  console.error("usage: race-worker.ts <dataDir> <owner> <claim|insert> [count]");
  process.exit(2);
}

const store = ScheduleStore.create(dir);

function job(id: string): ScheduleJob {
  return {
    id,
    brand: "hamill",
    platform: "tiktok",
    status: "scheduled",
    path: "mcp_cron",
    publish_at_utc: "2020-01-01T00:00:00.000Z",
    publish_at_bogota: "2019-12-31T19:00:00-05:00",
    also_post_fb: false,
    media: [{ media_type: "photo", url: `https://cdn.example/${id}.jpg` }],
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
    confirm: true,
  };
}

if (mode === "insert") {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `sch_${owner}_${i}`;
    store.insert(job(id));
    ids.push(id);
  }
  process.stdout.write(JSON.stringify({ owner, ids }));
  process.exit(0);
}

const published: string[] = [];
for (;;) {
  const claimed = store.claimDue(new Date(), owner, 60_000);
  if (!claimed) break;
  const fresh = store.get(claimed.id);
  if (!fresh || fresh.status !== "publishing" || fresh.owner !== owner) continue;
  const saved = store.finishPublish(claimed.id, owner, {
    status: "published",
    post_id: `post_${claimed.id}`,
    published_at: new Date().toISOString(),
  });
  if (saved?.status === "published") published.push(claimed.id);
}

process.stdout.write(JSON.stringify({ owner, published }));

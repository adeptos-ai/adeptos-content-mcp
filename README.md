# adeptos-content-mcp

Adeptos-owned MCP for **Canva stills** — photos, carousels, and static posts + caption — published to the same destinations Opus Clip already uses for video clips.

**Grok Bot now:** wire **stdio** (Ads MCP pattern) with Meta IG/FB first for live proof. Multi-platform tools stay in the package; other nets are optional later.

Public GitHub target (scrubbed mirror, no `.env`): `https://github.com/adeptos-ai/adeptos-content-mcp` — create under the Adeptos org if it does not exist yet.

| Lane | Tool | Media |
|------|------|--------|
| **Opus Clip** | clips / short-form video | YouTube, TikTok, Instagram, Facebook Page, LinkedIn, X |
| **Content MCP (this repo)** | Canva exports | same destinations, for **posts / photos / carousels** |

Do **not** use this server to replace Opus Clip for long-form clipping. Do **not** use Postiz or any paid aggregator.

- **Stack:** Node 20+, TypeScript, `@modelcontextprotocol/sdk`
- **Transports:** Express Streamable HTTP + stdio
- **Brands:** `hamill` · `zono` · `adeptos` (one brand per call; never cross-brand)
- **Meta portfolios:** **two** Business Managers — Ryan Hamill BM (`hamill` + `adeptos` share one token) and ZONO BM (`zono` has its own). There is no third Adeptos-only BM token.
- **Safety:** every publish / schedule / cancel needs `confirm: true`. Without it you get a dry-run preview. Ryan approves in chat first.
- **Timezone:** naive `publish_at` is **America/Bogotá** (converted to UTC). Soft slots 09 / 12 / 15 / 18 / 21.
- **Entity:** ADEPTOS AI LLC product path only.

---

## Tools

| Tool | Mutates? | Notes |
|------|----------|--------|
| `content_list_accounts` | no | All six destinations + per-platform media limits |
| `content_upload_media` | IG container only | Canva HTTPS URL. `is_carousel_item: true` for IG slides |
| `content_create_carousel` | IG container | Meta IG 2–10 only. Other nets assemble multi-image at publish |
| `content_schedule_post` | **yes** | `platforms: ("meta_ig"\|"meta_fb"\|"tiktok"\|"youtube"\|"linkedin"\|"x")[]` · `confirm:true` |
| `content_list_scheduled` | no | MCP cron jobs + FB `scheduled_posts` |
| `content_list_collaborators` | no | `GET /{ig-media-id}/collaborators` after an IG publish |
| `content_cancel` | **yes** | `confirm:true` |

Primary path:

1. Canva export URL(s) → `content_upload_media` (repeat for carousel slides)
2. `content_create_carousel` when the IG post is a carousel
3. `content_schedule_post` with `platforms[]` and `publish_at` or `publish_now`
4. First call **without** `confirm` (preview). Ryan approves. Second call `confirm: true`.

### Optional Instagram collaborator invites

Not on every post. Pass `collaborators?: string[]` (Instagram **usernames**, max 3) on `content_schedule_post`, `content_create_carousel`, or standalone `content_upload_media` (feed image / Reels — not carousel children).

- Omitted or `[]` → Graph is called **without** a `collaborators` field (normal post).
- Set → Graph `collaborators` on `POST /{ig-user-id}/media` for **feed image, Reels, and carousel parent only**.
- Stories are refused if that path is ever used. TikTok / YouTube / LinkedIn / X do **not** get invented collab APIs.
- Dry-run without `confirm` echoes the planned usernames.
- After publish, `content_list_collaborators` (or the schedule result) reads `GET /{ig-media-id}/collaborators` for invite status.
- If an invite fails or a creator never accepts, **Meta Business Suite remains the fallback**.

Hamill / Zono / Adeptos cross-brand collabs are the intended use (e.g. Hamill post inviting `@zono`).

---

## Per-platform media limits

| Platform | Photo | Carousel / multi | Video / mp4 | Schedule path |
|----------|-------|------------------|-------------|---------------|
| **Instagram** (`meta_ig`) | yes | 2–10 Graph `CAROUSEL` | Reels / video | `mcp_cron` (Graph has **no** IG schedule). Containers are created **at publish time** from stored media URLs — a container created at booking expires after ~24h and is not reused |
| **Facebook Page** (`meta_fb`) | yes | 2–10 `attached_media` | Page videos | `graph_native` (`published=false` + `scheduled_publish_time`) |
| **TikTok** | yes | PHOTO Direct Post `photo_images` (up to 35) | Direct Post `PULL_FROM_URL` | `mcp_cron` (no native schedule) |
| **YouTube** | **no** | **no** | short mp4 via `videos.insert` | `youtube_native` (`privacyStatus=private` + `publishAt`) |
| **LinkedIn** | yes | organic **MultiImage** 2–20 (not sponsored Carousel) | video URL treated as downloadable media | `mcp_cron` |
| **X** | yes | up to **4** images on one tweet | not in this Canva stills lane | `mcp_cron` |

### YouTube Community / image posts

**YouTube Data API v3 has no Community post or image-post endpoint.** A photo/carousel job that includes `youtube` is **skipped** with `youtube_community_unsupported`. Opus Clip remains the YouTube clip path. Content MCP will upload a **short mp4** Canva export when `video_url` is set.

Unaudited TikTok apps can only Direct Post as `SELF_ONLY`. Unaudited YouTube API projects force private until Google audit.

### Scheduled Instagram — containers at publish time

Meta media containers expire after about 24 hours. `content_schedule_post` stores the build spec on the job (`media` URLs and type, caption, collaborators) and does **not** store a container id for later. When the job is due, the worker:

1. Single image or video — `POST /{ig-user-id}/media`, poll `status_code` until `FINISHED`, then `media_publish`.
2. Carousel (2–10) — create each child with `is_carousel_item` (no caption, no collaborators), wait until each is `FINISHED`, create the parent `CAROUSEL` with caption and collaborators, wait until `FINISHED`, then `media_publish`.

A job that already has a legacy `container_id` is rebuilt the same way. The old id is never sent as `creation_id`.

Transient Graph/network errors (HTTP 408, 429, 5xx, timeouts, rate-limit copy) are retried with exponential backoff. Each try writes `attempts` and `error` on the job. When the retries are exhausted the job is `failed`. `media_publish` success writes `post_id` immediately.

| Env | Default | Role |
|-----|---------|------|
| `CONTENT_IG_PUBLISH_MAX_ATTEMPTS` | `3` | Attempts per due IG job, including the first |
| `CONTENT_IG_PUBLISH_RETRY_BASE_MS` | `1000` | Backoff base. Attempt 2 waits this long; attempt 3 waits twice that |

`publish_now` is unchanged: a container id you just created (upload or carousel) is published immediately. Without a container id, publish-now also builds from the media URLs, including carousels.

### One scheduler

Several agents each spawn their own stdio copy and share one `data/schedules.json`. Only **one** process may poll for due jobs. Every other copy can still enqueue, cancel, and list.

The poller starts only when `CONTENT_SCHEDULER_ENABLED=1`. `CONTENT_DISABLE_WORKER=1` turns it off even if the enable flag is set. Leave the enable flag unset on agent stdio servers.

That one process claims each due `mcp_cron` job atomically (`scheduled` → `publishing`, with `owner` and `lease_until`). It re-reads the job immediately before the network call and skips a cancel. The post id is written as soon as publish succeeds. If a job is still `publishing` after the lease, the next tick moves it to `needs_review` and does **not** publish it again.

All store writes take a cross-process lock (`data/store.lock`) and still use a temp file plus rename. A lock whose holder pid is dead, or whose age exceeds `CONTENT_STORE_LOCK_STALE_MS`, is removed. If `schedules.json` or `media.json` exists but is not valid JSON, reads throw `store_parse_error` instead of treating the file as empty (an empty read used to get saved back and wipe the queue).

| Env | Default | Role |
|-----|---------|------|
| `CONTENT_SCHEDULER_ENABLED` | unset | `1` starts the due-job poller in this process only |
| `CONTENT_DISABLE_WORKER` | unset | `1` kills the poller, including when the enable flag is set |
| `CONTENT_WORKER_INTERVAL_MS` | `30000` | Poll interval. Values under `5000` are ignored |
| `CONTENT_PUBLISH_LEASE_MS` | `600000` | How long a claim may stay in `publishing` (minimum `5000`) |
| `CONTENT_SCHEDULER_OWNER` | `host:pid:random` | Claim owner recorded on the job |
| `CONTENT_STORE_LOCK_STALE_MS` | `30000` | Age after which a lock held by a live pid is stolen |
| `CONTENT_STORE_LOCK_TIMEOUT_MS` | `15000` | How long a writer waits for the lock |
| `CONTENT_DATA_DIR` | `./data` | Directory for `schedules.json` and `media.json` |

Facebook Page posts still use Graph `scheduled_publish_time` when `publish_at` is in the future. Those rows are not claimed by the poller.

### Durable media (off by default)

There is no media host inside this process today. `content_upload_media` stores the source URL, and TikTok Direct Post sends that URL as `photo_images` / `PULL_FROM_URL`. Signed `fbcdn` links expire within days, and TikTok only pulls URLs on the verified domain `adeptos.ai`.

Set `CONTENT_MEDIA_STORAGE=github-static` to copy bytes at **booking** time (confirm, not preview) and store the public URL on the job. Unset, `off`, or `0` keeps the source URL. Unknown values throw.

`github-static` commits the file through the GitHub Contents API. The static site [adeptos-ai/landing-adeptos](https://github.com/adeptos-ai/landing-adeptos) serves everything under `public/` at `https://adeptos.ai/<path>` after an auto-deploy on push to `main` (about a minute). The adapter waits until that URL returns HTTP 200 to `HEAD`. Files have to stay in the repo: the site is rebuilt from git, not from a side upload. An S3 or R2 adapter can implement the same `MediaStorage` interface later; this build does not ship one.

TikTok photos must be JPEG or WebP. PNG uploads are converted to JPEG. GIF is rejected.

| Env | Default | Role |
|-----|---------|------|
| `CONTENT_MEDIA_STORAGE` | `off` | `off` or `github-static` |
| `GITHUB_STATIC_TOKEN` | none | Fine-grained or classic token with **contents: write** on the landing repo. Never commit it |
| `GITHUB_STATIC_REPO` | `adeptos-ai/landing-adeptos` | `owner/name` |
| `GITHUB_STATIC_BRANCH` | `main` | Branch that triggers the deploy |
| `GITHUB_STATIC_PATH_PREFIX` | `public/content-mcp` | Repo directory. The `public/` segment is not part of the public URL |
| `GITHUB_STATIC_PUBLIC_BASE` | `https://adeptos.ai` | Origin TikTok has verified |
| `GITHUB_STATIC_WAIT_MS` | `120000` | How long to wait for the deploy to answer HEAD 200 |
| `GITHUB_STATIC_POLL_MS` | `3000` | Delay between HEAD checks |

Booking blocks until the public URL is live, so a schedule call can take about a minute when hosting is on. URLs already on that origin are not uploaded again. Existing queued jobs are not rewritten by this server; cancel those and book again after hosting is enabled.

---

## Auth setup (Leo / Ryan)

Never paste tokens in Slack. Never commit `.env`. Tokens are never logged.

### Meta — Leonardo (`Rec0C3QKVTL0Y`) — two Business Managers

Content MCP uses **two** portfolios, not three. Mint one token per BM. Never put the Hamill token on Zono (or the reverse).

| Portfolio | Owns | Brands that share the token |
|-----------|------|-----------------------------|
| **Ryan Hamill** BM | Hamill + Adeptos AI Instagram/Page assets | `hamill`, `adeptos` |
| **ZONO** BM | Zono Instagram/Page assets | `zono` |

Resolution when a tool call is scoped to a brand (never cross-brand):

1. Prefer `BRAND_{BRAND}_META_ACCESS_TOKEN` if set
2. Else **hamill** / **adeptos**: `META_ACCESS_TOKEN` or `META_HAMILL_ACCESS_TOKEN` (Ryan Hamill portfolio aliases)
3. Else **zono**: `META_ZONO_ACCESS_TOKEN` or `BRAND_ZONO_META_ACCESS_TOKEN`

Adeptos does **not** need a third Adeptos-only BM token. If the shared Ryan Hamill token is set (`META_ACCESS_TOKEN` or `META_HAMILL_ACCESS_TOKEN`), both `hamill` and `adeptos` are token-ready. Missing-token errors name the env keys for that brand/portfolio.

Scopes: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management` if the System User spans both BMs.

Discover IDs **per portfolio token**:

```bash
# Ryan Hamill BM (hamill + adeptos)
curl -s "https://graph.facebook.com/v21.0/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=$META_ACCESS_TOKEN"

# ZONO BM
curl -s "https://graph.facebook.com/v21.0/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=$META_ZONO_ACCESS_TOKEN"
```

Set `BRAND_*_IG_USER_ID` and `BRAND_*_PAGE_ID` for hamill / zono / adeptos.

### TikTok — Login Kit + Content Posting API

Developer app → enable **Direct Post** → scopes `video.publish` (and `video.upload` if you also send inbox drafts). Each brand authorizes the app. Store per-brand `open_id` + access token (or refresh token + `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`).

`PULL_FROM_URL` only accepts URLs on a domain verified in the TikTok developer portal. For these brands that domain is `adeptos.ai`. With `CONTENT_MEDIA_STORAGE=github-static`, booking copies the file there before TikTok is asked to pull it.

### YouTube — OAuth refresh token (not a service account)

Service accounts **cannot** upload to a YouTube brand channel. Create a Cloud project, enable YouTube Data API v3, OAuth client (web or desktop), consent as the channel owner/manager with `access_type=offline` and scopes:

- `https://www.googleapis.com/auth/youtube.upload`
- `https://www.googleapis.com/auth/youtube.force-ssl` (needed to delete a scheduled private upload)

Store `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `BRAND_*_YOUTUBE_REFRESH_TOKEN` + `BRAND_*_YOUTUBE_CHANNEL_ID`. The server refreshes access tokens at publish time and refuses a token whose `mine=true` channel does not match the configured id.

### LinkedIn — Posts API

App with Community Management / Share on LinkedIn. Token scopes `w_organization_social` (Page) or `w_member_social` (member). Author URN:

- `BRAND_HAMILL_LINKEDIN_AUTHOR_URN=urn:li:organization:…` or `BRAND_*_LINKEDIN_ORG_ID`

Header `Linkedin-Version` defaults to `202507`.

### X / Twitter — OAuth 1.0a user context

Media upload still needs **OAuth 1.0a** user tokens. In the X developer portal: app API Key + Secret, then per-brand Access Token + Access Token Secret (write). Optional `BRAND_*_X_USER_ID` for `content_list_accounts`.

---

## Setup

```bash
git clone <this-repo>
cd adeptos-content-mcp
cp .env.example .env   # placeholders only — never commit real tokens
npm install
npm run build
npm test
```

### stdio (Grok Bot / Ads-style — Meta IG/FB first)

Same pattern as `adeptos-meta-ads-mcp`. After `npm install && npm run build`:

```bash
npm run start:stdio
# equivalent:
node dist/index.js --stdio
```

Cursor / Grok Bot `mcp.json` (stdio):

```json
{
  "mcpServers": {
    "adeptos-content": {
      "command": "node",
      "args": ["/absolute/path/to/adeptos-content-mcp/dist/index.js", "--stdio"],
      "env": {
        "META_ACCESS_TOKEN": "",
        "META_HAMILL_ACCESS_TOKEN": "",
        "META_ZONO_ACCESS_TOKEN": "",
        "META_GRAPH_VERSION": "v21.0",
        "BRAND_HAMILL_IG_USER_ID": "",
        "BRAND_HAMILL_PAGE_ID": "",
        "BRAND_HAMILL_NAME": "Hamill",
        "BRAND_ZONO_IG_USER_ID": "",
        "BRAND_ZONO_PAGE_ID": "",
        "BRAND_ZONO_NAME": "Zono",
        "BRAND_ADEPTOS_IG_USER_ID": "",
        "BRAND_ADEPTOS_PAGE_ID": "",
        "BRAND_ADEPTOS_NAME": "Adeptos"
      }
    }
  }
}
```

CLI-style:

```text
AddMcpServer name=adeptos-content command=node args=/absolute/path/to/adeptos-content-mcp/dist/index.js,--stdio
```

Env keys for **Meta live proof** (names only — values stay in local `.env` / plugin secret):

| Key | Role |
|-----|------|
| `META_ACCESS_TOKEN` | Ryan Hamill BM token (shared by `hamill` + `adeptos`) |
| `META_HAMILL_ACCESS_TOKEN` | Alias for the same Ryan Hamill portfolio token |
| `BRAND_HAMILL_META_ACCESS_TOKEN` / `BRAND_ADEPTOS_META_ACCESS_TOKEN` | Optional per-brand override; not a third BM |
| `META_ZONO_ACCESS_TOKEN` / `BRAND_ZONO_META_ACCESS_TOKEN` | ZONO BM token (`zono` only) |
| `META_GRAPH_VERSION` | default `v21.0` |
| `BRAND_HAMILL_IG_USER_ID` / `BRAND_HAMILL_PAGE_ID` | Hamill IG Business + FB Page |
| `BRAND_ZONO_IG_USER_ID` / `BRAND_ZONO_PAGE_ID` | Zono |
| `BRAND_ADEPTOS_IG_USER_ID` / `BRAND_ADEPTOS_PAGE_ID` | Adeptos (same Ryan Hamill BM as Hamill) |
| `BRAND_*_NAME` | optional display name |

Token scopes: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` (`business_management` if the System User spans both BMs). Leonardo owns mint + brand map (`Rec0C3QKVTL0Y`).

Brand map shape: `hamill` \| `zono` \| `adeptos` → `{ ig_user_id, page_id }`. One brand per tool call. Writes still need `confirm: true`.

### Streamable HTTP (optional, port **3848**)

```bash
npm run start:http
# GET http://127.0.0.1:3848/health
# MCP  http://127.0.0.1:3848/mcp
```

```json
{
  "mcpServers": {
    "adeptos-content": {
      "url": "http://127.0.0.1:3848/mcp"
    }
  }
}
```

Do **not** turn the poller on for every HTTP or stdio process. Set `CONTENT_SCHEDULER_ENABLED=1` on exactly one of them (see [One scheduler](#one-scheduler)). Facebook still uses Graph native schedule when `publish_at` is set.

---

## Acceptance checklist

Manual (Leo token proof on a **test** IG, then dry-run the rest):

- [ ] `content_list_accounts` returns Hamill, Zono, Adeptos with the six destinations
- [ ] Upload ≥2 Canva image URLs → `content_create_carousel` → preview `content_schedule_post` **without** confirm
- [ ] Multi-platform **photo** dry-run (`platforms` = all six) shows YouTube `youtube_community_unsupported` and no live posts
- [ ] `confirm: true` on **one test IG** (or unpublished draft) after Ryan approves
- [ ] Schedule ≥15 min future → appears in `content_list_scheduled` → `content_cancel` with confirm
- [ ] TikTok / LinkedIn / X confirm paths proven on a sandbox or mocked in `npm test`
- [ ] YouTube short mp4 path documented; Community images explicitly unsupported
- [ ] Optional IG collabs: dry-run echoes usernames; live invite on a test IG or Business Suite fallback if Graph fails

Automated (`npm test`):

- confirm gate + token redaction
- brand map + cross-brand forbid
- Bogotá conversion + soft slots
- multi-platform photo dry-run
- mocked confirm publish for Meta IG, TikTok photo, YouTube mp4, LinkedIn MultiImage, X tweet
- IG collaborators: dry-run echo; confirm media create includes `collaborators`; omit sends no field
- IG publish-time rebuild (legacy container id ignored, carousel children, video poll, retries)
- durable media stays off by default; github-static commits JPEG and redacts the token
- scheduler off unless `CONTENT_SCHEDULER_ENABLED=1`; `CONTENT_DISABLE_WORKER=1` still wins
- store parse errors throw; two processes cannot double-publish or drop inserts

---

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | `tsc` → `dist/` |
| `npm test` | `node --test` with mocked `fetch` (no real tokens) |
| `npm run start:http` | Streamable HTTP on `PORT` (3848) |
| `npm run start:stdio` | stdio transport |

## License

MIT

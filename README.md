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
| **Instagram** (`meta_ig`) | yes | 2–10 Graph `CAROUSEL` | Reels / video | `mcp_cron` (Graph has **no** IG schedule; containers expire in 24h) |
| **Facebook Page** (`meta_fb`) | yes | 2–10 `attached_media` | Page videos | `graph_native` (`published=false` + `scheduled_publish_time`) |
| **TikTok** | yes | PHOTO Direct Post `photo_images` (up to 35) | Direct Post `PULL_FROM_URL` | `mcp_cron` (no native schedule) |
| **YouTube** | **no** | **no** | short mp4 via `videos.insert` | `youtube_native` (`privacyStatus=private` + `publishAt`) |
| **LinkedIn** | yes | organic **MultiImage** 2–20 (not sponsored Carousel) | video URL treated as downloadable media | `mcp_cron` |
| **X** | yes | up to **4** images on one tweet | not in this Canva stills lane | `mcp_cron` |

### YouTube Community / image posts

**YouTube Data API v3 has no Community post or image-post endpoint.** A photo/carousel job that includes `youtube` is **skipped** with `youtube_community_unsupported`. Opus Clip remains the YouTube clip path. Content MCP will upload a **short mp4** Canva export when `video_url` is set.

Unaudited TikTok apps can only Direct Post as `SELF_ONLY`. Unaudited YouTube API projects force private until Google audit.

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

`PULL_FROM_URL` requires the Canva/CDN URL prefix to be verified in the TikTok developer portal.

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

The HTTP process also runs the `mcp_cron` worker (~30s) so IG schedules fire. Facebook uses Graph native schedule when `publish_at` is set.

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

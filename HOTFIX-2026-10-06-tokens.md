# Hotfix 2026-10-06: Facebook Page token + TikTok token refresh

Runtime: /workspace/adeptos-content-mcp-run (no git). Backup of pre-fix src/, dist/, .env:
/workspace/adeptos-content-mcp-run.bak-20261006-tokenfix/
Unified diff for porting: /workspace/adeptos-content-mcp-tokenfix-20261006.diff
(Part 1 = token fix + tests; Part 2 = separate, optional atomic write in store.ts.)
Job store backup taken before restart: /workspace/schedules.backup-20261006-tokenfix.json (87 jobs).

## 1. Facebook: "Invalid OAuth access token - Cannot parse access token"
Root cause: `MetaClient.request()` ran `redactDeep()` on every response. `safety.ts` redacts any key named
`access_token`, so `getPageToken()` received the literal "[REDACTED]" and every Page-token call
(FB photo/video/carousel publish, scheduled_posts list, cancel) sent "[REDACTED]" as the token.

Changes:
- src/meta-client.ts ~L87-93: new `raw?: boolean` option on `request()`. ~L144-146: successful responses
  skip `redactDeep` only when `raw:true`. Error bodies and messages are always redacted.
  ~L162: `get(path, query, { raw })`.
- src/graph-content.ts ~L168-181: `getPageToken()` does its own `GET /{page}?fields=id,access_token` with
  `raw:true`, returns only the token string, and refuses empty or "[REDACTED…" values.
  `getPage()` (~L154) stays redacted on purpose. Its only caller (`listAccounts`, content-service.ts ~L137)
  uses `.name` only, and `textResult()` redacts tool output again, so the Page token cannot reach a tool result.

## 2. TikTok: `access_token_invalid` for ADEPTOS / HAMILL / ZONO
Root cause: access tokens last about 24h. `ensureAccessToken()` refreshed only when the env access token was
EMPTY, so an expired token was never refreshed. `refreshTikTokToken()` also threw away a rotated refresh_token.

Changes (src/tiktok-client.ts):
- ~L65-105: `refreshedOnce` flag, `tokenEnvKeys()` (brand keys, falling back to global TIKTOK_* like
  loadBrand), and `refreshAccessToken()`. It re-reads the refresh token from .env on disk first (another
  instance may have rotated it), refreshes, adopts the new access token, and persists the access token plus
  any rotated refresh token to process.env and .env.
- ~L113-133: `request()` now calls a new private `send()` (~L135, the old request body). On
  `access_token_invalid`/`access_token_expired`/HTTP 401 it refreshes ONCE per client and retries. There is
  no loop. Strategy: retry-on-invalid rather than refresh-on-first-use. That avoids a token exchange on every
  tool call (each call builds a new TikTokClient) and keeps existing mocked tests valid.
- ~L276: `isTikTokTokenError()`. ~L293: `refreshTikTokTokenFull()` returns accessToken, refreshToken,
  expiresIn, refreshExpiresIn, openId and scope. ~L349: `refreshTikTokToken()` kept for back-compat (wraps Full).
- NEW src/env-persist.ts (79 lines): `persistEnvValues()` rewrites only the matching KEY= lines (or appends a
  missing key), writes a temp file with mode 600 and renames it atomically, and updates process.env. It never
  logs values. `readEnvFileValue()`. Both do nothing on disk under `node --test` (NODE_TEST_CONTEXT) or with
  CONTENT_MCP_ENV_PERSIST=0. CONTENT_MCP_ENV_FILE overrides the path.
- NEW test/tokenfix.test.ts: real Page token via getPageToken, getPage still redacted, error bodies redacted
  with raw, TikTok refresh-and-retry with rotation, no retry loop, invalid_grant surfaced.

## 3. (Separate) src/store.ts ~L18-31 atomic JSON write
`writeJson()` now writes a temp file in the same dir and then renames it, so a concurrent reader never sees a
truncated file. A truncated read falls back to [] and the next save would wipe every job. This is NOT a lock:
concurrent read-modify-write between instances can still lose an update. Follow-ups: a file lock, and making
readJson throw (not return []) when an existing file fails to parse.

## Ops done today
- TikTok tokens refreshed for all 3 brands. New access tokens written to .env. Refresh tokens did not rotate
  (refresh_expires_in about 357 days). /v2/user/info open_id matches BRAND_*_TIKTOK_OPEN_ID for all 3.
- Build OK, 49/49 tests pass. Old stdio instances (502645, 502698, 1525144) were killed; hosts respawn on demand.

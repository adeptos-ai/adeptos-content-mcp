#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Drop any empty/stale brand keys the MCP host may inject before sourcing .env
while IFS= read -r key; do
  unset "$key" 2>/dev/null || true
done <<'KEYS'
BRAND_HAMILL_IG_USER_ID
BRAND_HAMILL_PAGE_ID
BRAND_HAMILL_NAME
BRAND_ADEPTOS_IG_USER_ID
BRAND_ADEPTOS_PAGE_ID
BRAND_ADEPTOS_NAME
BRAND_ZONO_IG_USER_ID
BRAND_ZONO_PAGE_ID
BRAND_ZONO_NAME
META_ZONO_ACCESS_TOKEN
BRAND_ZONO_META_ACCESS_TOKEN
META_ACCESS_TOKEN
META_CONTENT_ACCESS_TOKEN
KEYS
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
if [[ -z "${META_ACCESS_TOKEN:-}${META_CONTENT_ACCESS_TOKEN:-}" ]]; then
  echo "META_ACCESS_TOKEN / META_CONTENT_ACCESS_TOKEN missing in $ROOT/.env" >&2
  exit 1
fi
export META_ACCESS_TOKEN="${META_ACCESS_TOKEN:-$META_CONTENT_ACCESS_TOKEN}"
exec node "$ROOT/dist/index.js" --stdio

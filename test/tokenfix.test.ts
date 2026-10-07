import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MetaClient, MetaApiError } from "../src/meta-client.js";
import { getPage, getPageToken } from "../src/graph-content.js";
import { TikTokClient, refreshTikTokTokenFull } from "../src/tiktok-client.js";

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const KEYS = [
  "BRAND_HAMILL_TIKTOK_OPEN_ID",
  "BRAND_HAMILL_TIKTOK_ACCESS_TOKEN",
  "BRAND_HAMILL_TIKTOK_REFRESH_TOKEN",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "CONTENT_MCP_ENV_PERSIST",
];
const saved: Record<string, string | undefined> = {};

describe("hotfix 2026-10-06 tokens", () => {
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.CONTENT_MCP_ENV_PERSIST = "0";
    process.env.BRAND_HAMILL_TIKTOK_OPEN_ID = "tt_open";
    process.env.BRAND_HAMILL_TIKTOK_ACCESS_TOKEN = "act.expired";
    process.env.BRAND_HAMILL_TIKTOK_REFRESH_TOKEN = "rft.old";
    process.env.TIKTOK_CLIENT_KEY = "ck";
    process.env.TIKTOK_CLIENT_SECRET = "cs";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("getPageToken returns the real Page token (not [REDACTED]); getPage stays redacted", async () => {
    const fetchImpl: typeof fetch = async () => jsonRes({ id: "111", name: "Page", access_token: "EAAPAGETOKEN123" });
    const client = new MetaClient({ accessToken: "EAASYSTEM", fetchImpl });
    assert.equal(await getPageToken(client, "111"), "EAAPAGETOKEN123");
    const page = await getPage(client, "111");
    assert.equal(page.access_token, "[REDACTED]");
  });

  it("Meta error bodies stay redacted even with raw:true", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonRes({ error: { message: "bad access_token=EAASECRET", access_token: "EAASECRET" } }, 400);
    const client = new MetaClient({ accessToken: "EAASYSTEM", fetchImpl });
    await assert.rejects(client.get("111", {}, { raw: true }), (err: unknown) => {
      assert.ok(err instanceof MetaApiError);
      assert.ok(!JSON.stringify(err.body).includes("EAASECRET"));
      assert.ok(!err.message.includes("EAASECRET"));
      return true;
    });
  });

  it("TikTok refreshes once on access_token_invalid and retries; rotated refresh token adopted", async () => {
    const auths: string[] = [];
    let refreshes = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/v2/oauth/token/")) {
        refreshes += 1;
        return jsonRes({ access_token: "act.fresh", refresh_token: "rft.new", expires_in: 86400 });
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      auths.push(auth);
      if (auth === "Bearer act.expired") {
        return jsonRes({ error: { code: "access_token_invalid", message: "The access token is invalid or not found in the request." } }, 401);
      }
      return jsonRes({ data: { privacy_level_options: ["SELF_ONLY"], creator_username: "hamill" }, error: { code: "ok" } });
    };
    const tt = TikTokClient.fromBrand("hamill", fetchImpl);
    const res = await tt.creatorInfo();
    assert.equal("data" in res && res.data.creator_username, "hamill");
    assert.equal(refreshes, 1);
    assert.deepEqual(auths, ["Bearer act.expired", "Bearer act.fresh"]);
    assert.equal(process.env.BRAND_HAMILL_TIKTOK_ACCESS_TOKEN, "act.fresh");
    assert.equal(process.env.BRAND_HAMILL_TIKTOK_REFRESH_TOKEN, "rft.new");
  });

  it("TikTok does not loop: second invalid after refresh surfaces the error", async () => {
    let refreshes = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("/v2/oauth/token/")) {
        refreshes += 1;
        return jsonRes({ access_token: "act.fresh", refresh_token: "rft.old" });
      }
      return jsonRes({ error: { code: "access_token_invalid", message: "invalid" } }, 401);
    };
    const tt = TikTokClient.fromBrand("hamill", fetchImpl);
    await assert.rejects(tt.creatorInfo());
    assert.equal(refreshes, 1);
  });

  it("refreshTikTokTokenFull returns rotated refresh_token and surfaces invalid_grant", async () => {
    const ok = await refreshTikTokTokenFull("rft.old", async () =>
      jsonRes({ access_token: "act.x", refresh_token: "rft.y", expires_in: 86400, refresh_expires_in: 31536000 }),
    );
    assert.equal(ok.accessToken, "act.x");
    assert.equal(ok.refreshToken, "rft.y");
    await assert.rejects(
      refreshTikTokTokenFull("rft.dead", async () =>
        jsonRes({ error: "invalid_grant", error_description: "Refresh token is invalid or expired." }, 400),
      ),
      /Refresh token is invalid/,
    );
  });
});

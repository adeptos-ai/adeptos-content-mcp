import { createHmac, randomBytes } from "node:crypto";

export type OAuth1Creds = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
};

export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function oauth1Header(
  method: string,
  url: string,
  creds: OAuth1Creds,
  extraParams: Record<string, string> = {},
): string {
  const parsed = new URL(url);
  const baseUrl = `${parsed.origin}${parsed.pathname}`;
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const all: Record<string, string> = { ...extraParams, ...oauth };
  parsed.searchParams.forEach((v, k) => {
    all[k] = v;
  });

  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(all[k])}`)
    .join("&");
  const base = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessSecret)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey).update(base).digest("base64");

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
      .join(", ")
  );
}

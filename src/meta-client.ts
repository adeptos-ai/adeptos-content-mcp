/**
 * Thin Meta Graph client for Content Publishing / Page feed.
 * Not the Marketing API. Token stays in env; URLs are never logged.
 */

import { redactDeep, redactString, safeErrorMessage } from "./safety.js";

export const DEFAULT_GRAPH_VERSION = "v21.0";
export const GRAPH_BASE = "https://graph.facebook.com";

export type MetaClientOptions = {
  accessToken: string;
  graphVersion?: string;
  fetchImpl?: typeof fetch;
};

export type GraphParams = Record<string, string | number | boolean | undefined | null>;

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(redactString(message));
    this.name = "MetaApiError";
  }
}

export function getAccessTokenFromEnv(): string {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "META_ACCESS_TOKEN is not set. Copy .env.example to .env. Leonardo owns token mint (Rec0C3QKVTL0Y).",
    );
  }
  return token;
}

export function tryGetAccessToken(): string | undefined {
  return process.env.META_ACCESS_TOKEN?.trim() || undefined;
}

export function getGraphVersion(): string {
  return process.env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
}

export class MetaClient {
  readonly graphVersion: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MetaClientOptions) {
    this.accessToken = opts.accessToken;
    this.graphVersion = opts.graphVersion ?? DEFAULT_GRAPH_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Never log the return value of url() — it includes the token. Use redactedUrl(). */
  url(path: string, params: GraphParams = {}, redact = false): string {
    const clean = path.replace(/^\//, "");
    const u = new URL(`${GRAPH_BASE}/${this.graphVersion}/${clean}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
    u.searchParams.set("access_token", redact ? "[REDACTED]" : this.accessToken);
    return u.toString();
  }

  redactedUrl(path: string, params: GraphParams = {}): string {
    return this.url(path, params, true);
  }

  /** Clone with a Page token (or any other token) without logging it. */
  withToken(accessToken: string): MetaClient {
    return new MetaClient({
      accessToken,
      graphVersion: this.graphVersion,
      fetchImpl: this.fetchImpl,
    });
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: {
      query?: GraphParams;
      body?: Record<string, unknown>;
      dryRun?: boolean;
      encoding?: "json" | "form";
    } = {},
  ): Promise<
    | T
    | {
        dryRun: true;
        method: string;
        path: string;
        query?: GraphParams;
        body?: Record<string, unknown>;
      }
  > {
    if (options.dryRun && method !== "GET") {
      return {
        dryRun: true,
        method,
        path,
        query: options.query,
        body: options.body,
      };
    }

    const isGet = method === "GET";
    const url = this.url(path, isGet ? { ...options.query, ...flattenBodyAsQuery(options.body) } : options.query);

    const init: RequestInit = { method };
    if (!isGet && options.body) {
      const encoding = options.encoding ?? "form";
      if (encoding === "json") {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(options.body);
      } else {
        init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
        init.body = encodeForm(options.body);
      }
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new MetaApiError(`Graph request failed: ${safeErrorMessage(err)}`, 0, null);
    }

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: redactString(text) };
    }
    parsed = redactDeep(parsed);

    if (!res.ok) {
      const errMsg =
        typeof parsed === "object" &&
        parsed &&
        "error" in parsed &&
        typeof (parsed as { error?: { message?: string } }).error?.message === "string"
          ? (parsed as { error: { message: string } }).error.message
          : `Meta Graph API ${res.status}`;
      throw new MetaApiError(errMsg, res.status, parsed);
    }

    return parsed as T;
  }

  get<T = unknown>(path: string, query?: GraphParams) {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
    opts?: { query?: GraphParams; dryRun?: boolean; encoding?: "json" | "form" },
  ) {
    return this.request<T>("POST", path, {
      body,
      query: opts?.query,
      dryRun: opts?.dryRun,
      encoding: opts?.encoding,
    });
  }

  delete<T = unknown>(path: string, opts?: { query?: GraphParams; dryRun?: boolean }) {
    return this.request<T>("DELETE", path, { query: opts?.query, dryRun: opts?.dryRun });
  }
}

function flattenBodyAsQuery(body?: Record<string, unknown>): GraphParams {
  if (!body) return {};
  const out: GraphParams = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object") out[k] = JSON.stringify(v);
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

function encodeForm(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    if (k === "children" && Array.isArray(v)) {
      params.set(k, v.map(String).join(","));
    } else if (typeof v === "object") {
      params.set(k, JSON.stringify(v));
    } else {
      params.set(k, String(v));
    }
  }
  return params.toString();
}

export function createMetaClientFromEnv(fetchImpl?: typeof fetch): MetaClient {
  return new MetaClient({
    accessToken: getAccessTokenFromEnv(),
    graphVersion: getGraphVersion(),
    fetchImpl,
  });
}

export function createMetaClientOptional(fetchImpl?: typeof fetch): MetaClient | null {
  const token = tryGetAccessToken();
  if (!token) return null;
  return new MetaClient({
    accessToken: token,
    graphVersion: getGraphVersion(),
    fetchImpl,
  });
}

import { randomBytes } from "node:crypto";
import { prepareHostedBytes } from "./image-bytes.js";
import { redactString } from "./safety.js";

/**
 * Durable bytes both Meta and TikTok can fetch.
 * `github-static` commits into the adeptos.ai landing repo (files under public/ are served
 * at https://adeptos.ai/<path> after the main-branch auto-deploy). Another kind (S3/R2)
 * can implement the same interface later.
 */
export interface MediaStorage {
  readonly kind: string;
  isDurable(url: string): boolean;
  put(input: { bytes: Uint8Array; contentType: string; filename: string }): Promise<{ url: string; path: string }>;
}

export type GitHubStaticOptions = {
  token: string;
  repo: string;
  branch: string;
  /** Repo path prefix. Default `public/content-mcp` so the site serves `/content-mcp/...`. */
  pathPrefix: string;
  /** Public origin, no trailing slash. Default `https://adeptos.ai`. */
  publicBase: string;
  waitMs: number;
  pollMs: number;
  apiBase: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

const DEFAULT_REPO = "adeptos-ai/landing-adeptos";
const DEFAULT_PREFIX = "public/content-mcp";
const DEFAULT_PUBLIC_BASE = "https://adeptos.ai";

function intEnv(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function mediaStorageMode(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CONTENT_MEDIA_STORAGE ?? "off").trim().toLowerCase() || "off";
}

/** `null` when hosting is off (the default). Throws on an unknown mode so a typo is not silent. */
export function mediaStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  sleep?: (ms: number) => Promise<void>,
): MediaStorage | null {
  const mode = mediaStorageMode(env);
  if (mode === "off" || mode === "0" || mode === "false" || mode === "none") return null;
  if (mode === "github-static") return GitHubStaticStorage.fromEnv(env, fetchImpl, sleep);
  throw new Error(`unknown CONTENT_MEDIA_STORAGE=${mode}. Supported: off, github-static.`);
}

export class GitHubStaticStorage implements MediaStorage {
  readonly kind = "github-static";

  constructor(private readonly opts: GitHubStaticOptions) {
    if (!opts.token.trim()) throw new Error("GITHUB_STATIC_TOKEN is required when CONTENT_MEDIA_STORAGE=github-static");
    if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
      throw new Error("GITHUB_STATIC_REPO must look like owner/name");
    }
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl: typeof fetch = fetch,
    sleep?: (ms: number) => Promise<void>,
  ): GitHubStaticStorage {
    const token = env.GITHUB_STATIC_TOKEN?.trim() ?? "";
    if (!token) {
      throw new Error(
        "GITHUB_STATIC_TOKEN is required when CONTENT_MEDIA_STORAGE=github-static. Use a token that can write contents on the landing repo. Do not commit it.",
      );
    }
    return new GitHubStaticStorage({
      token,
      repo: env.GITHUB_STATIC_REPO?.trim() || DEFAULT_REPO,
      branch: env.GITHUB_STATIC_BRANCH?.trim() || "main",
      pathPrefix: (env.GITHUB_STATIC_PATH_PREFIX?.trim() || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, ""),
      publicBase: (env.GITHUB_STATIC_PUBLIC_BASE?.trim() || DEFAULT_PUBLIC_BASE).replace(/\/+$/, ""),
      waitMs: intEnv(env.GITHUB_STATIC_WAIT_MS, 120_000, 0),
      pollMs: intEnv(env.GITHUB_STATIC_POLL_MS, 3_000, 0),
      apiBase: (env.GITHUB_STATIC_API_BASE?.trim() || "https://api.github.com").replace(/\/+$/, ""),
      fetchImpl,
      sleep,
    });
  }

  isDurable(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.opts.publicBase).origin;
    } catch {
      return false;
    }
  }

  async put(input: { bytes: Uint8Array; contentType: string; filename: string }): Promise<{ url: string; path: string }> {
    const prepared = prepareHostedBytes(input.bytes, input.contentType, input.filename);
    const day = (this.opts.now?.() ?? new Date()).toISOString().slice(0, 10);
    const name = `${day}/${randomBytes(8).toString("hex")}.${prepared.ext}`;
    const repoPath = `${this.opts.pathPrefix}/${name}`.replace(/\/{2,}/g, "/");
    await this.commit(repoPath, prepared.bytes);
    const url = publicUrlFor(this.opts.publicBase, repoPath);
    await this.waitUntilLive(url);
    return { url, path: repoPath };
  }

  private async commit(repoPath: string, bytes: Uint8Array): Promise<void> {
    const encodedPath = repoPath
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const [owner, name] = this.opts.repo.split("/");
    const endpoint = `${this.opts.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath}`;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "adeptos-content-mcp",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          message: `content-mcp: host ${repoPath.split("/").pop()}`,
          content: Buffer.from(bytes).toString("base64"),
          branch: this.opts.branch,
        }),
      });
    } catch (err) {
      throw new Error(`github_static_put_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(githubError(res.status, text, this.opts.token));
    }
  }

  private async waitUntilLive(url: string): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + this.opts.waitMs;
    let last = 0;
    for (;;) {
      try {
        const res = await fetchImpl(url, { method: "HEAD" });
        if (res.status === 200) return;
        last = res.status;
      } catch {
        last = 0;
      }
      if (Date.now() >= deadline) {
        throw new Error(`github_static_not_live: HEAD ${url} last_status=${last}. The landing deploy may still be running.`);
      }
      if (this.opts.pollMs > 0) await sleep(this.opts.pollMs);
    }
  }
}

export function publicUrlFor(publicBase: string, repoPath: string): string {
  const relative = repoPath.replace(/^public\//, "").replace(/^\/+/, "");
  return `${publicBase.replace(/\/+$/, "")}/${relative}`;
}

function githubError(status: number, body: string, token: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) detail = `: ${parsed.message}`;
  } catch {
    detail = body.trim() ? `: ${body.trim().slice(0, 180)}` : "";
  }
  let message = `github_static_put_failed: HTTP ${status}${detail}`;
  if (token) message = message.split(token).join("[REDACTED]");
  return redactString(message);
}

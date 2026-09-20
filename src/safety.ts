/**
 * Write-tool safety gate + secret redaction.
 * Publish / schedule / cancel require confirm:true. Without it, callers get a preview only.
 * Never log or return tokens.
 */

export type WriteSafetyArgs = {
  confirm?: boolean;
  dryRun?: boolean;
};

export type SafetyDecision =
  | { mode: "preview"; message: string }
  | { mode: "execute"; dryRun: boolean };

export const CONFIRM_PREVIEW_MESSAGE =
  "Preview only: publish/schedule/cancel require confirm:true. " +
  "No Meta/TikTok/YouTube mutation ran. Ryan must approve in chat before Content sets confirm:true.";

export function requireConfirm(args: WriteSafetyArgs): SafetyDecision {
  if (args.confirm !== true) {
    return { mode: "preview", message: CONFIRM_PREVIEW_MESSAGE };
  }
  return { mode: "execute", dryRun: args.dryRun === true };
}

const TOKEN_QUERY = /(?:access_token|refresh_token|client_secret)=[^&\s#"]+/gi;
const META_TOKEN = /\bEAA[A-Za-z0-9]+/g;
const TIKTOK_TOKEN = /\bact\.[A-Za-z0-9]+/g;
const GOOGLE_ACCESS = /\bya29\.[A-Za-z0-9._\-+/]+/g;
const GOOGLE_REFRESH = /\b1\/\/[A-Za-z0-9_\-+/]+/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SECRET_KEY =
  /^(access_token|refresh_token|token|authorization|password|secret|api[_-]?key|meta_access_token|tiktok_access_token|tiktok_refresh_token|tiktok_client_secret|youtube_refresh_token|youtube_client_secret|linkedin_access_token|x_access_token|x_access_token_secret|x_api_secret|client_secret|client_key)$/i;

export function redactString(value: string): string {
  return value
    .replace(TOKEN_QUERY, (m) => `${m.split("=")[0]}=[REDACTED]`)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(META_TOKEN, "[REDACTED_TOKEN]")
    .replace(TIKTOK_TOKEN, "[REDACTED_TOKEN]")
    .replace(GOOGLE_ACCESS, "[REDACTED_TOKEN]")
    .replace(GOOGLE_REFRESH, "[REDACTED_TOKEN]");
}

export function redactDeep<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value) as T;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return redactString(err.message);
  return redactString(String(err));
}

export function textResult(payload: unknown, isError = false) {
  const safe = redactDeep(payload);
  return {
    content: [
      {
        type: "text" as const,
        text: typeof safe === "string" ? safe : JSON.stringify(safe, null, 2),
      },
    ],
    isError,
  };
}

/** Safe stderr logger — never prints tokens. */
export function logInfo(scope: string, message: string, extra?: unknown): void {
  const bits = [`[${scope}]`, redactString(message)];
  if (extra !== undefined) bits.push(JSON.stringify(redactDeep(extra)));
  console.error(bits.join(" "));
}

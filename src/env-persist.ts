/**
 * Hotfix 2026-10-06: persist rotated OAuth tokens back into the runtime .env.
 * Rewrites only the matching KEY= lines (appends missing keys), keeps mode 600, atomic rename.
 * Never logs values. Disabled under `node --test` and when CONTENT_MCP_ENV_PERSIST=0.
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function defaultEnvPath(): string {
  return process.env.CONTENT_MCP_ENV_FILE?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
}

export function envPersistEnabled(): boolean {
  if (process.env.CONTENT_MCP_ENV_PERSIST === "0") return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  return true;
}

function unquote(val: string): string {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

/** Read one KEY from the .env file on disk (another instance may have rotated it). */
export function readEnvFileValue(key: string, envPath = defaultEnvPath()): string | undefined {
  if (!envPersistEnabled() || !existsSync(envPath)) return undefined;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    const v = unquote(line.slice(eq + 1).trim());
    return v || undefined;
  }
  return undefined;
}

/**
 * Set KEY=value for each entry: updates process.env always, and the .env file when persistence is enabled.
 * Returns the keys actually written to disk (names only).
 */
export function persistEnvValues(updates: Record<string, string>, envPath = defaultEnvPath()): string[] {
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
  if (!envPersistEnabled() || !existsSync(envPath)) return [];
  const original = readFileSync(envPath, "utf8");
  const lines = original.split("\n");
  const pending = new Map(Object.entries(updates));
  const written: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!pending.has(key)) continue;
    const value = pending.get(key)!;
    if (unquote(trimmed.slice(eq + 1).trim()) !== value) {
      lines[i] = `${key}=${value}`;
      written.push(key);
    }
    pending.delete(key);
  }
  for (const [key, value] of pending) {
    if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, `${key}=${value}`);
    else lines.push(`${key}=${value}`);
    written.push(key);
  }
  if (!written.length) return [];
  const tmp = `${envPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, envPath);
  return written;
}

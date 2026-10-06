import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Load .env into process.env. Prefer file values for BRAND_* / META_* so host-injected empties cannot win. */
export function loadEnvFile(root = join(dirname(fileURLToPath(import.meta.url)), "..")): void {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    const existing = process.env[key];
    const preferFile =
      key.startsWith("BRAND_") ||
      key.startsWith("META_") ||
      !existing ||
      !existing.trim();
    if (preferFile) process.env[key] = val;
  }
}

loadEnvFile();

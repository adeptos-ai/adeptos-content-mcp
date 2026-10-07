import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSingleStore, defaultDataDir, PACKAGE_ROOT } from "../src/store.js";

describe("single job store", () => {
  let root: string;
  const saved = { dir: process.env.CONTENT_DATA_DIR, allow: process.env.CONTENT_ALLOW_STRAY_STORE };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "single-store-"));
    delete process.env.CONTENT_ALLOW_STRAY_STORE;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (saved.dir === undefined) delete process.env.CONTENT_DATA_DIR;
    else process.env.CONTENT_DATA_DIR = saved.dir;
    if (saved.allow === undefined) delete process.env.CONTENT_ALLOW_STRAY_STORE;
    else process.env.CONTENT_ALLOW_STRAY_STORE = saved.allow;
  });

  it("falls back to <package>/data, never the cwd", () => {
    delete process.env.CONTENT_DATA_DIR;
    const before = process.cwd();
    process.chdir(root);
    try {
      assert.equal(defaultDataDir(), join(PACKAGE_ROOT, "data"));
    } finally {
      process.chdir(before);
    }
  });

  it("resolves CONTENT_DATA_DIR to an absolute path", () => {
    process.env.CONTENT_DATA_DIR = "relative/dir";
    assert.equal(defaultDataDir(), resolve("relative/dir"));
  });

  it("refuses to start when a second unmerged schedules.json exists, and accepts it once marked", () => {
    const canon = join(root, "canon");
    const stray = join(root, "stray");
    mkdirSync(canon, { recursive: true });
    mkdirSync(stray, { recursive: true });
    process.env.CONTENT_DATA_DIR = canon;
    writeFileSync(join(stray, "schedules.json"), JSON.stringify({ jobs: [] }));
    const logs: string[] = [];
    const opts = { log: (m: string) => logs.push(m), candidates: [canon, stray] };
    assert.throws(() => assertSingleStore(opts), /second schedule store/);
    process.env.CONTENT_ALLOW_STRAY_STORE = "1";
    assert.equal(assertSingleStore(opts), resolve(canon));
    assert.ok(logs.some((l) => l.startsWith("WARN")));
    delete process.env.CONTENT_ALLOW_STRAY_STORE;
    writeFileSync(join(stray, "MIGRATED_TO"), canon);
    assert.equal(assertSingleStore(opts), resolve(canon));
  });
});

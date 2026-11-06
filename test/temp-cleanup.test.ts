import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { cleanupStaleWorkDirs } from "../src/core/temp-cleanup";

test("removes only stale vc-work directories", () => {
  const root = mkdtempSync(join(tmpdir(), "vc-cleanup-root-"));
  try {
    const stale = join(root, "vc-work-stale");
    const fresh = join(root, "vc-work-fresh");
    const other = join(root, "other-dir");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(stale, "ffmpeg-pass-0.log"), "x");
    writeFileSync(join(fresh, "output.mp4"), "y");
    writeFileSync(join(other, "keep.txt"), "z");

    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    const result = cleanupStaleWorkDirs({ root, maxAgeMs: 2 * 60 * 60 * 1000 });
    assert.equal(result.scanned, 2);
    assert.deepEqual(result.removed, [stale]);
    assert.equal(result.failed.length, 0);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(other), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("never throws when root is missing", () => {
  const result = cleanupStaleWorkDirs({ root: join(tmpdir(), `vc-missing-${Date.now()}`) });
  assert.equal(result.scanned, 0);
  assert.deepEqual(result.removed, []);
});

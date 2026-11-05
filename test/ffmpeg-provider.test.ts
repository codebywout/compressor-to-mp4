import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { FfmpegProvider, validateArchiveListing } from "../src/core/ffmpeg-provider";

test("reports missing FFmpeg without throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "video-compressor-"));
  const previousPath = process.env.PATH;
  const previousLocal = process.env.LOCALAPPDATA;
  try {
    // Isolate from the machine PATH and WinGet packages so the test stays deterministic.
    process.env.PATH = root;
    process.env.LOCALAPPDATA = join(root, "LocalAppData");
    const status = await new FfmpegProvider(join(root, "bundled"), join(root, "user"), join(root, "no-winget")).detect();
    assert.equal(status.available, false);
    assert.match(status.message, /niet gevonden|ongeldig/i);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid manually selected installations", async () => {
  const root = mkdtempSync(join(tmpdir(), "video-compressor-"));
  try {
    await assert.rejects(() => new FfmpegProvider(join(root, "bundled"), join(root, "user")).select(root), /ongeldig/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects archive path traversal", () => {
  assert.throws(() => validateArchiveListing("ffmpeg/bin/ffmpeg.exe\n../../outside.exe"), /path traversal/i);
  assert.doesNotThrow(() => validateArchiveListing("ffmpeg/bin/ffmpeg.exe\nffmpeg/bin/ffprobe.exe"));
});

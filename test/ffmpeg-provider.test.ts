import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseEncoderSupport } from "../src/core/app-storage";
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
    assert.equal(status.codecs.h264, false);
    assert.equal(status.codecs.h265, false);
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

test("H.264 present without H.265 is distinguishable", () => {
  const codecs = parseEncoderSupport("Encoders:\n V..... libx264 H.264 / AVC\n A..... aac AAC");
  assert.equal(codecs.h264, true);
  assert.equal(codecs.h265, false);
  assert.equal(codecs.aac, true);
});

test("H.265 libx265 is detected when listed", () => {
  const codecs = parseEncoderSupport(" V..... libx264\n V..... libx265\n A..... aac");
  assert.equal(codecs.h265, true);
});

test("empty encoder listing reports no codecs", () => {
  const codecs = parseEncoderSupport("Encoders:\n");
  assert.deepEqual(codecs, { h264: false, h265: false, aac: false });
});

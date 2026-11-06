import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeFfmpegLog, translateFfmpegFailure } from "../src/core/compressor";

test("sanitizeFfmpegLog strips configure dumps with --enable-nvenc", () => {
  const raw = [
    "ffmpeg version 9.0.2",
    "configuration: --enable-gpl --enable-nvenc --enable-amf --enable-libx264",
    "Error opening input file not-a-video.mp4.",
    "Error opening input files: Invalid data found when processing input"
  ].join("\n");
  const cleaned = sanitizeFfmpegLog(raw);
  assert.equal(/nvenc/i.test(cleaned), false);
  assert.match(cleaned, /Invalid data found/);
});

test("translateFfmpegFailure does not blame NVENC for invalid input when configure lists nvenc", () => {
  const raw = [
    "configuration: --enable-nvenc --enable-amf --enable-libvmaf",
    "Error opening input file bad.mp4.",
    "Invalid data found when processing input"
  ].join("\n");
  const message = translateFfmpegFailure(1, raw);
  assert.equal(/NVIDIA NVENC/i.test(message), false);
  assert.match(message, /kon het bestand niet verwerken/i);
});

test("translateFfmpegFailure still detects real NVENC session errors", () => {
  const raw = "OpenEncodeSessionEx failed: unsupported device (NVENC)";
  const message = translateFfmpegFailure(1, raw);
  assert.match(message, /NVIDIA NVENC/i);
});

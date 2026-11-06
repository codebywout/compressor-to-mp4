#!/usr/bin/env node
/**
 * One-shot encoder benchmark for Phase 3.
 * Usage: node scripts/bench-encoders.js <ffmpeg> <input> <preference> <preset> <targetMb>
 */
const { Compressor } = require("../dist/src/core/compressor");
const { EMPTY_HARDWARE } = require("../dist/src/core/encoders");
const { existsSync, statSync } = require("node:fs");
const { dirname } = require("node:path");

async function main() {
  const [ffmpeg, input, preference, preset, targetRaw] = process.argv.slice(2);
  if (!ffmpeg || !input || !preference || !preset) {
    console.error("Usage: node scripts/bench-encoders.js <ffmpeg> <input> <preference> <preset> <targetMb>");
    process.exit(2);
  }
  if (!existsSync(ffmpeg) || !existsSync(input)) {
    console.error("ffmpeg or input missing");
    process.exit(2);
  }
  const targetMb = Number(targetRaw || 8);
  const size = statSync(input).size;
  const hardware = preference === "cpu"
    ? EMPTY_HARDWARE
    : {
        nvidia: { h264: true, h265: true },
        intel: { h264: false, h265: false },
        amd: { h264: true, h265: true }
      };
  const metadata = {
    size,
    duration: 30,
    width: 1920,
    height: 1080,
    frameRate: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    audioChannels: 2,
    audioSampleRate: 48000
  };
  const settings = {
    mode: "compress",
    targetMb,
    videoCodec: "h264",
    audioBitrateKbps: 128,
    resolution: "original",
    frameRate: "original",
    preset,
    keepAudio: true,
    encoderPreference: preference
  };
  const compressor = new Compressor();
  const started = Date.now();
  const result = await compressor.compress(ffmpeg, input, metadata, settings, () => undefined, {
    outputDirectory: dirname(input),
    hardware
  });
  console.log(JSON.stringify({
    preference,
    preset,
    wallMs: Date.now() - started,
    outMb: Number((result.outputBytes / 1_000_000).toFixed(2)),
    limitOk: result.outputBytes <= targetMb * 1_000_000,
    encoder: result.performance?.encoderLabel,
    encodingMs: result.performance?.encodingMs,
    attempts: result.performance?.attempts,
    fallback: result.performance?.fellBackToCpu,
    output: result.outputPath
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});

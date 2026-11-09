#!/usr/bin/env node
/** One-shot compress: node scripts/compress-one.js <ffmpeg> <input> <targetMb> [preference] [preset] */
const { existsSync, statSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { Compressor } = require("../dist/src/core/compressor");
const { EMPTY_HARDWARE } = require("../dist/src/core/encoders");
const { probeFile } = require("../dist/src/core/probe");
const { planSizeBudget } = require("../dist/src/core/bitrate");

async function main() {
  const [ffmpeg, input, targetRaw, preference = "nvidia", preset = "fast"] = process.argv.slice(2);
  if (!ffmpeg || !input || !targetRaw) {
    console.error("Usage: node scripts/compress-one.js <ffmpeg> <input> <targetMb> [preference] [preset]");
    process.exit(2);
  }
  if (!existsSync(ffmpeg) || !existsSync(input)) {
    console.error("ffmpeg or input missing");
    process.exit(2);
  }
  const targetMb = Number(targetRaw);
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  const metadata = await probeFile(ffprobe, input);
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
  const budget = planSizeBudget(targetMb, metadata.duration, settings);
  console.log(JSON.stringify({ metadata: { duration: metadata.duration, width: metadata.width, height: metadata.height, sizeMb: +(metadata.size / 1e6).toFixed(1) }, budget }, null, 2));

  const hardware = preference === "cpu"
    ? EMPTY_HARDWARE
    : { nvidia: { h264: true, h265: true }, intel: { h264: false, h265: false }, amd: { h264: true, h265: true } };

  const compressor = new Compressor();
  const started = Date.now();
  const result = await compressor.compress(ffmpeg, input, metadata, settings, (p) => {
    if (p.percent % 5 < 1 || p.percent > 95) {
      process.stdout.write(`\r${p.percent}% ${p.message || ""} ${p.speed || ""}   `);
    }
  }, {
    outputDirectory: dirname(input),
    hardware
  });
  console.log("\n" + JSON.stringify({
    ok: result.outputBytes <= targetMb * 1e6,
    outMb: +(result.outputBytes / 1e6).toFixed(2),
    targetMb,
    outputPath: result.outputPath,
    encoder: result.performance?.encoderLabel,
    attempts: result.performance?.attempts,
    encodeMs: result.performance?.encodingMs,
    wallMs: Date.now() - started
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

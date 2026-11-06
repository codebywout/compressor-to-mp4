#!/usr/bin/env node
/**
 * Quality + size check for one encode.
 * Usage:
 *   node scripts/bench-quality.js <ffmpeg> <input> <preference> <preset> <targetMb> [duration] [width] [height]
 */
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, rmSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { Compressor } = require("../dist/src/core/compressor");
const { EMPTY_HARDWARE } = require("../dist/src/core/encoders");

function run(ffmpeg, args) {
  const result = spawnSync(ffmpeg, args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status
  };
}

function parseSsim(text) {
  const match = /SSIM.*All:([0-9.]+)/i.exec(text);
  return match ? Number(match[1]) : null;
}

function parseVmaf(text) {
  // Prefer pooled/mean metrics; avoid matching model max=100 style fields.
  const mean = /"mean"\s*:\s*([0-9.]+)/i.exec(text)
    || /"harmonic_mean"\s*:\s*([0-9.]+)/i.exec(text)
    || /VMAF score:\s*([0-9.]+)/i.exec(text);
  if (mean) return Number(mean[1]);
  const frames = [...text.matchAll(/"vmaf"\s*:\s*([0-9.]+)/gi)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
  if (frames.length > 1) {
    return frames.reduce((sum, value) => sum + value, 0) / frames.length;
  }
  return frames.length === 1 ? frames[0] : null;
}

async function main() {
  const [ffmpeg, input, preference, preset, targetRaw, durationRaw, widthRaw, heightRaw] = process.argv.slice(2);
  if (!ffmpeg || !input || !preference || !preset) {
    console.error("Usage: node scripts/bench-quality.js <ffmpeg> <input> <preference> <preset> <targetMb> [duration] [width] [height]");
    process.exit(2);
  }
  const targetMb = Number(targetRaw || 8);
  const duration = Number(durationRaw || 30);
  const width = Number(widthRaw || 1920);
  const height = Number(heightRaw || 1080);
  const work = join(tmpdir(), `vc-quality-${Date.now()}`);
  mkdirSync(work, { recursive: true });

  const hardware = preference === "cpu"
    ? EMPTY_HARDWARE
    : {
        nvidia: { h264: true, h265: true },
        intel: { h264: false, h265: false },
        amd: { h264: true, h265: true }
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
  const metadata = {
    size: statSync(input).size,
    duration,
    width,
    height,
    frameRate: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    audioChannels: 2,
    audioSampleRate: 48000
  };

  const compressor = new Compressor();
  const started = Date.now();
  const encoded = await compressor.compress(ffmpeg, input, metadata, settings, () => undefined, {
    outputDirectory: work,
    hardware
  });
  const encodeMs = Date.now() - started;

  let ssim = null;
  let vmaf = null;
  let vmafAvailable = true;
  let ssimAvailable = true;

  const ssimRun = run(ffmpeg, [
    "-hide_banner", "-i", input, "-i", encoded.outputPath,
    "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"
  ]);
  ssim = parseSsim(`${ssimRun.stdout}\n${ssimRun.stderr}`);
  if (ssim == null) ssimAvailable = /No such filter|not found/i.test(`${ssimRun.stderr}`);

  const vmafLog = join(work, "vmaf.json");
  const vmafRun = run(ffmpeg, [
    "-hide_banner", "-i", input, "-i", encoded.outputPath,
    "-lavfi", `[0:v]setpts=PTS-STARTPTS[ref];[1:v]setpts=PTS-STARTPTS[dist];[ref][dist]libvmaf=n_threads=4:log_fmt=json:log_path='${vmafLog.replaceAll("\\", "/")}'`,
    "-f", "null", "-"
  ]);
  let vmafText = `${vmafRun.stdout}\n${vmafRun.stderr}`;
  try {
    if (existsSync(vmafLog)) vmafText += `\n${require("node:fs").readFileSync(vmafLog, "utf8")}`;
  } catch {
    // ignore
  }
  vmaf = parseVmaf(vmafText);
  if (vmaf == null) {
    // Fallback: many builds print a summary line on stderr.
    const summary = run(ffmpeg, [
      "-hide_banner", "-i", input, "-i", encoded.outputPath,
      "-lavfi", "[0:v][1:v]libvmaf",
      "-f", "null", "-"
    ]);
    vmaf = parseVmaf(`${summary.stdout}\n${summary.stderr}`);
    vmafText += `\n${summary.stderr}`;
  }
  if (vmaf == null) {
    const filters = run(ffmpeg, ["-hide_banner", "-filters"]);
    vmafAvailable = /\blibvmaf\b/.test(`${filters.stdout}\n${filters.stderr}`);
    ssimAvailable = /\bssim\b/.test(`${filters.stdout}\n${filters.stderr}`);
  }

  console.log(JSON.stringify({
    preference,
    preset,
    encodeMs,
    outMb: Number((encoded.outputBytes / 1_000_000).toFixed(2)),
    limitOk: encoded.outputBytes <= targetMb * 1_000_000,
    encoder: encoded.performance?.encoderLabel,
    attempts: encoded.performance?.attempts,
    fallback: encoded.performance?.fellBackToCpu || false,
    ssim,
    vmaf,
    ssimAvailable,
    vmafAvailable,
    duration,
    width,
    height
  }));

  rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});

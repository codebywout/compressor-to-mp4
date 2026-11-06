#!/usr/bin/env node
/**
 * Focused Phase 6 recheck after fixes (quality, batch30, invalid input).
 */
const { spawnSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { Compressor, translateFfmpegFailure } = require("../dist/src/core/compressor");
const { BatchManager } = require("../dist/src/core/batch-manager");
const { EMPTY_HARDWARE, selectEncoder } = require("../dist/src/core/encoders");
const { computeAdaptiveConcurrency, maxPixelsInBatch } = require("../dist/src/core/concurrency");
const { readSystemResources } = require("../dist/src/core/system-resources");
const { probeFile } = require("../dist/src/core/probe");

const HARDWARE = {
  nvidia: { h264: true, h265: true },
  intel: { h264: false, h265: false },
  amd: { h264: true, h265: true }
};

function settingsBase(overrides = {}) {
  return {
    mode: "compress",
    targetMb: 8,
    videoCodec: "h264",
    audioBitrateKbps: 128,
    resolution: "original",
    frameRate: "original",
    preset: "fast",
    keepAudio: true,
    encoderPreference: "auto",
    ...overrides
  };
}

function parseSsim(text) {
  const match = /SSIM.*All:([0-9.]+)/i.exec(text);
  return match ? Number(match[1]) : null;
}

function parseVmaf(text) {
  const mean = /"mean"\s*:\s*([0-9.]+)/i.exec(text)
    || /"harmonic_mean"\s*:\s*([0-9.]+)/i.exec(text)
    || /VMAF score:\s*([0-9.]+)/i.exec(text);
  if (mean) return Number(mean[1]);
  return null;
}

function measureQuality(ffmpeg, reference, distorted) {
  const ssim = spawnSync(ffmpeg, [
    "-hide_banner", "-i", distorted, "-i", reference,
    "-lavfi", "[0:v][1:v]scale2ref=flags=bicubic[dist][ref];[dist][ref]ssim",
    "-f", "null", "-"
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const ssimText = `${ssim.stdout || ""}\n${ssim.stderr || ""}`;
  const vmaf = spawnSync(ffmpeg, [
    "-hide_banner", "-i", distorted, "-i", reference,
    "-lavfi", "[0:v][1:v]scale2ref=flags=bicubic[dist][ref];[dist][ref]libvmaf=log_fmt=json:log_path=NUL:n_threads=4",
    "-f", "null", "-"
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const vmafText = `${vmaf.stdout || ""}\n${vmaf.stderr || ""}`;
  return { ssim: parseSsim(ssimText), vmaf: parseVmaf(vmafText) };
}

async function main() {
  const ffmpeg = process.argv[2] || "ffmpeg";
  const mediaDir = process.argv[3] || join(tmpdir(), "vc-phase6-media");
  const outDir = process.argv[4] || join(process.cwd(), "scripts", "phase6-results", "recheck");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(mediaDir, "manifest.json"), "utf8"));
  const files = manifest.files.filter((f) => existsSync(f.path));
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  const rows = [];

  // False NVENC message unit check
  rows.push({
    kind: "translate_guard",
    message: translateFfmpegFailure(1, "configuration: --enable-nvenc --enable-amf\nInvalid data found when processing input")
  });

  // Invalid input message
  {
    const bad = join(outDir, "bad.mp4");
    writeFileSync(bad, "not a video");
    try {
      await new Compressor().compress(ffmpeg, bad, {
        size: 10, duration: 5, width: 640, height: 360, frameRate: 30,
        videoCodec: "h264", audioCodec: null, audioChannels: null, audioSampleRate: null
      }, settingsBase({ targetMb: 5, encoderPreference: "cpu", preset: "ultrafast" }), () => {}, {
        outputDirectory: outDir,
        hardware: EMPTY_HARDWARE
      });
      rows.push({ kind: "invalid_input", status: "unexpected_success" });
    } catch (error) {
      const msg = String(error.message || error);
      rows.push({
        kind: "invalid_input",
        status: /NVIDIA NVENC/i.test(msg) ? "false_nvenc" : "ok",
        error: msg.slice(0, 240)
      });
    }
  }

  // Quality on high motion + public BBB with forced re-encode
  for (const id of ["public_bbb_short", "high_motion_1080p60", "phone_like_1080p"]) {
    const clip = files.find((f) => f.id === id);
    if (!clip) continue;
    const metadata = await probeFile(ffprobe, clip.path);
    const sourceMb = clip.sizeBytes / 1_000_000;
    const targetMb = Math.max(2, Math.min(Math.floor(sourceMb * 0.55) || 2, 12));
    if (targetMb * 1_000_000 >= clip.sizeBytes) continue;
    let cpuSsim = null;
    for (const preference of ["cpu", "nvidia", "amd"]) {
      const work = join(outDir, "q", id, preference);
      mkdirSync(work, { recursive: true });
      const inputCopy = join(work, "src.mp4");
      copyFileSync(clip.path, inputCopy);
      try {
        const result = await new Compressor().compress(
          ffmpeg, inputCopy, metadata,
          settingsBase({
            targetMb,
            encoderPreference: preference,
            preset: preference === "cpu" ? "medium" : "fast"
          }),
          () => {},
          { outputDirectory: work, hardware: preference === "cpu" ? EMPTY_HARDWARE : HARDWARE }
        );
        const q = measureQuality(ffmpeg, clip.path, result.outputPath);
        if (preference === "cpu") cpuSsim = q.ssim;
        rows.push({
          kind: "quality",
          clipId: id,
          preference,
          encoder: result.performance?.encoderLabel,
          targetMb,
          outMb: Number((result.outputBytes / 1_000_000).toFixed(2)),
          limitOk: result.outputBytes <= targetMb * 1_000_000,
          ssim: q.ssim,
          vmaf: q.vmaf,
          ssimDeltaVsCpu: cpuSsim != null && q.ssim != null ? Number((q.ssim - cpuSsim).toFixed(5)) : null,
          streamCopy: /stream copy/i.test(result.performance?.encoderLabel || "")
        });
      } catch (error) {
        rows.push({ kind: "quality", clipId: id, preference, targetMb, error: String(error.message || error) });
      }
    }
  }

  // Batch 30 + missing file
  {
    const base = files.find((f) => f.id === "silent_720p") || files[0];
    const metadata = await probeFile(ffprobe, base.path);
    const work = join(outDir, "batch30");
    mkdirSync(work, { recursive: true });
    const items = [];
    for (let i = 0; i < 30; i++) {
      const dir = join(work, `d${i % 2}`, `n${i}`);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "same-name.mp4");
      copyFileSync(base.path, path);
      items.push({
        id: `batch-${i}`,
        inputPath: path,
        metadata: { ...metadata, size: statSync(path).size },
        settings: settingsBase({ targetMb: 4, encoderPreference: "auto", preset: "fast" }),
        status: "queued",
        progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" }
      });
    }
    items.push({
      id: "batch-missing",
      inputPath: join(work, "missing.mp4"),
      metadata: { ...metadata, size: 1 },
      settings: settingsBase({ targetMb: 4, encoderPreference: "auto", preset: "fast" }),
      status: "queued",
      progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" }
    });
    const resources = await readSystemResources();
    const selected = selectEncoder("auto", "h264", HARDWARE);
    const concurrency = computeAdaptiveConcurrency({
      family: selected.family,
      maxPixels: maxPixelsInBatch(items.filter((i) => i.id !== "batch-missing")),
      resources,
      maxConcurrency: 8
    });
    const started = Date.now();
    const finished = await new BatchManager(ffmpeg, concurrency, {
      hardware: HARDWARE,
      runtime: {
        concurrency,
        concurrencyMode: "auto",
        encoderFamily: selected.family,
        encoderLabel: selected.label
      }
    }).start(items, () => {});
    const completed = finished.filter((i) => i.status === "completed").length;
    const failed = finished.filter((i) => i.status === "failed");
    rows.push({
      kind: "batch30",
      concurrency,
      wallMs: Date.now() - started,
      completed,
      failed: failed.length,
      missingFailedAlone: failed.some((i) => i.id === "batch-missing") && failed.every((i) => i.id === "batch-missing"),
      statusCounts: finished.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {})
    });
  }

  const summary = {
    ok: !rows.some((row) =>
      (row.kind === "invalid_input" && row.status !== "ok")
      || (row.kind === "batch30" && (row.completed < 30 || !row.missingFailedAlone))
      || (row.kind === "quality" && (row.error || row.streamCopy || row.limitOk === false))
      || (row.kind === "translate_guard" && /NVIDIA NVENC/i.test(row.message))
    ),
    rows
  };
  writeFileSync(join(outDir, "recheck.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

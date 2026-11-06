#!/usr/bin/env node
/**
 * Phase 6 release validation against representative media.
 * Writes JSONL results + summary JSON.
 *
 * Usage:
 *   node scripts/run-phase6-validation.js [ffmpeg] [mediaDir] [resultsDir]
 */
const { spawnSync } = require("node:child_process");
const {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync
} = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { Compressor } = require("../dist/src/core/compressor");
const { BatchManager } = require("../dist/src/core/batch-manager");
const { EMPTY_HARDWARE, selectEncoder } = require("../dist/src/core/encoders");
const { computeAdaptiveConcurrency, maxPixelsInBatch } = require("../dist/src/core/concurrency");
const { readSystemResources } = require("../dist/src/core/system-resources");
const { probeFile } = require("../dist/src/core/probe");
const { cleanupStaleWorkDirs } = require("../dist/src/core/temp-cleanup");

const HARDWARE = {
  nvidia: { h264: true, h265: true },
  intel: { h264: false, h265: false },
  amd: { h264: true, h265: true }
};

function append(resultsPath, row) {
  writeFileSync(resultsPath, `${JSON.stringify(row)}\n`, { flag: "a" });
  console.log(JSON.stringify(row));
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
  const frames = [...text.matchAll(/"vmaf"\s*:\s*([0-9.]+)/gi)].map((m) => Number(m[1])).filter(Number.isFinite);
  if (frames.length > 1) return frames.reduce((a, b) => a + b, 0) / frames.length;
  return frames.length === 1 ? frames[0] : null;
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
  return {
    ssim: parseSsim(ssimText),
    vmaf: parseVmaf(vmafText),
    ssimAvailable: /SSIM/i.test(ssimText),
    vmafAvailable: /libvmaf|vmaf/i.test(vmafText)
  };
}

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

async function compressOne(ffmpeg, inputPath, metadata, settings, outDir) {
  const beforeDirs = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("vc-work-")));
  const compressor = new Compressor();
  const result = await compressor.compress(ffmpeg, inputPath, metadata, settings, () => {}, {
    outputDirectory: outDir,
    hardware: settings.encoderPreference === "cpu" ? EMPTY_HARDWARE : HARDWARE
  });
  const afterDirs = readdirSync(tmpdir()).filter((name) => name.startsWith("vc-work-"));
  const leaked = afterDirs.filter((name) => !beforeDirs.has(name));
  return { result, leakedWorkDirs: leaked };
}

async function main() {
  const ffmpeg = process.argv[2] || "ffmpeg";
  const mediaDir = process.argv[3] || join(tmpdir(), "vc-phase6-media");
  const resultsDir = process.argv[4] || join(process.cwd(), "scripts", "phase6-results");
  mkdirSync(resultsDir, { recursive: true });
  const resultsPath = join(resultsDir, "results.jsonl");
  writeFileSync(resultsPath, "");
  const summary = {
    startedAt: new Date().toISOString(),
    executed: [],
    skipped: [],
    failures: [],
    notes: []
  };

  if (!existsSync(mediaDir)) {
    throw new Error(`Media directory missing: ${mediaDir}. Run prepare-phase6-media.js first.`);
  }
  const manifestPath = join(mediaDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { files: [] };
  const files = (manifest.files || []).filter((f) => existsSync(f.path));
  if (!files.length) throw new Error("No media files in manifest.");

  // --- Orphan temp cleanup self-check ---
  const stale = cleanupStaleWorkDirs({ maxAgeMs: 0 });
  append(resultsPath, { kind: "temp_cleanup", removed: stale.removed, failed: stale.failed, scanned: stale.scanned });
  summary.executed.push("temp_cleanup");

  // --- Encoder matrix on selected clips ---
  const matrixClips = ["public_bbb_short", "phone_like_1080p", "screen_like_1080p", "high_motion_1080p60", "uhd_like_4k", "hevc_source_720p", "ts_broadcast_like"]
    .map((id) => files.find((f) => f.id === id))
    .filter(Boolean);
  const preferences = [
    { preference: "auto", preset: "fast" },
    { preference: "nvidia", preset: "fast" },
    { preference: "amd", preset: "fast" },
    { preference: "cpu", preset: "medium" }
  ];

  for (const clip of matrixClips) {
    let metadata;
    try {
      metadata = await probeFile(ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1"), clip.path);
    } catch (error) {
      // probeFile expects ffprobe path; fall back to ffmpeg sibling via our summarized fields
      metadata = {
        size: clip.sizeBytes,
        duration: clip.duration,
        width: clip.width,
        height: clip.height,
        frameRate: clip.frameRate || 30,
        videoCodec: clip.videoCodec || "h264",
        audioCodec: clip.audioCodec || null,
        audioChannels: 2,
        audioSampleRate: 48000
      };
      summary.notes.push(`probe fallback for ${clip.id}: ${error.message}`);
    }
    // Prefer real probe when possible
    try {
      const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
      metadata = await probeFile(ffprobe, clip.path);
    } catch {
      /* keep fallback */
    }

    const targetMb = Math.max(3, Math.ceil((clip.sizeBytes / 1_000_000) * 0.35) || 5);
    for (const { preference, preset } of preferences) {
      const work = join(resultsDir, "encode", clip.id, preference);
      mkdirSync(work, { recursive: true });
      const inputCopy = join(work, `src${clip.path.endsWith(".ts") ? ".ts" : ".mp4"}`);
      copyFileSync(clip.path, inputCopy);
      const started = Date.now();
      try {
        const { result, leakedWorkDirs } = await compressOne(
          ffmpeg,
          inputCopy,
          metadata,
          settingsBase({ targetMb, preference: undefined, encoderPreference: preference, preset }),
          work
        );
        const outMb = result.outputBytes / 1_000_000;
        const row = {
          kind: "encode",
          clipId: clip.id,
          sourceKind: clip.kind,
          preference,
          preset,
          encoder: result.performance?.encoderLabel || null,
          fellBackToCpu: Boolean(result.performance?.fellBackToCpu),
          attempts: result.performance?.attempts ?? null,
          encodeMs: result.performance?.encodingMs ?? (Date.now() - started),
          sourceMb: Number((clip.sizeBytes / 1_000_000).toFixed(2)),
          outMb: Number(outMb.toFixed(2)),
          targetMb,
          limitOk: result.outputBytes <= targetMb * 1_000_000,
          width: metadata.width,
          height: metadata.height,
          frameRate: metadata.frameRate,
          videoCodecIn: metadata.videoCodec,
          leakedWorkDirs,
          error: null
        };
        append(resultsPath, row);
        summary.executed.push(`encode:${clip.id}:${preference}`);
        if (!row.limitOk) summary.failures.push(row);
        if (leakedWorkDirs.length) summary.failures.push({ kind: "leak", ...row });
      } catch (error) {
        const row = {
          kind: "encode",
          clipId: clip.id,
          preference,
          preset,
          targetMb,
          error: error instanceof Error ? error.message : String(error)
        };
        append(resultsPath, row);
        summary.failures.push(row);
      }
    }
  }

  // --- Quality compares on public + high-motion (same target) ---
  const qualityClips = ["public_bbb_short", "high_motion_1080p60", "screen_like_1080p"]
    .map((id) => files.find((f) => f.id === id))
    .filter(Boolean);
  for (const clip of qualityClips) {
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    let metadata;
    try {
      metadata = await probeFile(ffprobe, clip.path);
    } catch {
      metadata = {
        size: clip.sizeBytes, duration: clip.duration, width: clip.width, height: clip.height,
        frameRate: clip.frameRate || 30, videoCodec: clip.videoCodec || "h264",
        audioCodec: clip.audioCodec, audioChannels: 2, audioSampleRate: 48000
      };
    }
    // Force re-encode: target must be below source size, but still reachable for HW encoders.
    const sourceMb = clip.sizeBytes / 1_000_000;
    const targetMb = Math.max(2, Math.min(
      Math.floor(sourceMb * 0.55) || 2,
      Math.max(8, Math.ceil(clip.duration * 0.55))
    ));
    if (targetMb * 1_000_000 >= clip.sizeBytes) {
      summary.skipped.push(`quality:${clip.id}:source-already-small`);
      continue;
    }
    const baseline = {};
    for (const preference of ["cpu", "nvidia", "amd"]) {
      const work = join(resultsDir, "quality", clip.id, preference);
      mkdirSync(work, { recursive: true });
      const inputCopy = join(work, "src.mp4");
      copyFileSync(clip.path, inputCopy);
      try {
        const { result } = await compressOne(
          ffmpeg,
          inputCopy,
          metadata,
          settingsBase({
            targetMb,
            encoderPreference: preference,
            preset: preference === "cpu" ? "medium" : "fast"
          }),
          work
        );
        const q = measureQuality(ffmpeg, clip.path, result.outputPath);
        const row = {
          kind: "quality",
          clipId: clip.id,
          preference,
          encoder: result.performance?.encoderLabel,
          encodeMs: result.performance?.encodingMs,
          outMb: Number((result.outputBytes / 1_000_000).toFixed(2)),
          targetMb,
          limitOk: result.outputBytes <= targetMb * 1_000_000,
          ssim: q.ssim,
          vmaf: q.vmaf,
          ssimAvailable: q.ssimAvailable,
          vmafAvailable: q.vmafAvailable
        };
        if (preference === "cpu") baseline.ssim = q.ssim;
        if (baseline.ssim != null && q.ssim != null) {
          row.ssimDeltaVsCpu = Number((q.ssim - baseline.ssim).toFixed(5));
        }
        append(resultsPath, row);
        summary.executed.push(`quality:${clip.id}:${preference}`);
      } catch (error) {
        const row = { kind: "quality", clipId: clip.id, preference, error: String(error.message || error) };
        append(resultsPath, row);
        summary.failures.push(row);
      }
    }
  }

  // --- Size limit stress ---
  const limitClip = files.find((f) => f.id === "phone_like_1080p") || files[0];
  {
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    let metadata;
    try { metadata = await probeFile(ffprobe, limitClip.path); }
    catch {
      metadata = {
        size: limitClip.sizeBytes, duration: limitClip.duration, width: limitClip.width, height: limitClip.height,
        frameRate: limitClip.frameRate || 30, videoCodec: "h264", audioCodec: "aac", audioChannels: 2, audioSampleRate: 48000
      };
    }
    for (const targetMb of [1, 3, 8, 25, 200]) {
      for (const preference of ["cpu", "nvidia", "amd"]) {
        const work = join(resultsDir, "limits", String(targetMb), preference);
        mkdirSync(work, { recursive: true });
        const inputCopy = join(work, "src.mp4");
        copyFileSync(limitClip.path, inputCopy);
        try {
          const { result, leakedWorkDirs } = await compressOne(
            ffmpeg,
            inputCopy,
            metadata,
            settingsBase({
              targetMb,
              encoderPreference: preference,
              preset: preference === "cpu" ? "medium" : "fast",
              videoCodec: "h264"
            }),
            work
          );
          const row = {
            kind: "limit",
            clipId: limitClip.id,
            preference,
            targetMb,
            outMb: Number((result.outputBytes / 1_000_000).toFixed(2)),
            attempts: result.performance?.attempts,
            limitOk: result.outputBytes <= targetMb * 1_000_000,
            status: "ok",
            leakedWorkDirs,
            error: null
          };
          append(resultsPath, row);
          summary.executed.push(`limit:${targetMb}:${preference}`);
          if (!row.limitOk) summary.failures.push(row);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const expectedFail = targetMb <= 1 || /maximale bestandsgrootte|niet bereiken/i.test(msg);
          const row = {
            kind: "limit",
            clipId: limitClip.id,
            preference,
            targetMb,
            status: expectedFail ? "expected_fail" : "unexpected_fail",
            error: msg
          };
          append(resultsPath, row);
          summary.executed.push(`limit:${targetMb}:${preference}:${row.status}`);
          if (!expectedFail) summary.failures.push(row);
        }
      }
    }

    // H.265 limit spot-check
    const work = join(resultsDir, "limits", "h265-8", "cpu");
    mkdirSync(work, { recursive: true });
    const inputCopy = join(work, "src.mp4");
    copyFileSync(limitClip.path, inputCopy);
    try {
      const { result } = await compressOne(
        ffmpeg, inputCopy, metadata,
        settingsBase({ targetMb: 8, encoderPreference: "cpu", preset: "medium", videoCodec: "h265" }),
        work
      );
      append(resultsPath, {
        kind: "limit",
        clipId: limitClip.id,
        preference: "cpu",
        videoCodec: "h265",
        targetMb: 8,
        outMb: Number((result.outputBytes / 1_000_000).toFixed(2)),
        limitOk: result.outputBytes <= 8_000_000,
        status: "ok"
      });
      summary.executed.push("limit:h265:8:cpu");
    } catch (error) {
      const row = { kind: "limit", videoCodec: "h265", targetMb: 8, status: "fail", error: String(error.message || error) };
      append(resultsPath, row);
      summary.failures.push(row);
    }
  }

  // --- Special chars path ---
  const special = files.find((f) => f.id === "special_chars_name");
  if (special) {
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    let metadata;
    try { metadata = await probeFile(ffprobe, special.path); }
    catch {
      metadata = {
        size: special.sizeBytes, duration: special.duration, width: special.width, height: special.height,
        frameRate: special.frameRate || 30, videoCodec: "h264", audioCodec: "aac", audioChannels: 2, audioSampleRate: 48000
      };
    }
    const work = join(resultsDir, "special");
    mkdirSync(work, { recursive: true });
    try {
      const { result } = await compressOne(
        ffmpeg, special.path, metadata,
        settingsBase({ targetMb: 6, encoderPreference: "auto", preset: "fast" }),
        work
      );
      append(resultsPath, {
        kind: "special_path",
        clipId: special.id,
        outputPath: result.outputPath,
        outMb: Number((result.outputBytes / 1_000_000).toFixed(2)),
        limitOk: result.outputBytes <= 6_000_000,
        encoder: result.performance?.encoderLabel
      });
      summary.executed.push("special_path");
    } catch (error) {
      const row = { kind: "special_path", error: String(error.message || error) };
      append(resultsPath, row);
      summary.failures.push(row);
    }
  } else {
    summary.skipped.push("special_path");
  }

  // --- Batch: 30 files + one intentional failure isolation ---
  {
    const base = files.find((f) => f.id === "silent_720p") || files[0];
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    let metadata;
    try { metadata = await probeFile(ffprobe, base.path); }
    catch {
      metadata = {
        size: base.sizeBytes, duration: base.duration, width: base.width, height: base.height,
        frameRate: base.frameRate || 30, videoCodec: "h264", audioCodec: null, audioChannels: 0, audioSampleRate: 0
      };
    }
    const work = join(resultsDir, "batch30");
    mkdirSync(work, { recursive: true });
    const items = [];
    for (let i = 0; i < 30; i++) {
      const dirA = join(work, `dir-a-${i}`);
      const dirB = join(work, `dir-b-${i}`);
      mkdirSync(dirA, { recursive: true });
      mkdirSync(dirB, { recursive: true });
      const path = join(i % 2 === 0 ? dirA : dirB, "same-name.mp4");
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
    // Missing file job — must fail alone
    items.push({
      id: "batch-missing",
      inputPath: join(work, "does-not-exist.mp4"),
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
    const memBefore = process.memoryUsage().rss;
    const started = Date.now();
    const manager = new BatchManager(ffmpeg, concurrency, {
      hardware: HARDWARE,
      runtime: {
        concurrency,
        concurrencyMode: "auto",
        encoderFamily: selected.family,
        encoderLabel: selected.label
      }
    });
    const finished = await manager.start(items, () => {});
    const wallMs = Date.now() - started;
    const completed = finished.filter((i) => i.status === "completed").length;
    const failed = finished.filter((i) => i.status === "failed");
    const cancelled = finished.filter((i) => i.status === "cancelled").length;
    const missingFailed = failed.some((i) => i.id === "batch-missing");
    const othersFailed = failed.filter((i) => i.id !== "batch-missing");
    const memAfter = process.memoryUsage().rss;
    const row = {
      kind: "batch30",
      concurrency,
      wallMs,
      completed,
      failed: failed.length,
      cancelled,
      statusCounts: finished.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {}),
      missingFailedAlone: missingFailed && othersFailed.length === 0,
      rssMbBefore: Number((memBefore / 1_000_000).toFixed(1)),
      rssMbAfter: Number((memAfter / 1_000_000).toFixed(1)),
      nvidia: resources.nvidia || null
    };
    append(resultsPath, row);
    summary.executed.push("batch30");
    if (!row.missingFailedAlone || completed < 30) summary.failures.push(row);
  }

  // --- Cancel isolation (short batch) ---
  {
    const base = files.find((f) => f.id === "phone_like_1080p") || files[0];
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    let metadata;
    try { metadata = await probeFile(ffprobe, base.path); }
    catch {
      metadata = {
        size: base.sizeBytes, duration: base.duration, width: base.width, height: base.height,
        frameRate: 30, videoCodec: "h264", audioCodec: "aac", audioChannels: 2, audioSampleRate: 48000
      };
    }
    const work = join(resultsDir, "cancel");
    mkdirSync(work, { recursive: true });
    const items = [];
    for (let i = 0; i < 4; i++) {
      const path = join(work, `c-${i}.mp4`);
      copyFileSync(base.path, path);
      items.push({
        id: `c-${i}`,
        inputPath: path,
        metadata: { ...metadata, size: statSync(path).size },
        settings: settingsBase({ targetMb: 8, encoderPreference: "cpu", preset: "medium" }),
        status: "queued",
        progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" }
      });
    }
    const manager = new BatchManager(ffmpeg, 2, {
      hardware: EMPTY_HARDWARE,
      runtime: { concurrency: 2, concurrencyMode: "manual", encoderFamily: "cpu", encoderLabel: "CPU" }
    });
    const runPromise = manager.start(items, () => {});
    setTimeout(() => manager.cancelItem("c-2"), 400);
    setTimeout(() => manager.cancelAll(), 2500);
    const finished = await runPromise;
    const row = {
      kind: "cancel",
      statuses: Object.fromEntries(finished.map((i) => [i.id, i.status])),
      cancelledPresent: finished.some((i) => i.status === "cancelled")
    };
    append(resultsPath, row);
    summary.executed.push("cancel");
  }

  // --- Invalid input ---
  {
    const work = join(resultsDir, "invalid");
    mkdirSync(work, { recursive: true });
    const bad = join(work, "not-a-video.mp4");
    writeFileSync(bad, "this is not a video");
    try {
      await compressOne(ffmpeg, bad, {
        size: 18, duration: 10, width: 640, height: 360, frameRate: 30,
        videoCodec: "h264", audioCodec: null, audioChannels: 0, audioSampleRate: 0
      }, settingsBase({ targetMb: 5, encoderPreference: "cpu", preset: "ultrafast" }), work);
      const row = { kind: "invalid_input", status: "unexpected_success" };
      append(resultsPath, row);
      summary.failures.push(row);
    } catch (error) {
      append(resultsPath, { kind: "invalid_input", status: "expected_fail", error: String(error.message || error).slice(0, 300) });
      summary.executed.push("invalid_input");
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.failureCount = summary.failures.length;
  summary.ok = summary.failures.length === 0;
  writeFileSync(join(resultsDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, failureCount: summary.failureCount, resultsPath }, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

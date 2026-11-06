#!/usr/bin/env node
/**
 * Batch throughput benchmark.
 * Usage:
 *   node scripts/bench-batch.js <ffmpeg> <input> <preference> <preset> <concurrency|auto> <copies> [targetMb] [duration] [width] [height] [fps]
 */
const { mkdirSync, existsSync, statSync, copyFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { BatchManager } = require("../dist/src/core/batch-manager");
const { EMPTY_HARDWARE, selectEncoder } = require("../dist/src/core/encoders");
const { computeAdaptiveConcurrency, maxPixelsInBatch } = require("../dist/src/core/concurrency");
const { estimateJobWeight } = require("../dist/src/core/scheduler");
const { readSystemResources } = require("../dist/src/core/system-resources");

async function main() {
  const [
    ffmpeg, input, preference, preset, concurrencyRaw, copiesRaw,
    targetRaw, durationRaw, widthRaw, heightRaw, fpsRaw
  ] = process.argv.slice(2);
  if (!ffmpeg || !input || !preference || !preset || concurrencyRaw == null || copiesRaw == null) {
    console.error("Usage: node scripts/bench-batch.js <ffmpeg> <input> <preference> <preset> <concurrency|auto> <copies> [targetMb] [duration] [width] [height] [fps]");
    process.exit(2);
  }
  if (!existsSync(ffmpeg) || !existsSync(input)) {
    console.error("ffmpeg or input missing");
    process.exit(2);
  }

  const copies = Math.max(1, Number(copiesRaw));
  const targetMb = Number(targetRaw || 8);
  const duration = Number(durationRaw || 30);
  const width = Number(widthRaw || 1920);
  const height = Number(heightRaw || 1080);
  const frameRate = Number(fpsRaw || 30);
  const size = statSync(input).size;
  const work = join(tmpdir(), `vc-batch-bench-${Date.now()}`);
  mkdirSync(work, { recursive: true });

  const hardware = preference === "cpu"
    ? EMPTY_HARDWARE
    : {
        nvidia: { h264: true, h265: true },
        intel: { h264: false, h265: false },
        amd: { h264: true, h265: true }
      };

  const metadata = {
    size,
    duration,
    width,
    height,
    frameRate,
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

  const items = [];
  for (let index = 0; index < copies; index++) {
    const file = join(work, `clip-${index}.mp4`);
    copyFileSync(input, file);
    items.push({
      id: `job-${index}`,
      inputPath: file,
      metadata: { ...metadata, size: statSync(file).size },
      settings: { ...settings },
      status: "queued",
      progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" }
    });
  }

  const selected = selectEncoder(preference, "h264", hardware);
  const resourcesBefore = await readSystemResources();
  const concurrencyMode = concurrencyRaw === "auto" ? "auto" : "manual";
  const concurrency = concurrencyRaw === "auto"
    ? computeAdaptiveConcurrency({
        family: selected.family,
        maxPixels: maxPixelsInBatch(items),
        resources: resourcesBefore,
        maxConcurrency: 8
      })
    : Math.max(1, Number(concurrencyRaw));

  const started = Date.now();
  const manager = new BatchManager(ffmpeg, concurrency, {
    hardware,
    runtime: {
      concurrency,
      concurrencyMode,
      encoderFamily: selected.family,
      encoderLabel: selected.label
    }
  });
  const result = await manager.start(items, () => undefined);
  const wallMs = Date.now() - started;
  const resourcesAfter = await readSystemResources();

  const completed = result.filter((item) => item.status === "completed");
  const failed = result.filter((item) => item.status === "failed");
  const outSizes = completed.map((item) => item.result?.outputBytes || 0);
  const encodingMs = completed.map((item) => item.result?.performance?.encodingMs || 0);
  const attempts = completed.map((item) => item.result?.performance?.attempts || 0);
  const weights = items.map((item) => estimateJobWeight(item));
  const totalOut = outSizes.reduce((sum, value) => sum + value, 0);
  const limitOk = completed.every((item) => (item.result?.outputBytes || 0) <= targetMb * 1_000_000);
  const videoMinutes = copies * (duration / 60);
  const wallMinutes = wallMs / 60_000;
  const avg = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const max = (values) => values.length ? Math.max(...values) : null;

  console.log(JSON.stringify({
    preference,
    preset,
    concurrency,
    concurrencyMode,
    copies,
    durationSec: duration,
    width,
    height,
    wallMs,
    avgJobMs: avg(encodingMs) != null ? Math.round(avg(encodingMs)) : null,
    maxJobMs: max(encodingMs),
    videosPerMinute: Number((copies / Math.max(wallMinutes, 0.0001)).toFixed(2)),
    videoMinutesPerMinute: Number((videoMinutes / Math.max(wallMinutes, 0.0001)).toFixed(2)),
    completed: completed.length,
    failed: failed.length,
    avgOutMb: avg(outSizes) != null ? Number((avg(outSizes) / 1_000_000).toFixed(2)) : null,
    maxOutMb: max(outSizes) != null ? Number((max(outSizes) / 1_000_000).toFixed(2)) : null,
    avgAttempts: avg(attempts) != null ? Number(avg(attempts).toFixed(2)) : null,
    maxAttempts: max(attempts),
    limitOk,
    encoder: selected.label,
    schedulerWeight: weights[0],
    freeMemMbBefore: Math.round(resourcesBefore.freeMemoryBytes / 1_000_000),
    freeMemMbAfter: Math.round(resourcesAfter.freeMemoryBytes / 1_000_000),
    nvidiaBefore: resourcesBefore.nvidia,
    nvidiaAfter: resourcesAfter.nvidia,
    fallbacks: completed.filter((item) => item.result?.performance?.fellBackToCpu).length
  }));

  rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});

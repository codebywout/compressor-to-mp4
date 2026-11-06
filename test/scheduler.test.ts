import assert from "node:assert/strict";
import test from "node:test";
import { estimateJobWeight, selectNextQueuedItem } from "../src/core/scheduler";
import { BatchItem } from "../src/shared/types";

function item(id: string, duration: number, width: number, height: number, status: BatchItem["status"] = "queued"): BatchItem {
  return {
    id,
    inputPath: `${id}.mp4`,
    metadata: {
      size: width * height,
      duration,
      width,
      height,
      frameRate: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      audioChannels: 2,
      audioSampleRate: 48000
    },
    settings: {
      mode: "compress",
      targetMb: 50,
      videoCodec: "h264",
      audioBitrateKbps: 128,
      resolution: "original",
      frameRate: "original",
      preset: "fast",
      keepAudio: true
    },
    status,
    progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "" }
  };
}

test("lighter/shorter jobs have lower weight than heavy 4K", () => {
  const short = estimateJobWeight(item("a", 30, 1920, 1080));
  const long4k = estimateJobWeight(item("b", 300, 3840, 2160));
  assert.ok(short < long4k);
});

test("selectNextQueuedItem prefers lightest queued job and skips non-queued", () => {
  const heavy = item("heavy", 600, 3840, 2160);
  const light = item("light", 20, 1280, 720);
  const running = item("running", 10, 1280, 720, "running");
  const next = selectNextQueuedItem([heavy, running, light]);
  assert.equal(next?.id, "light");
});

test("equal weights keep original order", () => {
  const first = item("first", 30, 1920, 1080);
  const second = item("second", 30, 1920, 1080);
  assert.equal(selectNextQueuedItem([first, second])?.id, "first");
});

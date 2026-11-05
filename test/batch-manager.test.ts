import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { BatchManager } from "../src/core/batch-manager";
import { BatchItem } from "../src/shared/types";

function item(id: string): BatchItem {
  return {
    id,
    inputPath: join(tmpdir(), `${id}.ts`),
    metadata: { size: 1000, duration: 10, width: 1280, height: 720, frameRate: 25, videoCodec: "mpeg2video", audioCodec: "aac", audioChannels: 2, audioSampleRate: 48000 },
    settings: { mode: "compress", targetMb: 10, videoCodec: "h264", audioBitrateKbps: 128, resolution: "original", frameRate: "original", preset: "fast", keepAudio: true },
    status: "queued",
    progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" }
  };
}

test("batch isolates failures between items", async () => {
  const updates: string[] = [];
  const manager = new BatchManager("missing-ffmpeg-for-test", 2);
  const result = await manager.start([item("one"), item("two")], (update) => updates.push(update.item.id));
  assert.equal(result.length, 2);
  assert.equal(result.filter((candidate) => candidate.status === "failed").length, 2);
  assert.ok(updates.includes("one") && updates.includes("two"));
});

test("batch does not rerun items that already failed", async () => {
  const failed = item("bad");
  failed.status = "failed";
  failed.error = "probe mislukt";
  const statuses: string[] = [];
  const manager = new BatchManager("missing-ffmpeg-for-test", 1);
  const result = await manager.start([failed, item("ok")], (update) => {
    if (update.item.id === "bad") statuses.push(update.item.status);
  });
  const bad = result.find((candidate) => candidate.id === "bad");
  assert.equal(bad?.status, "failed");
  assert.equal(bad?.error, "probe mislukt");
  assert.ok(statuses.every((status) => status === "failed"));
});

test("batch rejects invalid parallelism", () => {
  assert.throws(() => new BatchManager("ffmpeg", 0), /Paralleliteit/);
});

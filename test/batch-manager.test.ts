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

test("cancelAll marks remaining queued items as cancelled", async () => {
  const manager = new BatchManager("missing-ffmpeg-for-test", 1);
  const items = [item("a"), item("b"), item("c")];
  const promise = manager.start(items, () => {
    manager.cancelAll();
  });
  const result = await promise;
  assert.ok(result.every((candidate) => candidate.status === "failed" || candidate.status === "cancelled"));
  assert.ok(result.some((candidate) => candidate.status === "cancelled" || candidate.status === "failed"));
});

test("cancelItem cancels a queued item without stopping others", async () => {
  const manager = new BatchManager("missing-ffmpeg-for-test", 1);
  let cancelledQueued = false;
  const result = await manager.start([item("keep"), item("drop")], (update) => {
    if (!cancelledQueued) {
      manager.cancelItem("drop");
      cancelledQueued = true;
    }
    void update;
  });
  const dropped = result.find((candidate) => candidate.id === "drop");
  assert.equal(dropped?.status, "cancelled");
  assert.equal(result.find((candidate) => candidate.id === "keep")?.status, "failed");
});

test("partial batch failure keeps independent statuses", async () => {
  const manager = new BatchManager("missing-ffmpeg-for-test", 2);
  const failed = item("prefailed");
  failed.status = "failed";
  failed.error = "voorbereiding mislukt";
  const result = await manager.start([failed, item("a"), item("b")], () => undefined);
  assert.equal(result.find((candidate) => candidate.id === "prefailed")?.status, "failed");
  assert.equal(result.filter((candidate) => candidate.status === "failed").length, 3);
});

test("batch claims lighter jobs before heavy 4K while preserving map order for listing", async () => {
  const heavy = item("heavy");
  heavy.metadata = { ...heavy.metadata, duration: 600, width: 3840, height: 2160 };
  const light = item("light");
  light.metadata = { ...light.metadata, duration: 5, width: 1280, height: 720 };
  const order: string[] = [];
  const manager = new BatchManager("missing-ffmpeg-for-test", 1, {
    runtime: { concurrency: 1, concurrencyMode: "auto", encoderFamily: "nvidia", encoderLabel: "NVIDIA NVENC (H264)" }
  });
  await manager.start([heavy, light], (update) => {
    if (update.item.status === "running") order.push(update.item.id);
    if (update.summary.runtime) {
      assert.equal(update.summary.runtime.concurrency, 1);
      assert.equal(update.summary.runtime.concurrencyMode, "auto");
    }
  });
  assert.deepEqual(order, ["light", "heavy"]);
});

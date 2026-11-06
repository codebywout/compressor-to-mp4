import assert from "node:assert/strict";
import test from "node:test";
import { parseEncoderSupport, parseHistoryJson, parsePreferencesJson } from "../src/core/app-storage";

test("parses valid preferences and clamps concurrency", () => {
  const preferences = parsePreferencesJson(JSON.stringify({
    mode: "compress",
    targetMb: 40,
    concurrency: 99,
    audioBitrate: "160",
    videoCodec: "h264",
    preset: "fast",
    resolution: "720p",
    frameRate: "30",
    keepAudio: true,
    advanced: false,
    theme: "dark"
  }));
  assert.equal(preferences?.concurrency, 8); // clamped from 99
  assert.equal(preferences?.theme, "dark");
  assert.equal(preferences?.videoCodec, "h264");
});

test("rejects invalid preference values without throwing", () => {
  assert.equal(parsePreferencesJson("{"), null);
  assert.equal(parsePreferencesJson("null"), null);
  const preferences = parsePreferencesJson(JSON.stringify({
    mode: "explode",
    targetMb: -1,
    concurrency: "fast",
    audioBitrate: "999",
    videoCodec: "av1",
    theme: "neon"
  }));
  assert.deepEqual(preferences, {});
});

test("parses valid history and drops corrupt entries", () => {
  const history = parseHistoryJson(JSON.stringify([
    {
      id: "1",
      inputPath: "C:\\a.ts",
      outputPath: "C:\\a.mp4",
      finishedAt: "2026-01-01T00:00:00.000Z",
      originalBytes: 100,
      outputBytes: 50,
      status: "completed",
      durationSeconds: 12
    },
    { id: 2, inputPath: "bad" },
    {
      id: "3",
      inputPath: "C:\\b.ts",
      outputPath: null,
      finishedAt: "2026-01-02T00:00:00.000Z",
      originalBytes: 10,
      outputBytes: null,
      status: "failed",
      error: "boom",
      durationSeconds: null
    }
  ]));
  assert.equal(history.length, 2);
  assert.equal(history[0].status, "completed");
  assert.equal(history[1].status, "failed");
});

test("handles empty and corrupt history", () => {
  assert.deepEqual(parseHistoryJson(null), []);
  assert.deepEqual(parseHistoryJson(""), []);
  assert.deepEqual(parseHistoryJson("{"), []);
  assert.deepEqual(parseHistoryJson("\"nope\""), []);
});

test("detects encoder support from ffmpeg listing text", () => {
  assert.deepEqual(parseEncoderSupport(" V..... libx264\n V..... libx265\n A..... aac"), { h264: true, h265: true, aac: true });
  assert.deepEqual(parseEncoderSupport(" V..... libx264\n A..... aac"), { h264: true, h265: false, aac: true });
  assert.deepEqual(parseEncoderSupport(""), { h264: false, h265: false, aac: false });
});

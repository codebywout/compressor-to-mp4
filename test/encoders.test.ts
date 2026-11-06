import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVideoEncodeArgs,
  canSkipReencodeForSize,
  parseHardwareListed,
  recommendedConcurrency,
  selectEncoder
} from "../src/core/encoders";

const hardware = {
  nvidia: { h264: true, h265: true },
  intel: { h264: false, h265: false },
  amd: { h264: true, h265: false }
};

test("parses hardware encoder names from ffmpeg listing", () => {
  const listed = parseHardwareListed(" V..... h264_nvenc\n V..... hevc_amf\n V..... h264_qsv");
  assert.equal(listed.nvidia.h264, true);
  assert.equal(listed.nvidia.h265, false);
  assert.equal(listed.amd.h265, true);
  assert.equal(listed.intel.h264, true);
});

test("auto prefers NVIDIA then AMD then Intel then CPU", () => {
  assert.equal(selectEncoder("auto", "h264", hardware).id, "h264_nvenc");
  assert.equal(selectEncoder("auto", "h264", { ...hardware, nvidia: { h264: false, h265: false } }).id, "h264_amf");
  assert.equal(selectEncoder("auto", "h264", {
    nvidia: { h264: false, h265: false },
    intel: { h264: false, h265: false },
    amd: { h264: false, h265: false }
  }).id, "libx264");
});

test("forced unavailable hardware falls back to CPU", () => {
  const resolved = selectEncoder("intel", "h264", hardware);
  assert.equal(resolved.id, "libx264");
  assert.equal(resolved.family, "cpu");
});

test("buildVideoEncodeArgs uses NVENC-specific flags", () => {
  const encoder = selectEncoder("nvidia", "h264", hardware);
  const args = buildVideoEncodeArgs(encoder, "fast", 2000);
  assert.ok(args.includes("h264_nvenc"));
  assert.ok(args.includes("p4"));
  assert.ok(args.includes("2000k"));
  assert.ok(args.includes("yuv420p"));
});

test("CPU encoder supports two-pass; hardware does not", () => {
  assert.equal(selectEncoder("cpu", "h264", hardware).supportsTwoPass, true);
  assert.equal(selectEncoder("nvidia", "h264", hardware).supportsTwoPass, false);
});

test("skip reencode only when compress target already met without scale/fps change", () => {
  assert.equal(canSkipReencodeForSize(4_000_000, {
    mode: "compress",
    targetMb: 5,
    resolution: "original",
    frameRate: "original"
  }), true);
  assert.equal(canSkipReencodeForSize(6_000_000, {
    mode: "compress",
    targetMb: 5,
    resolution: "original",
    frameRate: "original"
  }), false);
  assert.equal(canSkipReencodeForSize(4_000_000, {
    mode: "compress",
    targetMb: 5,
    resolution: "720p",
    frameRate: "original"
  }), false);
});

test("recommended concurrency stays conservative for GPU", () => {
  assert.equal(recommendedConcurrency("nvidia", 16), 2);
  assert.equal(recommendedConcurrency("cpu", 16), 4);
  assert.equal(recommendedConcurrency("cpu", 4), 1);
});

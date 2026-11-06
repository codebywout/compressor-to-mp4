import assert from "node:assert/strict";
import test from "node:test";
import { computeAdaptiveConcurrency, effectivePixels, maxPixelsInBatch } from "../src/core/concurrency";

const baseResources = {
  logicalCpus: 16,
  freeMemoryBytes: 12_000_000_000,
  totalMemoryBytes: 32_000_000_000,
  nvidia: null as null
};

test("CPU adaptive concurrency scales with cores and RAM", () => {
  assert.equal(computeAdaptiveConcurrency({
    family: "cpu",
    maxPixels: 1920 * 1080,
    resources: baseResources
  }), 4);
  assert.equal(computeAdaptiveConcurrency({
    family: "cpu",
    maxPixels: 1920 * 1080,
    resources: { ...baseResources, logicalCpus: 4, freeMemoryBytes: 2_000_000_000 }
  }), 1);
});

test("NVIDIA prefers 2 for 1080p and 4K (diminishing returns above 2)", () => {
  assert.equal(computeAdaptiveConcurrency({
    family: "nvidia",
    maxPixels: 1920 * 1080,
    resources: {
      ...baseResources,
      nvidia: { name: "RTX", memoryTotalMiB: 8192, memoryFreeMiB: 6000, utilizationGpu: 10, utilizationEncoder: 0 }
    }
  }), 2);
  assert.equal(computeAdaptiveConcurrency({
    family: "nvidia",
    maxPixels: 3840 * 2160,
    resources: {
      ...baseResources,
      nvidia: { name: "RTX", memoryTotalMiB: 8192, memoryFreeMiB: 6000, utilizationGpu: 10, utilizationEncoder: 0 }
    }
  }), 2);
});

test("low free VRAM or high encoder util reduces NVIDIA concurrency", () => {
  assert.equal(computeAdaptiveConcurrency({
    family: "nvidia",
    maxPixels: 1920 * 1080,
    resources: {
      ...baseResources,
      nvidia: { name: "RTX", memoryTotalMiB: 8192, memoryFreeMiB: 1200, utilizationGpu: 50, utilizationEncoder: 10 }
    }
  }), 1);
  assert.equal(computeAdaptiveConcurrency({
    family: "nvidia",
    maxPixels: 1920 * 1080,
    resources: {
      ...baseResources,
      nvidia: { name: "RTX", memoryTotalMiB: 8192, memoryFreeMiB: 5000, utilizationGpu: 40, utilizationEncoder: 90 }
    }
  }), 1);
});

test("AMD and Intel stay conservative", () => {
  assert.equal(computeAdaptiveConcurrency({ family: "amd", maxPixels: 1920 * 1080, resources: baseResources }), 2);
  assert.equal(computeAdaptiveConcurrency({ family: "amd", maxPixels: 3840 * 2160, resources: baseResources }), 1);
  assert.equal(computeAdaptiveConcurrency({ family: "intel", maxPixels: 1920 * 1080, resources: baseResources }), 2);
});

test("effective and max pixels respect downscale target", () => {
  assert.equal(effectivePixels(3840, 2160, "1080p"), 1920 * 1080);
  assert.equal(maxPixelsInBatch([
    { metadata: { width: 1280, height: 720 }, settings: { resolution: "original" } },
    { metadata: { width: 3840, height: 2160 }, settings: { resolution: "original" } }
  ]), 3840 * 2160);
});

test("manual maxConcurrency ceiling is respected", () => {
  assert.equal(computeAdaptiveConcurrency({
    family: "nvidia",
    maxPixels: 1920 * 1080,
    resources: baseResources,
    maxConcurrency: 2
  }), 2);
});

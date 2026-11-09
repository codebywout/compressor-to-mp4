import assert from "node:assert/strict";
import test from "node:test";
import { calculateVideoBitrateKbps, mbToBytes, planSizeBudget } from "../src/core/bitrate";

test("converts decimal megabytes to bytes", () => assert.equal(mbToBytes(10), 10_000_000));
test("rejects invalid target sizes", () => assert.throws(() => mbToBytes(0)));
test("reserves audio and safety margin", () => {
  const bitrate = calculateVideoBitrateKbps(50, 100, { audioBitrateKbps: 128, keepAudio: true });
  assert.equal(bitrate, 3635);
});
test("does not reserve audio when disabled", () => {
  const withAudio = calculateVideoBitrateKbps(50, 100, { audioBitrateKbps: 128, keepAudio: true });
  const withoutAudio = calculateVideoBitrateKbps(50, 100, { audioBitrateKbps: 128, keepAudio: false });
  assert.ok(withoutAudio > withAudio);
});

test("long lecture at 200 MB auto-reduces audio so video stays usable", () => {
  const duration = 1 * 3600 + 56 * 60 + 56; // ~1h57
  const budget = planSizeBudget(200, duration, { audioBitrateKbps: 128, keepAudio: true });
  assert.equal(budget.audioReduced, true);
  assert.ok(budget.audioBitrateKbps < 128, `audio should drop below 128, got ${budget.audioBitrateKbps}`);
  assert.ok(budget.videoBitrateKbps >= 100, `video should be usable, got ${budget.videoBitrateKbps}`);
  const estMb = (budget.videoBitrateKbps + budget.audioBitrateKbps) * duration / 8 / 1000;
  assert.ok(estMb <= 200, `estimated ${estMb.toFixed(1)} MB should fit in 200`);
});

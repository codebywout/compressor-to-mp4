import assert from "node:assert/strict";
import test from "node:test";
import { calculateVideoBitrateKbps, mbToBytes } from "../src/core/bitrate";

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

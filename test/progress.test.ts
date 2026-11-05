import assert from "node:assert/strict";
import test from "node:test";
import { scaleEncodingPercent } from "../src/core/compressor";

test("scales the first pass into the opening half of the bar", () => {
  assert.equal(scaleEncodingPercent(0, 10, 0, 46), 0);
  assert.equal(scaleEncodingPercent(5, 10, 0, 46), 23);
  assert.equal(scaleEncodingPercent(10, 10, 0, 46), 46);
});

test("continues the second pass without restarting at zero", () => {
  assert.equal(scaleEncodingPercent(0, 10, 46, 99), 46);
  assert.equal(scaleEncodingPercent(5, 10, 46, 99), 73);
  assert.equal(scaleEncodingPercent(50, 10, 46, 99), 99);
});

test("ignores missing timing", () => {
  assert.equal(scaleEncodingPercent(Number.NaN, 10, 46, 99), 46);
  assert.equal(scaleEncodingPercent(4, 0, 0, 99), 0);
});

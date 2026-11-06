import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { candidateOutputNames, OutputPathAllocator } from "../src/core/output-paths";

test("reserves unique sibling names for same basename", () => {
  const root = mkdtempSync(join(tmpdir(), "vc-out-"));
  try {
    const allocator = new OutputPathAllocator();
    const first = allocator.reserveFromInput(join(root, "clip.ts"));
    const second = allocator.reserveFromInput(join(root, "clip.mov"));
    assert.equal(first, join(root, "clip.mp4"));
    assert.equal(second, join(root, "clip (1).mp4"));
    assert.ok(allocator.isReserved(first));
    assert.ok(allocator.isReserved(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips existing on-disk outputs and same-name inputs already as mp4", () => {
  const root = mkdtempSync(join(tmpdir(), "vc-out-"));
  try {
    writeFileSync(join(root, "video.mp4"), "existing");
    const allocator = new OutputPathAllocator();
    const path = allocator.reserveFromInput(join(root, "video.mp4"));
    assert.equal(path, join(root, "video (1).mp4"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel-style reservations never collide", () => {
  const root = mkdtempSync(join(tmpdir(), "vc-out-"));
  try {
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    mkdirSync(join(root, "c"), { recursive: true });
    const allocator = new OutputPathAllocator();
    const paths = [
      allocator.reserveFromInput(join(root, "a", "show.ts")),
      allocator.reserveFromInput(join(root, "b", "show.ts")),
      allocator.reserveFromInput(join(root, "a", "show.mkv")),
      allocator.reserveFromInput(join(root, "c", "show.avi"))
    ];
    assert.equal(new Set(paths.map((value) => allocator.key(value))).size, 4);
    assert.equal(paths[0], join(root, "a", "show.mp4"));
    assert.equal(paths[1], join(root, "b", "show.mp4"));
    assert.equal(paths[2], join(root, "a", "show (1).mp4"));
    assert.equal(paths[3], join(root, "c", "show.mp4"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("case-insensitive reservation on Windows-style keys", () => {
  const allocator = new OutputPathAllocator();
  const root = mkdtempSync(join(tmpdir(), "vc-case-"));
  try {
    const first = allocator.reserveFromInput(join(root, "Clip.ts"));
    const secondKey = allocator.key(join(root, "CLIP.mp4"));
    assert.equal(allocator.key(first), secondKey);
    assert.ok(allocator.isReserved(join(root, "clip.MP4")));
    const next = allocator.reserveFromInput(join(root, "CLIP.mov"));
    assert.equal(next, join(root, "CLIP (1).mp4"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureStillAvailable reallocates when reserved path appears on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "vc-ensure-"));
  try {
    const allocator = new OutputPathAllocator();
    const reserved = allocator.reserveFromInput(join(root, "event.ts"));
    writeFileSync(reserved, "taken-externally");
    const next = allocator.ensureStillAvailable(reserved, join(root, "event.ts"));
    assert.equal(next, join(root, "event (1).mp4"));
    assert.ok(!allocator.isReserved(reserved));
    assert.ok(allocator.isReserved(next));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate naming convention", () => {
  assert.deepEqual(candidateOutputNames("film", 3), ["film.mp4", "film (1).mp4", "film (2).mp4"]);
});

test("release allows reusing a name", () => {
  const root = mkdtempSync(join(tmpdir(), "vc-release-"));
  try {
    const allocator = new OutputPathAllocator();
    const first = allocator.reserveFromInput(join(root, "x.ts"));
    allocator.release(first);
    const again = allocator.reserveFromInput(join(root, "x.mov"));
    assert.equal(again, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

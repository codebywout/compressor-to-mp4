#!/usr/bin/env node
/**
 * Generate sources (if needed) and run Phase 5 validation matrix.
 * Writes JSON lines to scripts/phase5-results.jsonl
 */
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, appendFileSync, writeFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const root = join(__dirname, "..");
const outFile = join(root, "scripts", "phase5-results.jsonl");
const mediaDir = join(tmpdir(), "vc-phase5-media");

function findFfmpeg() {
  const where = spawnSync("where.exe", ["ffmpeg"], { encoding: "utf8", windowsHide: true });
  const first = (where.stdout || "").split(/\r?\n/).map((v) => v.trim()).find(Boolean);
  if (first && existsSync(first)) return first;
  const winget = join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  const probe = spawnSync("powershell.exe", [
    "-NoProfile", "-Command",
    `Get-ChildItem -Path '${winget}' -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName`
  ], { encoding: "utf8", windowsHide: true });
  const path = (probe.stdout || "").trim();
  if (path && existsSync(path)) return path;
  throw new Error("ffmpeg.exe not found");
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  const line = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `exit ${result.status}`).trim(), raw: line };
  }
  try {
    return { ok: true, data: JSON.parse(line) };
  } catch {
    return { ok: false, error: `invalid json: ${line}` };
  }
}

function ensureSource(ffmpeg, name, width, height, seconds) {
  mkdirSync(mediaDir, { recursive: true });
  const file = join(mediaDir, name);
  if (existsSync(file) && statSync(file).size > 100_000) return file;
  console.error(`Generating ${name}...`);
  const bitrate = height >= 2160 ? "12M" : "8M";
  const args = [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30`,
    "-f", "lavfi", "-i", "sine=f=440:r=48000",
    "-t", String(seconds),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-b:v", bitrate,
    "-c:a", "aac", "-b:a", "128k",
    file
  ];
  const result = spawnSync(ffmpeg, args, { windowsHide: true });
  if (result.status !== 0 || !existsSync(file)) throw new Error(`Failed to generate ${name}`);
  return file;
}

function record(entry) {
  appendFileSync(outFile, `${JSON.stringify(entry)}\n`, "utf8");
  console.log(JSON.stringify(entry));
}

function targetFor(durationSec, height) {
  // Keep similar compression ratio to Phase 3/4 (~8 MB / 30s 1080p).
  const base = 8 * (durationSec / 30);
  const scale = height >= 2160 ? 2.2 : 1;
  return Math.max(4, Math.round(base * scale));
}

function main() {
  writeFileSync(outFile, "", "utf8");
  const ffmpeg = findFfmpeg();
  const sources = {
    p1080_30: ensureSource(ffmpeg, "src-1080p-30s.mp4", 1920, 1080, 30),
    p1080_300: ensureSource(ffmpeg, "src-1080p-5m.mp4", 1920, 1080, 300),
    p1080_1200: ensureSource(ffmpeg, "src-1080p-20m.mp4", 1920, 1080, 1200),
    p4k_30: ensureSource(ffmpeg, "src-4k-30s.mp4", 3840, 2160, 30),
    p4k_300: ensureSource(ffmpeg, "src-4k-5m.mp4", 3840, 2160, 300)
  };

  const qualityCases = [
    { key: "p1080_30", preference: "cpu", preset: "medium" },
    { key: "p1080_30", preference: "nvidia", preset: "fast" },
    { key: "p1080_30", preference: "amd", preset: "fast" },
    { key: "p4k_30", preference: "cpu", preset: "medium" },
    { key: "p4k_30", preference: "nvidia", preset: "fast" },
    { key: "p4k_30", preference: "amd", preset: "fast" }
  ];

  for (const test of qualityCases) {
    const src = sources[test.key];
    const duration = test.key.includes("300") || test.key.includes("1200")
      ? Number(test.key.split("_").pop())
      : test.key.includes("4k") ? 30 : 30;
    const width = test.key.startsWith("p4k") ? 3840 : 1920;
    const height = test.key.startsWith("p4k") ? 2160 : 1080;
    const durationSec = test.key === "p1080_300" || test.key === "p4k_300" ? 300
      : test.key === "p1080_1200" ? 1200 : 30;
    const targetMb = targetFor(durationSec, height);
    const result = runNode("bench-quality.js", [ffmpeg, src, test.preference, test.preset, String(targetMb), String(durationSec), String(width), String(height)]);
    record({ kind: "quality", scenario: test.key, ...test, ...(result.ok ? result.data : { error: result.error }) });
  }

  const batchPlan = [
    // 1080p 30s — full sweep
    ...["cpu|medium|1|4", "nvidia|fast|1|4", "nvidia|fast|2|4", "nvidia|fast|3|4", "nvidia|fast|4|4",
      "amd|fast|1|4", "amd|fast|2|4", "amd|fast|3|4", "amd|fast|4|4", "auto|fast|auto|4"
    ].map((spec) => ({ key: "p1080_30", duration: 30, width: 1920, height: 1080, spec })),
    // 1080p 5m — fewer copies
    ...["cpu|medium|1|2", "nvidia|fast|1|2", "nvidia|fast|2|2", "nvidia|fast|3|2",
      "amd|fast|1|2", "amd|fast|2|2", "auto|fast|auto|2"
    ].map((spec) => ({ key: "p1080_300", duration: 300, width: 1920, height: 1080, spec })),
    // 1080p 20m — single job throughput
    ...["cpu|medium|1|1", "nvidia|fast|1|1", "amd|fast|1|1", "auto|fast|auto|1"
    ].map((spec) => ({ key: "p1080_1200", duration: 1200, width: 1920, height: 1080, spec })),
    // 4K 30s
    ...["cpu|medium|1|2", "nvidia|fast|1|2", "nvidia|fast|2|2", "nvidia|fast|3|2",
      "amd|fast|1|2", "amd|fast|2|2", "auto|fast|auto|2"
    ].map((spec) => ({ key: "p4k_30", duration: 30, width: 3840, height: 2160, spec })),
    // 4K 5m — single
    ...["cpu|medium|1|1", "nvidia|fast|1|1", "amd|fast|1|1", "auto|fast|auto|1"
    ].map((spec) => ({ key: "p4k_300", duration: 300, width: 3840, height: 2160, spec }))
  ];

  for (const item of batchPlan) {
    const [preference, preset, concurrency, copies] = item.spec.split("|");
    const pref = preference === "auto" ? "auto" : preference;
    // Auto preference uses encoderPreference auto in settings; selectEncoder uses nvidia first today.
    const encoderPref = preference === "auto" ? "auto" : preference;
    const targetMb = targetFor(item.duration, item.height);
    const result = runNode("bench-batch.js", [
      ffmpeg, sources[item.key], encoderPref, preset, concurrency, copies,
      String(targetMb), String(item.duration), String(item.width), String(item.height), "30"
    ]);
    record({
      kind: "batch",
      scenario: item.key,
      requestedPreference: preference,
      ...(result.ok ? result.data : { error: result.error })
    });
  }

  console.error(`Wrote ${outFile}`);
}

main();

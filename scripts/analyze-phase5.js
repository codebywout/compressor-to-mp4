#!/usr/bin/env node
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const file = join(__dirname, "phase5-results.jsonl");
if (!existsSync(file)) {
  console.error("Missing phase5-results.jsonl");
  process.exit(1);
}

const rows = readFileSync(file, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const quality = rows.filter((row) => row.kind === "quality" && !row.error);
const batches = rows.filter((row) => row.kind === "batch" && !row.error);

console.log("=== QUALITY ===");
for (const row of quality) {
  console.log(`${row.scenario} ${row.preference}/${row.preset}: out=${row.outMb}MB limitOk=${row.limitOk} ssim=${row.ssim} vmaf=${row.vmaf} encoder=${row.encoder} ms=${row.encodeMs}`);
}

console.log("\n=== BEST BATCH THROUGHPUT PER SCENARIO ===");
const byScenario = new Map();
for (const row of batches) {
  const list = byScenario.get(row.scenario) || [];
  list.push(row);
  byScenario.set(row.scenario, list);
}
for (const [scenario, list] of byScenario) {
  const best = [...list].sort((a, b) => (b.videosPerMinute || 0) - (a.videosPerMinute || 0))[0];
  console.log(`${scenario}: best=${best.preference || best.requestedPreference} c=${best.concurrency} vpm=${best.videosPerMinute} wallMs=${best.wallMs} limitOk=${best.limitOk}`);
}

console.log("\n=== SCHEDULER WEIGHT VS AVG JOB MS ===");
const pairs = batches
  .filter((row) => row.schedulerWeight != null && row.avgJobMs != null && row.copies === 1)
  .map((row) => ({
    scenario: row.scenario,
    preference: row.preference,
    weight: row.schedulerWeight,
    avgJobMs: row.avgJobMs
  }));
for (const pair of pairs) {
  console.log(JSON.stringify(pair));
}
if (pairs.length >= 3) {
  const xs = pairs.map((p) => p.weight);
  const ys = pairs.map((p) => p.avgJobMs);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let denx = 0;
  let deny = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    denx += (xs[i] - mx) ** 2;
    deny += (ys[i] - my) ** 2;
  }
  const corr = denx > 0 && deny > 0 ? num / Math.sqrt(denx * deny) : null;
  console.log(`pearson_weight_vs_jobMs=${corr == null ? "n/a" : corr.toFixed(3)} n=${pairs.length}`);
}

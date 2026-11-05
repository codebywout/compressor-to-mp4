#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const packagePath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const current = String(pkg.version || "0.0.0");
const parts = current.split(".").map((value) => Number(value));
if (parts.length !== 3 || parts.some((value) => !Number.isInteger(value) || value < 0)) {
  console.error(`Ongeldige huidige versie: ${current}`);
  process.exit(1);
}

const bump = (process.argv[2] || "patch").toLowerCase();
if (bump === "major") {
  parts[0] += 1;
  parts[1] = 0;
  parts[2] = 0;
} else if (bump === "minor") {
  parts[1] += 1;
  parts[2] = 0;
} else if (bump === "patch") {
  parts[2] += 1;
} else if (/^\d+\.\d+\.\d+$/.test(bump)) {
  pkg.version = bump;
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(bump);
  process.exit(0);
} else {
  console.error("Gebruik: node scripts/bump-version.js [patch|minor|major|x.y.z]");
  process.exit(1);
}

pkg.version = parts.join(".");
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(pkg.version);

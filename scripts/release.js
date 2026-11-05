#!/usr/bin/env node
/**
 * Bumps the version, reminds you to commit/tag, and optionally publishes
 * a GitHub Release via electron-builder when GH_TOKEN is set.
 *
 * Usage:
 *   npm run release
 *   npm run release -- minor
 *   npm run release -- 1.3.0
 *   npm run release -- patch --publish
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const publish = args.includes("--publish");
const bumpArg = args.find((arg) => arg !== "--publish") || "patch";

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--use-system-ca"].filter(Boolean).join(" "),
      CSC_IDENTITY_AUTO_DISCOVERY: "false"
    },
    ...options
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

const bump = spawnSync(process.execPath, [path.join("scripts", "bump-version.js"), bumpArg], {
  cwd: root,
  encoding: "utf8"
});
if (bump.status !== 0) {
  process.stderr.write(bump.stderr || bump.stdout || "Versie verhogen mislukt.\n");
  process.exit(bump.status || 1);
}
const version = String(bump.stdout || "").trim();
console.log(`\nVersie → ${version}`);

const sync = spawnSync(process.execPath, [path.join("scripts", "sync-repository.js")], {
  cwd: root,
  encoding: "utf8"
});
if (sync.status === 0) {
  process.stdout.write(sync.stdout || "");
} else {
  console.warn(sync.stderr || sync.stdout || "Repository nog niet gekoppeld. Draai: npm run sync:repo -- jouw-user video-compressor");
  if (publish) process.exit(1);
}

run("npm", ["test"]);
run("npm", ["run", "clean"]);
run("npm", ["run", "build"]);

const builderArgs = ["node_modules/electron-builder/cli.js", "--win", "nsis"];
if (publish) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.error("\nGH_TOKEN of GITHUB_TOKEN ontbreekt. Zonder token kan electron-builder niet naar GitHub Releases publiceren.");
    process.exit(1);
  }
  builderArgs.push("--publish", "always");
} else {
  builderArgs.push("--publish", "never");
}

run(process.execPath, ["--use-system-ca", ...builderArgs]);

console.log(`\nKlaar. Installer: release/Video-Compressor-${version}-Setup.exe`);
if (!publish) {
  console.log(`
Volgende stappen voor GitHub Releases:
  1. Commit de versiebump
  2. git tag v${version}
  3. git push origin main --tags

Of publiceer lokaal:
  set GH_TOKEN=ghp_...
  npm run release -- ${version} --publish

Of laat GitHub Actions het doen na een tag push (workflow: .github/workflows/release.yml).
`);
} else {
  console.log(`\nRelease v${version} is naar GitHub gepubliceerd (als token/rechten kloppen).`);
}

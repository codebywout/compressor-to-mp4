#!/usr/bin/env node
/**
 * Writes package.json repository + publish config from:
 * 1. explicit args: owner repo
 * 2. GITHUB_REPOSITORY env (owner/name)
 * 3. git remote origin
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const packagePath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

function parseGithub(input) {
  if (!input) return null;
  const cleaned = String(input).trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  const match = /^([^/]+)\/([^/]+)$/.exec(cleaned);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function fromGitRemote() {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
    return parseGithub(remote);
  } catch {
    return null;
  }
}

const fromArgs = process.argv[2] && process.argv[3] ? { owner: process.argv[2], repo: process.argv[3] } : null;
const target = fromArgs || parseGithub(process.env.GITHUB_REPOSITORY) || fromGitRemote();

if (!target) {
  console.error("Geen GitHub-repository gevonden. Voorbeelden:");
  console.error("  node scripts/sync-repository.js jouw-user video-compressor");
  console.error("  set GITHUB_REPOSITORY=jouw-user/video-compressor");
  console.error("  git remote add origin https://github.com/jouw-user/video-compressor.git");
  process.exit(1);
}

pkg.repository = {
  type: "git",
  url: `https://github.com/${target.owner}/${target.repo}.git`
};
pkg.build = pkg.build || {};
pkg.build.publish = {
  provider: "github",
  owner: target.owner,
  repo: target.repo,
  releaseType: "release"
};

fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`GitHub Releases → ${target.owner}/${target.repo}`);

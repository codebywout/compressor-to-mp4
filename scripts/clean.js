const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");

function tryKill(imageName) {
  try {
    execFileSync("taskkill", ["/F", "/IM", imageName, "/T"], { stdio: "ignore" });
  } catch {
    // Process was not running.
  }
}

function remove(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log(`Removed ${path.relative(root, target)}`);
    return true;
  } catch (error) {
    console.warn(`Could not remove ${path.relative(root, target)}: ${error.message}`);
    return false;
  }
}

function truncateLockedFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      truncateLockedFiles(full);
      continue;
    }
    try {
      fs.writeFileSync(full, "");
      console.log(`Emptied locked file ${path.relative(root, full)}`);
    } catch {
      // Still locked for write as well.
    }
  }
}

function quarantine(target) {
  if (!fs.existsSync(target)) return;
  const backup = `${target}.old-${Date.now()}`;
  try {
    fs.renameSync(target, backup);
    console.log(`Moved locked ${path.relative(root, target)} -> ${path.basename(backup)}`);
    setTimeout(() => remove(backup), 0);
  } catch (error) {
    console.warn(`Could not quarantine ${path.relative(root, target)}: ${error.message}`);
    truncateLockedFiles(target);
  }
}

if (process.platform === "win32") {
  tryKill("VideoCompressor.exe");
  tryKill("Video Compressor.exe");
  tryKill("electron.exe");
}

for (const entry of fs.readdirSync(root)) {
  if (entry === "dist" || entry === "release" || entry.startsWith("dist.old-") || entry.startsWith("release.old-")) {
    const target = path.join(root, entry);
    if (!remove(target)) {
      quarantine(target);
    }
  }
}

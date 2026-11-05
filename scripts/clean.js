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

function quarantine(target) {
  if (!fs.existsSync(target)) return;
  const backup = `${target}.old-${Date.now()}`;
  try {
    fs.renameSync(target, backup);
    console.log(`Moved locked ${path.relative(root, target)} -> ${path.basename(backup)}`);
    setTimeout(() => remove(backup), 0);
  } catch (error) {
    console.warn(`Could not quarantine ${path.relative(root, target)}: ${error.message}`);
  }
}

if (process.platform === "win32") {
  tryKill("VideoCompressor.exe");
  tryKill("Video Compressor.exe");
  tryKill("electron.exe");
}

remove(path.join(root, "release"));
if (!remove(path.join(root, "dist"))) {
  quarantine(path.join(root, "dist"));
}

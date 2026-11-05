const fs = require("node:fs");
const path = require("node:path");

const source = path.join(__dirname, "..", "src", "renderer");
const destination = path.join(__dirname, "..", "dist", "src", "renderer");
fs.mkdirSync(destination, { recursive: true });
for (const file of fs.readdirSync(source)) {
  fs.copyFileSync(path.join(source, file), path.join(destination, file));
}

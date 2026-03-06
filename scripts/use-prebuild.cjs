#!/usr/bin/env node
/**
 * hmem-mcp postinstall — copy bundled prebuilt binary for better-sqlite3
 *
 * On platforms where better-sqlite3 couldn't compile (e.g. Windows without
 * Visual Studio Build Tools), this script copies a pre-compiled .node binary
 * from our bundled prebuilds/ directory to the location better-sqlite3 expects.
 *
 * better-sqlite3 is listed as optionalDependency so a compile failure doesn't
 * abort the install — this script then provides the binary.
 */

const { platform, arch } = process;
const path = require("path");
const fs = require("fs");

const prebuildFile = path.join(
  __dirname, "..", "prebuilds",
  `${platform}-${arch}`,
  "better_sqlite3.node"
);

// No prebuild for this platform — rely on compiled version
if (!fs.existsSync(prebuildFile)) {
  process.exit(0);
}

const targetDir = path.join(
  __dirname, "..", "node_modules", "better-sqlite3", "build", "Release"
);
const targetFile = path.join(targetDir, "better_sqlite3.node");

// Already compiled successfully — prebuild not needed
if (fs.existsSync(targetFile)) {
  process.exit(0);
}

try {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(prebuildFile, targetFile);
  console.log(`hmem-mcp: installed prebuilt binary for ${platform}-${arch}`);
} catch (e) {
  console.warn(`hmem-mcp: could not copy bundled binary: ${e.message}`);
  console.warn("hmem-mcp: if you see import errors, install Node.js build tools and reinstall.");
}

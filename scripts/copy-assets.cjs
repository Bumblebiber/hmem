#!/usr/bin/env node
/**
 * Copy non-TS build assets into dist/.
 *
 * tsc only emits compiled .js — runtime data files (the v2 SQL schema) live
 * alongside source and must be copied so dist/ is self-contained (smoke test,
 * published package).
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const assets = [
  ["src/store/schema-v2.sql", "dist/store/schema-v2.sql"],
];

for (const [from, to] of assets) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  if (!fs.existsSync(src)) {
    console.error(`copy-assets: source missing: ${from}`);
    process.exitCode = 1;
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

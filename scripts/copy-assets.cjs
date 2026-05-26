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

// tsc emits .js without the execute bit, but the `bin` entries are invoked
// directly via the global symlink (hooks and the statusline call `hmem`/
// `hmem-curate`), so they must be executable. npm sets this on install, but a
// local dev-link rebuild (`npm run build`) loses it — leaving hooks failing with
// "hmem: Permission denied". Restore +x here so every build is self-contained.
const bins = ["dist/cli.js", "dist/mcp-curate-server.js"];
for (const rel of bins) {
  const p = path.join(root, rel);
  if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
}

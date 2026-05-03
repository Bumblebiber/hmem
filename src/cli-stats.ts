/**
 * cli-stats.ts
 *
 * Shows per-project token size estimates and global memory stats.
 * Helps identify projects approaching the curation threshold (R0018: >4k tokens = trigger).
 *
 * Usage: hmem stats [project-id]
 */

import path from "node:path";
import { resolveEnvDefaults } from "./cli-env.js";
import { HmemStore } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";

const C = {
  green:  "\x1b[01;32m",
  yellow: "\x1b[01;33m",
  red:    "\x1b[01;31m",
  cyan:   "\x1b[00;36m",
  gray:   "\x1b[00;90m",
  white:  "\x1b[00;37m",
  bold:   "\x1b[01m",
  reset:  "\x1b[00m",
};

// R0018 thresholds (chars, not tokens — 1 token ≈ 4 chars)
const RED_THRESHOLD    = 16_000; // ~4k tokens
const YELLOW_THRESHOLD = 14_000; // ~3.5k tokens

function sizeColor(chars: number): string {
  if (chars >= RED_THRESHOLD)    return C.red;
  if (chars >= YELLOW_THRESHOLD) return C.yellow;
  return C.green;
}

function sizeLabel(chars: number): string {
  const tokens = Math.round(chars / 4);
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k tokens`;
  return `~${tokens} tokens`;
}

function relativeDate(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30)  return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export async function printStats(filterProject?: string): Promise<void> {
  resolveEnvDefaults();
  const hmemPath = process.env.HMEM_PATH;
  if (!hmemPath) {
    console.error("HMEM_PATH not set.");
    process.exit(1);
  }

  const dir = path.dirname(hmemPath);
  const config = loadHmemConfig(dir);
  const store = new HmemStore(hmemPath, config);

  const global = store.stats();
  const projects = store.projectTokenStats();

  const totalTokens = Math.round(global.totalChars / 4);

  console.log(`\n${C.bold}hmem stats${C.reset}  ${C.gray}${path.basename(hmemPath)}${C.reset}`);
  console.log(`${C.gray}${"─".repeat(60)}${C.reset}`);
  console.log(`  Total entries : ${C.white}${global.total}${C.reset}`);
  console.log(`  Total size    : ${C.white}${totalTokens >= 1000 ? (totalTokens/1000).toFixed(0)+"k" : totalTokens} tokens${C.reset}  ${C.gray}(${(global.totalChars/1024).toFixed(0)} KB)${C.reset}`);
  if (global.staleCount > 0) {
    console.log(`  Stale (60d+)  : ${C.yellow}${global.staleCount} entries${C.reset}`);
  }

  const prefixOrder = ["P","L","T","E","D","R","O","I","H","M","S","N","C","A"];
  const prefixLine = prefixOrder
    .filter(p => global.byPrefix[p])
    .map(p => `${C.gray}${p}${C.reset}${C.white}${global.byPrefix[p]}${C.reset}`)
    .join("  ");
  console.log(`  By prefix     : ${prefixLine}`);

  const filtered = filterProject
    ? projects.filter(p => p.id.toLowerCase() === filterProject.toLowerCase())
    : projects;

  if (filtered.length === 0) {
    console.log(`\n  ${C.gray}No matching projects.${C.reset}\n`);
    return;
  }

  console.log(`\n${C.bold}Projects — load_project size estimate${C.reset}  ${C.gray}(R0018: >4k = curate)${C.reset}`);
  console.log(`${C.gray}${"─".repeat(60)}${C.reset}`);

  for (const p of filtered) {
    const color = sizeColor(p.estChars);
    const flag = p.estChars >= RED_THRESHOLD ? " 🔴" : p.estChars >= YELLOW_THRESHOLD ? " 🟡" : "";
    const activeMarker = p.active ? ` ${C.cyan}●${C.reset}` : "";
    const label = sizeLabel(p.estChars);
    const date = relativeDate(p.lastAccessed);

    const idPart  = `${C.cyan}${p.id}${C.reset}`;
    const namePart = p.title.length > 28 ? p.title.substring(0, 27) + "…" : p.title.padEnd(28);
    const sizePart = `${color}${label}${C.reset}${flag}`;
    const datePart = `${C.gray}${date}${C.reset}`;

    console.log(`  ${idPart}${activeMarker}  ${namePart}  ${sizePart}  ${datePart}`);
  }

  console.log(`\n${C.gray}Thresholds: 🟡 ~3.5k tokens  🔴 ~4k tokens${C.reset}\n`);
}

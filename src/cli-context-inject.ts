/**
 * cli-context-inject.ts
 *
 * Called by Claude Code's SessionStart[clear] hook after /clear.
 * Outputs a compact context summary to stdout for re-injection:
 *   - Compact project overview (all P-entries, one line each, active marked)
 *   - R-entries (rules, one line each)
 *   - Hint to use load_project for full briefing
 *
 * Deliberately lightweight (~200 tokens). Full context comes from
 * load_project() or read_memory() which the agent calls next.
 *
 * Usage: hmem context-inject  (reads stdin JSON from Claude Code hook)
 *
 * Requires env:
 *   HMEM_PATH        — path to .hmem file (auto-detected)
 *   HMEM_PROJECT_DIR — directory for config + company.hmem
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { HmemStore } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";

export async function contextInject(): Promise<void> {
  // Resolve env defaults (HMEM_PATH, HMEM_PROJECT_DIR)
  resolveEnvDefaults();

  const projectDir = process.env.HMEM_PROJECT_DIR || "";
  if (!projectDir) {
    process.stderr.write("HMEM_PROJECT_DIR not set\n");
    return;
  }

  // Read hook input from stdin (required by Claude Code hook protocol)
  try {
    fs.readFileSync(0, "utf-8");
  } catch { /* no stdin — OK */ }

  const hmemPath = process.env.HMEM_PATH!;
  const config = loadHmemConfig(projectDir);

  let store;
  try {
    store = new HmemStore(hmemPath, config);
  } catch (e) {
    process.stderr.write(`Failed to open memory: ${e}\n`);
    return;
  }

  try {
    const lines: string[] = [];

    // 1. Compact project overview — one line per P-entry
    const allProjects = store.read({ prefix: "P", depth: 1 })
      .filter(e => !e.obsolete && !e.irrelevant);

    const activeProject = allProjects.find(e => e.active);

    if (allProjects.length > 0) {
      lines.push("## Projects:");
      for (const p of allProjects) {
        const marker = p.active ? " [*]" : "";
        lines.push(`  ${p.id}${marker}  ${p.title}`);
      }
    }

    // 2. R-entries (rules) — compact, one line each
    const rules = store.read({ prefix: "R", depth: 1 })
      .filter(r => !r.obsolete && !r.irrelevant);
    if (rules.length > 0) {
      lines.push("\n## Rules:");
      for (const r of rules) {
        const body = r.level_1 && r.level_1 !== r.title ? `\n> ${r.level_1}` : "";
        lines.push(`  ${r.id}  ${r.title}${body}`);
      }
    }

    // Explicitly name the active project so the agent doesn't guess an ID when
    // multiple P-entries exist (see issue #20).
    if (activeProject) {
      lines.push(`\n(Context re-injected after /clear. Continue with: load_project(id="${activeProject.id}")  — ${activeProject.title})`);
    } else {
      lines.push(`\n(Context re-injected after /clear. No active project — call load_project(id="P00XX") with the ID of the project you want to resume, or read_memory() to list them.)`);
    }

    process.stdout.write(lines.join("\n") + "\n");

    // Check if the previous session needs a summary (async, non-blocking)
    if (activeProject) {
      try {
        const projSeq = parseInt(activeProject.id.replace(/\D/g, ""), 10);
        const oId = `O${String(projSeq).padStart(4, "0")}`;
        const prevSession = store.getPreviousSession(oId);
        if (prevSession && prevSession.content === prevSession.title) {
          // No summary yet — resolve hmem binary and spawn async
          let hmemBin: string;
          try {
            hmemBin = execFileSync("which", ["hmem"], { encoding: "utf8" }).trim();
          } catch {
            hmemBin = path.join(path.dirname(process.execPath), "hmem");
          }
          const child = spawn(hmemBin, ["summarize-session", prevSession.id], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env },
          });
          child.unref();
        }
      } catch { /* non-critical */ }
    }
  } finally {
    store.close();
  }
}

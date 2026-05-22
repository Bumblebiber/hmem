/**
 * cli-context-inject.ts
 *
 * Called by Claude Code's SessionStart hook (matchers: startup|resume|clear|compact).
 *
 * Two responsibilities, branched by hook `source`:
 *   - clear|compact: emit a compact project + rules context block to stdout
 *     for re-injection after the prior context was wiped (~200 tokens).
 *   - all sources: if the previous session lacks an arc summary, spawn
 *     `hmem summarize-session` asynchronously. This closes the gap for
 *     sessions that ended without /clear (issue #31).
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

  // Read hook input from stdin (required by Claude Code hook protocol).
  // Skip when invoked from a TTY — sync-reading a TTY fd hangs until EOF.
  // Claude Code passes `source` to distinguish startup|resume|clear|compact.
  interface HookInput { session_id?: string; source?: string; transcript_path?: string }
  let hookInput: HookInput = {};
  if (!process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync(0, "utf-8").trim();
      if (raw) hookInput = JSON.parse(raw) as HookInput;
    } catch { /* no stdin or invalid JSON — OK */ }
  }
  // Re-injection of project/rules context only makes sense after the prior
  // context was wiped. On startup/resume the UserPromptSubmit hook already
  // injects this — emitting again here would double-inject.
  const source = hookInput.source ?? "clear";
  const emitContext = source === "clear" || source === "compact";

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
    // Active project drives both the context block and the prev-session lookup
    const allProjects = store.read({ prefix: "P", depth: 1 })
      .filter(e => !e.obsolete && !e.irrelevant);
    const activeProject = allProjects.find(e => e.active);

    if (emitContext) {
      const lines: string[] = [];

      // 1. Compact project overview — 5 most recently edited P-entries
      const recentProjects = [...allProjects]
        .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
        .slice(0, 5);

      if (recentProjects.length > 0) {
        lines.push("## Projects (5 most recent):");
        for (const p of recentProjects) {
          const marker = p.active ? " [*]" : "";
          lines.push(`  ${p.id}${marker}  ${p.title}`);
        }
        lines.push(`  (full list: read_memory({prefix:"P", titles_only:true}))`);
      }

      // 2. R-entries (rules) — only pinned [P] or favorite [♥] to keep startup compact.
      // To make a rule appear here: update_memory(id="R00XX", pinned=true)
      const rules = store.read({ prefix: "R", depth: 1 })
        .filter(r => !r.obsolete && !r.irrelevant && (r.pinned || r.favorite));
      if (rules.length > 0) {
        lines.push("\n## Rules (pinned/favorited):");
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
    }

    // Check if the previous session needs a summary (async, non-blocking).
    // Runs for every source — fires the summarize-session spawn even when the
    // user opens a fresh `claude` (startup) or `claude -c` (resume), so long
    // sessions that ended without /clear still get an arc summary (#31).
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

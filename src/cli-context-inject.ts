/**
 * cli-context-inject.ts
 *
 * Called by Claude Code's SessionStart hook (matchers: startup|resume|clear|compact).
 *
 * On clear|compact, emits a compact project + rules context block to stdout for
 * re-injection after the prior context was wiped (~200 tokens). On startup/resume
 * the UserPromptSubmit hook (`hook-startup`) already injects context, so this hook
 * stays quiet there to avoid double-injection.
 *
 * v2 model: reads the v2 `entries` table directly (P-entries by updated_at, pinned/
 * favorite R-entries). There is NO global `active` flag in v2 — "active project" is
 * the open `session_bindings` segment, resolved per-session elsewhere — so the block
 * lists recent projects and asks the agent to `load_project`. The previous v1
 * `summarize-session` async spawn is dropped: v2's sessions API closes + flushes
 * segments automatically via `onSegmentClose` (see store-facade / summarize/loop).
 *
 * Usage: hmem context-inject  (reads stdin JSON from Claude Code hook)
 *
 * Requires env:
 *   HMEM_PATH        — path to .hmem file (auto-detected)
 *   HMEM_PROJECT_DIR — directory for config + company.hmem
 */

import fs from "node:fs";
import { createV2Store } from "./v2/store-facade.js";
import { getSchemaMajor } from "./store/db.js";
import { loadHmemConfig, type HmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";

/**
 * Testable core: open the v2 store at `hmemPath` and build the SessionStart
 * re-injection context block from the v2 `entries` table. When the file is not a
 * schema_major=2 store (defensive — should never happen after the v1→v2 cutover)
 * `wrote` is `false` and `text` is empty.
 *
 * Performs NO stdin/env side-effects so it is safe to call from tests against a
 * temp DB.
 */
export function buildContextInjectV2(
  hmemPath: string,
  config: HmemConfig,
): { wrote: boolean; schemaMajor: string | null; text: string } {
  const store = createV2Store(hmemPath, config);
  try {
    const schemaMajor = getSchemaMajor(store.db);
    if (schemaMajor !== "2") return { wrote: false, schemaMajor, text: "" };

    const lines: string[] = [];

    // 1. Compact project overview — 5 most recently edited P-entries.
    //    (No `active` column in v2; recency stands in for "what you were on".)
    const recentProjects = store.db
      .prepare(
        `SELECT label, level_1 FROM entries
         WHERE prefix='P' AND deleted_at IS NULL AND obsolete=0 AND irrelevant=0
         ORDER BY updated_at DESC LIMIT 5`,
      )
      .all() as Array<{ label: string; level_1: string }>;

    if (recentProjects.length > 0) {
      lines.push("## Projects (5 most recent):");
      for (const p of recentProjects) {
        lines.push(`  ${p.label}  ${(p.level_1 ?? "").split("\n")[0]}`);
      }
      lines.push(`  (full list: read_memory({prefix:"P", titles_only:true}))`);
    }

    // 2. R-entries (rules) — only pinned or favorite to keep startup compact.
    //    To make a rule appear here: update_memory(id="R00XX", pinned=true)
    const rules = store.db
      .prepare(
        `SELECT label, level_1 FROM entries
         WHERE prefix='R' AND deleted_at IS NULL AND obsolete=0 AND irrelevant=0
         AND (pinned=1 OR favorite=1)
         ORDER BY seq ASC`,
      )
      .all() as Array<{ label: string; level_1: string }>;
    if (rules.length > 0) {
      lines.push("\n## Rules (pinned/favorited):");
      for (const r of rules) {
        const raw = r.level_1 ?? "";
        const title = raw.split("\n")[0];
        const rest = raw.includes("\n") ? `\n> ${raw.split("\n").slice(1).join(" ").trim()}` : "";
        lines.push(`  ${r.label}  ${title}${rest}`);
      }
    }

    lines.push(
      `\n(Context re-injected after /clear. Call load_project(id="P00XX") with the ID of the project you want to resume, or read_memory() to list them.)`,
    );

    return { wrote: true, schemaMajor, text: lines.join("\n") + "\n" };
  } finally {
    store.close();
  }
}

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
  if (!emitContext) return;

  const hmemPath = process.env.HMEM_PATH!;
  if (!hmemPath || !fs.existsSync(hmemPath)) return;
  const config = loadHmemConfig(projectDir);

  try {
    const { wrote, text } = buildContextInjectV2(hmemPath, config);
    if (wrote && text) process.stdout.write(text);
  } catch (e) {
    process.stderr.write(`Failed to build context: ${e}\n`);
  }
}

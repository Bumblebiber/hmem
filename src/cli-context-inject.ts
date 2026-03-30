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
 *   HMEM_PROJECT_DIR — root directory for .hmem files
 *   HMEM_AGENT_ID    — agent identifier (optional)
 */

import fs from "node:fs";
import { openAgentMemory } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";
import type { AgentRole } from "./hmem-store.js";

export async function contextInject(): Promise<void> {
  // Resolve env defaults (HMEM_PROJECT_DIR, HMEM_AGENT_ID)
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

  const agentId = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
  const templateName = agentId.replace(/_\d+$/, "");
  const config = loadHmemConfig(projectDir);

  let store;
  try {
    store = openAgentMemory(projectDir, templateName, config);
  } catch (e) {
    process.stderr.write(`Failed to open memory: ${e}\n`);
    return;
  }

  try {
    const lines: string[] = [];

    // 1. Compact project overview — one line per P-entry
    const allProjects = store.read({ prefix: "P", depth: 1, agentRole: "worker" as AgentRole })
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
    const rules = store.read({ prefix: "R", depth: 1, agentRole: "worker" as AgentRole })
      .filter(r => !r.obsolete && !r.irrelevant);
    if (rules.length > 0) {
      lines.push("\n## Rules:");
      for (const r of rules) {
        const body = r.level_1 && r.level_1 !== r.title ? `\n> ${r.level_1}` : "";
        lines.push(`  ${r.id}  ${r.title}${body}`);
      }
    }

    lines.push(`\n(Context re-injected after /clear. Use load_project for full briefing, read_memory(id) to drill into specific entries.)`);

    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    store.close();
  }
}

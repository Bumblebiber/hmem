/**
 * cli-context-inject.ts
 *
 * Called by Claude Code's SessionStart[clear] hook after /clear.
 * Reads hook input from stdin (JSON with transcript_path, session_id, etc.)
 * and outputs compressed context to stdout for re-injection:
 *   - Last N messages from the conversation transcript
 *   - Active project briefing (title + overview content)
 *   - Recent O-entries (session logs) linked to the project
 *   - R-entries (rules)
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

/** Number of recent conversation messages to include after /clear. */
const RECENT_MESSAGES = 20;

interface TranscriptLine {
  type?: string;
  role?: string;
  message?: {
    role?: string;
    content?: string | { type: string; text?: string }[];
  };
  content?: string | { type: string; text?: string }[];
}

/** Read the last N user/assistant messages from a JSONL transcript. */
function readRecentTranscript(transcriptPath: string, count: number): string[] {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  const stat = fs.statSync(transcriptPath);
  const TAIL_BYTES = 5 * 1024 * 1024; // 5MB tail
  const start = Math.max(0, stat.size - TAIL_BYTES);

  const fd = fs.openSync(transcriptPath, "r");
  const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);

  const text = buf.toString("utf-8");
  const lines = text.split("\n").filter(l => l.trim());

  const messages: string[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as TranscriptLine;

      // Claude Code transcript format: { type: "human"|"assistant", message: { role, content } }
      const role = entry.type || entry.role || entry.message?.role;
      if (role !== "human" && role !== "assistant" && role !== "user") continue;

      const content = entry.message?.content || entry.content;
      if (!content) continue;

      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(c => c.type === "text" && c.text)
          .map(c => c.text!)
          .join("\n");
      } else {
        continue;
      }

      if (!text.trim()) continue;

      const label = (role === "human" || role === "user") ? "USER" : "ASSISTANT";
      // Truncate very long messages (e.g. tool outputs)
      const maxLen = 500;
      const truncated = text.length > maxLen ? text.substring(0, maxLen) + "..." : text;
      messages.push(`${label}: ${truncated}`);
    } catch { /* skip malformed lines */ }
  }

  return messages.slice(-count);
}

export async function contextInject(): Promise<void> {
  // Resolve env defaults (HMEM_PROJECT_DIR, HMEM_AGENT_ID)
  resolveEnvDefaults();

  const projectDir = process.env.HMEM_PROJECT_DIR || "";
  if (!projectDir) {
    process.stderr.write("HMEM_PROJECT_DIR not set\n");
    return;
  }

  // Read hook input from stdin
  let transcriptPath = "";
  try {
    const stdin = fs.readFileSync(0, "utf-8").trim();
    if (stdin) {
      const input = JSON.parse(stdin);
      transcriptPath = input.transcript_path || "";
    }
  } catch { /* no stdin or invalid JSON — OK */ }

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

    // 1. Recent conversation transcript
    const recentMessages = readRecentTranscript(transcriptPath, RECENT_MESSAGES);
    if (recentMessages.length > 0) {
      lines.push("## Recent conversation (before /clear):");
      lines.push(...recentMessages);
      lines.push("");
    }

    // 2. Active project briefing
    const allEntries = store.read({ prefix: "P", depth: 1, agentRole: "worker" as AgentRole });
    const activeProject = allEntries.find(e => e.active && !e.obsolete && !e.irrelevant);

    if (activeProject) {
      const projectEntries = store.read({
        id: activeProject.id,
        depth: 3,
        expand: true,
        agentRole: "worker" as AgentRole,
      });

      if (projectEntries.length > 0) {
        const p = projectEntries[0];
        lines.push(`## Active project: ${p.id}  ${p.title}`);
        if (p.level_1 && p.level_1 !== p.title) lines.push(`  ${p.level_1}`);

        // Overview node (.1) — expand with full content
        if (p.children) {
          const overview = p.children.find((c: any) => c.seq === 1);
          if (overview) {
            lines.push(`  Overview:`);
            if (overview.children) {
              for (const gc of overview.children.filter((g: any) => !g.irrelevant)) {
                lines.push(`    ${gc.content}`);
              }
            }
          }
        }

        // 3. Recent O-entries linked to project (full exchanges for all)
        if (config.recentOEntries > 0) {
          const recentO = store.getRecentOEntries(config.recentOEntries, activeProject.id);
          if (recentO.length > 0) {
            lines.push(`\n  Recent sessions:`);
            for (let i = 0; i < recentO.length; i++) {
              const o = recentO[i];
              lines.push(`    ${o.id}  ${o.created_at.substring(0, 10)}  ${o.title}`);
              // Always show: latest summary (if any) + last 5 exchanges verbatim
              const VERBATIM_WINDOW = 5;
              const summaries = store.getCheckpointSummaries(o.id, 1);
              if (summaries.length > 0) {
                lines.push(`      [Summary] ${summaries[0].content}`);
              }
              const exchanges = store.getOEntryExchanges(o.id, VERBATIM_WINDOW, true);
              for (const ex of exchanges) {
                const userShort = ex.userText.length > 300 ? ex.userText.substring(0, 300) + "..." : ex.userText;
                const agentShort = ex.agentText.length > 500 ? ex.agentText.substring(0, 500) + "..." : ex.agentText;
                lines.push(`      USER: ${userShort}`);
                if (agentShort) lines.push(`      AGENT: ${agentShort}`);
              }
            }
          }
        }
      }
    } else {
      const projects = allEntries.filter(e => !e.obsolete && !e.irrelevant);
      lines.push("## No active project. Available:");
      for (const p of projects) {
        lines.push(`  ${p.id}  ${p.title}`);
      }
    }

    // 4. R-entries (rules)
    const rules = store.read({ prefix: "R", depth: 1, agentRole: "worker" as AgentRole })
      .filter(r => !r.obsolete && !r.irrelevant);
    if (rules.length > 0) {
      lines.push("\n## Rules:");
      for (const r of rules) {
        lines.push(`  ${r.id}  ${r.title}`);
      }
    }

    lines.push("\n(Context re-injected after /clear. Use load_project for full briefing, read_memory(id) to drill into specific entries.)");

    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    store.close();
  }
}

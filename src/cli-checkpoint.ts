/**
 * cli-checkpoint.ts
 *
 * Automatic checkpoint: reads recent exchanges from the active O-entry,
 * then spawns a Haiku subagent WITH MCP tool access that writes L/D/E entries
 * and updates the project handoff. The subagent follows the hmem-write skill rules.
 *
 * Designed to run in the background (spawned by the Stop hook when checkpointMode is "auto").
 *
 * Usage: hmem checkpoint
 *
 * Requires env:
 *   HMEM_PROJECT_DIR — root directory for .hmem files
 *   HMEM_AGENT_ID    — agent identifier (optional, auto-detected)
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { HmemStore, resolveHmemPath } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";

/** Build a minimal MCP config JSON for the subagent (hmem only). */
function buildMcpConfig(projectDir: string, agentId: string): string {
  // Find the hmem-mcp entry point
  let hmemServerPath: string;
  try {
    hmemServerPath = execSync("which hmem", { encoding: "utf8" }).trim();
    // Resolve symlink to find the actual JS file
    const realPath = fs.realpathSync(hmemServerPath);
    hmemServerPath = path.join(path.dirname(realPath), "mcp-server.js");
    if (!fs.existsSync(hmemServerPath)) {
      // Fallback: look in the dist directory relative to the resolved path
      hmemServerPath = path.join(path.dirname(path.dirname(realPath)), "dist", "mcp-server.js");
    }
  } catch {
    // Fallback: global npm path
    hmemServerPath = path.join(
      process.env.HOME || "/home",
      ".nvm/versions/node",
      process.version,
      "lib/node_modules/hmem-mcp/dist/mcp-server.js"
    );
  }

  const nodePath = process.execPath;
  const config = {
    mcpServers: {
      hmem: {
        command: nodePath,
        args: [hmemServerPath],
        env: {
          HMEM_PROJECT_DIR: projectDir,
          HMEM_AGENT_ID: agentId,
          HMEM_NO_SESSION: "1",
        },
      },
    },
  };

  const tmpPath = path.join("/tmp", `hmem-checkpoint-mcp-${process.pid}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf8");
  return tmpPath;
}

export async function checkpoint(): Promise<void> {
  const projectDir = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR;
  if (!projectDir) process.exit(0);

  const agentId = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
  const templateName = agentId.replace(/_\d+$/, "");
  const hmemPath = resolveHmemPath(projectDir, templateName);
  if (!fs.existsSync(hmemPath)) process.exit(0);

  const config = loadHmemConfig(path.dirname(hmemPath));
  const store = new HmemStore(hmemPath, config);

  let mcpConfigPath = "";

  try {
    // 1. Get active O-entry and recent exchanges
    const activeOId = store.getActiveOId();
    if (!activeOId) return;

    const exchanges = store.getOEntryExchanges(activeOId, 20);
    if (exchanges.length < 3) return; // Not enough context

    // 2. Get active project
    const activeProject = store.getActiveProject();
    const projectName = activeProject?.title?.split("|")[0]?.trim() ?? "unknown";
    const projectId = activeProject?.id ?? "";

    // 3. Tag skill-dialog exchanges (brainstorming, debugging, TDD, etc.)
    const skillMarker = "Base directory for this skill:";
    for (const ex of exchanges) {
      if (ex.userText.includes(skillMarker)) {
        store.addTag(ex.nodeId, "#skill-dialog");
      }
    }

    // 4. Get previous checkpoint summaries for rolling compression
    const prevSummaries = store.getCheckpointSummaries(activeOId, 2);
    const lastSummarySeq = prevSummaries.length > 0 ? prevSummaries[0].seq : 0;

    // Only format exchanges AFTER the last summary (those are new)
    const newExchanges = exchanges.filter(ex => ex.seq > lastSummarySeq);

    // 5. Format exchanges (generous limits — Haiku needs context)
    const formattedExchanges = newExchanges.map((ex, i) => {
      const user = ex.userText.length > 800 ? ex.userText.substring(0, 800) + "..." : ex.userText;
      const agent = ex.agentText.length > 1200 ? ex.agentText.substring(0, 1200) + "..." : ex.agentText;
      return `--- Exchange ${i + 1} (${ex.nodeId}) ---\nUSER: ${user}\nAGENT: ${agent}`;
    }).join("\n\n");

    // Format previous summaries for rolling compression
    let prevSummaryText = "";
    if (prevSummaries.length > 0) {
      const parts = prevSummaries.reverse().map((s, i) => {
        const label = i === prevSummaries.length - 1 ? "Most recent summary" : "Older summary";
        return `[${label} — ${s.created_at.substring(0, 16)}]\n${s.content}`;
      });
      prevSummaryText = parts.join("\n\n");
    }

    // 6. Close store before spawning subagent (avoid DB lock)
    store.close();

    // 5. Build MCP config for subagent
    mcpConfigPath = buildMcpConfig(projectDir, agentId);

    // 7. Build the prompt
    const summarySection = prevSummaryText
      ? `\n## Previous checkpoint summaries (oldest first):\n\n${prevSummaryText}\n`
      : "";

    const prompt = `Checkpoint agent: save NON-OBVIOUS insights to hmem.

Project: ${projectName} (${projectId}) | O-entry: ${activeOId}
${summarySection}
## Exchanges:

${formattedExchanges}

**L/D/E** — non-obvious insights only (not feature descriptions):
- L: Lesson, e.g. "HMEM_AGENT_ID must be in hook env or wrong .hmem file is used"
- E: Bug + root cause + fix
- D: Architecture decision + rationale
- Handoff → append_memory(id="${projectId}.7", content="Handoff (YYYY-MM-DD HH:MM): ...")

write_memory for L/D/E: tags 3-5, links=["${projectId}"]. Max 2-3.

**Summary:** append_memory(id="${activeOId}", content="\\t[CP] ...")
- Compress prior summaries to 1-2 sentences${prevSummaries.length > 0 ? " (shown above)" : ""}
- Detail exchanges; 3-8 factual sentences, match project language

read_memory() first. Skip duplicates; extend existing via append_memory. Always write summary.`;

    // 7. Spawn Haiku with MCP access
    const allowedTools = [
      "mcp__hmem__read_memory",
      "mcp__hmem__write_memory",
      "mcp__hmem__append_memory",
      "mcp__hmem__update_memory",
    ].join(" ");
    const disallowedTools = "mcp__hmem__flush_context";

    try {
      const output = execSync(
        `claude -p --model haiku --mcp-config "${mcpConfigPath}" --allowedTools "${allowedTools}" --disallowedTools "${disallowedTools}" --dangerously-skip-permissions 2>/dev/null`,
        {
          input: prompt,
          encoding: "utf8",
          timeout: 120_000,
        }
      ).trim();

      console.log(`[hmem checkpoint] Haiku: ${output.substring(0, 300)}`);

      // Tag the checkpoint summary node that Haiku wrote via append_memory
      // Haiku writes it as a [CP] prefixed L2 node under the O-entry
      try {
        const postStore = new HmemStore(hmemPath, config);
        const tagged = postStore.tagNewCheckpointSummaries(activeOId);
        if (tagged.length > 0) {
          console.log(`[hmem checkpoint] Tagged checkpoint summaries: ${tagged.join(", ")}`);
        }
        postStore.close();
      } catch (tagErr) {
        console.error(`[hmem checkpoint] Failed to tag summary: ${tagErr}`);
      }
    } catch (e: any) {
      const stdout = e.stdout?.toString()?.substring(0, 200) || "";
      console.error(`[hmem checkpoint] Failed (exit ${e.status}): ${stdout}`);
    }

  } catch (e) {
    console.error(`[hmem checkpoint] ${e}`);
  } finally {
    // Cleanup temp MCP config
    if (mcpConfigPath) {
      try { fs.unlinkSync(mcpConfigPath); } catch {}
    }
  }
}

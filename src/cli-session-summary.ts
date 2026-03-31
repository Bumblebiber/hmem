/**
 * cli-session-summary.ts
 *
 * Spawns Haiku to write a session summary (L2 body) for a completed session.
 * Called async from SessionStart hook when previous session lacks a summary.
 *
 * Usage: hmem summarize-session O0048.3
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { HmemStore, resolveHmemPath } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";

function buildMcpConfig(projectDir: string, agentId: string): string {
  let hmemServerPath: string;
  try {
    hmemServerPath = execSync("which hmem", { encoding: "utf8" }).trim();
    const realPath = fs.realpathSync(hmemServerPath);
    hmemServerPath = path.join(path.dirname(realPath), "mcp-server.js");
    if (!fs.existsSync(hmemServerPath)) {
      hmemServerPath = path.join(path.dirname(path.dirname(realPath)), "dist", "mcp-server.js");
    }
  } catch {
    hmemServerPath = path.join(
      process.env.HOME || "/home",
      ".nvm/versions/node", process.version,
      "lib/node_modules/hmem-mcp/dist/mcp-server.js"
    );
  }

  const config = {
    mcpServers: {
      hmem: {
        command: process.execPath,
        args: [hmemServerPath],
        env: { HMEM_PROJECT_DIR: projectDir, HMEM_AGENT_ID: agentId, HMEM_NO_SESSION: "1" },
      },
    },
  };

  const tmpPath = path.join("/tmp", `hmem-session-summary-${process.pid}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf8");
  return tmpPath;
}

export async function summarizeSession(sessionId: string): Promise<void> {
  if (!sessionId) {
    console.error("[hmem summarize-session] No session ID provided");
    process.exit(1);
  }

  resolveEnvDefaults();
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
    // Get all L3 batch nodes for this session
    const batches = store.getChildNodes(sessionId);
    if (batches.length === 0) return;

    const batchSummaries = batches
      .filter(b => b.depth === 3 && b.content !== b.title) // only batches with actual summaries
      .map(b => `${b.id}: ${b.content}`)
      .join("\n\n");

    if (!batchSummaries) return; // no summaries to work with

    store.close();

    mcpConfigPath = buildMcpConfig(projectDir, agentId);

    const prompt = `Summarize session ${sessionId}.

== Batch Summaries ==
${batchSummaries}

## Task
Write a compact session summary (max 200 words) as the body of ${sessionId}.
What was achieved? What's still open?
Match the language of the batch summaries.

update_memory(id="${sessionId}", content="Session summary text here")`;

    const allowedTools = "mcp__hmem__update_memory mcp__hmem__read_memory";

    execSync(
      `claude -p --model haiku --mcp-config "${mcpConfigPath}" --allowedTools "${allowedTools}" --dangerously-skip-permissions 2>/dev/null`,
      { input: prompt, encoding: "utf8", timeout: 60_000 }
    );

    console.log(`[hmem] Session summary written for ${sessionId}`);

  } catch (e) {
    console.error(`[hmem summarize-session] ${e}`);
  } finally {
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch {}
  }
}

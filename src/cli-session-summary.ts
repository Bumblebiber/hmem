/**
 * cli-session-summary.ts
 *
 * Spawns Haiku to write a session summary (L2 body) for a completed session.
 * Called async from SessionStart hook when previous session lacks a summary.
 *
 * Usage: hmem summarize-session O0048.3
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { HmemStore } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";

function buildMcpConfig(projectDir: string, hmemPath: string): string {
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
        env: { HMEM_PROJECT_DIR: projectDir, HMEM_PATH: hmemPath, HMEM_NO_SESSION: "1" },
      },
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-session-summary-"));
  fs.chmodSync(tmpDir, 0o700);
  const tmpPath = path.join(tmpDir, "mcp-config.json");
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf8");
  return tmpPath;
}

export async function summarizeSession(sessionId: string): Promise<void> {
  if (!sessionId) {
    console.error("[hmem summarize-session] No session ID provided");
    process.exit(1);
  }

  resolveEnvDefaults();
  const projectDir = process.env.HMEM_PROJECT_DIR!;
  if (!projectDir) process.exit(0);

  const hmemPath = process.env.HMEM_PATH!;
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

    mcpConfigPath = buildMcpConfig(projectDir, hmemPath);

    const prompt = `Summarize session ${sessionId}.

== Batch Summaries ==
${batchSummaries}

## Task
Write a compact session summary (max 200 words) as the body of ${sessionId}.
What was achieved? What's still open?
Match the language of the batch summaries.

update_memory(id="${sessionId}", content="Session summary text here")`;

    const allowedTools = "mcp__hmem__update_memory mcp__hmem__read_memory";

    execFileSync("claude", [
      "-p", "--model", "haiku",
      "--mcp-config", mcpConfigPath,
      "--allowedTools", allowedTools,
      "--dangerously-skip-permissions",
    ], { input: prompt, encoding: "utf8", timeout: 60_000 });

    console.log(`[hmem] Session summary written for ${sessionId}`);

  } catch (e) {
    console.error(`[hmem summarize-session] ${e}`);
  } finally {
    if (mcpConfigPath) {
      try { fs.unlinkSync(mcpConfigPath); } catch {}
      try { fs.rmdirSync(path.dirname(mcpConfigPath)); } catch {}
    }
  }
}

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

    // 3. Format exchanges (generous limits — Haiku needs context)
    const formattedExchanges = exchanges.map((ex, i) => {
      const user = ex.userText.length > 800 ? ex.userText.substring(0, 800) + "..." : ex.userText;
      const agent = ex.agentText.length > 1200 ? ex.agentText.substring(0, 1200) + "..." : ex.agentText;
      return `--- Exchange ${i + 1} ---\nUSER: ${user}\nAGENT: ${agent}`;
    }).join("\n\n");

    // 4. Close store before spawning subagent (avoid DB lock)
    store.close();

    // 5. Build MCP config for subagent
    mcpConfigPath = buildMcpConfig(projectDir, agentId);

    // 6. Build the prompt
    const prompt = `You are a background checkpoint agent. Your job is to extract valuable knowledge from a coding session and save it to long-term memory using the hmem MCP tools.

## Context

Project: ${projectName} (${projectId})
Active O-entry: ${activeOId}

## Recent conversation (oldest first):

${formattedExchanges}

## Your task

Analyze the conversation above and save NON-OBVIOUS insights to memory. Follow these rules strictly:

### What to save (ONLY if present):
1. **Lessons (L)**: Technical insights, best practices discovered, "aha moments"
   - BAD: "Stop Hook logs exchanges" (that's a feature description, not a lesson)
   - GOOD: "HMEM_AGENT_ID must be set in hook scripts, otherwise resolveHmemPath falls back to memory.hmem instead of Agents/NAME/NAME.hmem"

2. **Errors (E)**: Bugs encountered + root cause + fix
   - GOOD: "TypeScript compile error: store.db is private — fixed by adding public helper methods getActiveOId(), getActiveProject(), findChildNode()"

3. **Decisions (D)**: Architecture/design decisions + rationale
   - GOOD: "Checkpoint uses claude -p --model haiku with --mcp-config for MCP tool access — alternative was direct DB writes but that produced low-quality entries without proper context"

4. **Handoff**: Update the project's Protocol section with current state
   - 2-3 sentences: what was accomplished, what's in progress, next step
   - Use: append_memory(id="${projectId}.7", content="Handoff (YYYY-MM-DD HH:MM): ...")

### Rules:
- Use write_memory for L/D/E entries. Always include tags (3-5) and links=["${projectId}"]
- Use append_memory to update the Protocol handoff (${projectId}.7)
- Match the language of existing entries (check with read_memory first)
- Skip if nothing noteworthy — don't write garbage entries
- Max 2-3 entries total. Quality over quantity
- Each L1 must be a complete, self-contained sentence (~15-20 tokens)
- Title (~50 chars) should be specific, not vague

### Before writing:
1. Call read_memory() to see existing entries — avoid duplicates
2. Check if a similar L/D/E already exists before creating a new one
3. If it does, use append_memory to extend it instead

Now analyze the conversation and save what's worth keeping. If nothing is noteworthy, just say "Nothing to save." and exit.`;

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

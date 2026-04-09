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
 *   HMEM_PATH        — path to .hmem file (auto-detected)
 *   HMEM_PROJECT_DIR — directory for config + company.hmem
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { HmemStore } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";

/** Build a minimal MCP config JSON for the subagent (hmem only). */
function buildMcpConfig(projectDir: string, hmemPath: string): string {
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
          HMEM_PATH: hmemPath,
          HMEM_NO_SESSION: "1",
        },
      },
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-checkpoint-"));
  fs.chmodSync(tmpDir, 0o700);
  const tmpPath = path.join(tmpDir, "mcp-config.json");
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf8");
  return tmpPath;
}

export async function checkpoint(): Promise<void> {
  const projectDir = process.env.HMEM_PROJECT_DIR;
  if (!projectDir) process.exit(0);

  const hmemPath = process.env.HMEM_PATH!;
  if (!fs.existsSync(hmemPath)) process.exit(0);

  const config = loadHmemConfig(path.dirname(hmemPath));
  const store = new HmemStore(hmemPath, config);

  let mcpConfigPath = "";

  try {
    // 1. Get active project and its O-entry (prefer env from log-exchange, fallback to DB)
    const envProjectId = process.env.HMEM_ACTIVE_PROJECT;
    const activeProject = envProjectId
      ? store.getProjectById(envProjectId)
      : store.getActiveProject(process.env.HMEM_SESSION_ID);
    if (!activeProject) return;

    const projectSeq = parseInt(activeProject.id.replace(/\D/g, ""), 10);
    const oId = store.resolveProjectO(projectSeq);

    // 2. Find the latest full batch (L3 with >= batchSize L4 children)
    const batchSize = config.checkpointInterval || 5;
    const latestFullBatch = store.getLatestFullBatch(oId, batchSize);

    if (!latestFullBatch) return;
    const batchId = latestFullBatch.id;
    const sessionId = latestFullBatch.sessionId;

    // 3. Get exchanges from this batch
    const allExchanges = store.getOEntryExchangesV2(oId, batchSize * 3);
    const batchExchanges = allExchanges.filter(ex => ex.nodeId.startsWith(batchId + "."));
    if (batchExchanges.length < 2) return;

    // 4. Tag skill-dialog exchanges
    const skillMarker = "Base directory for this skill:";
    for (const ex of batchExchanges) {
      if (ex.userText.includes(skillMarker)) {
        store.addTag(ex.nodeId, "#skill-dialog");
      }
    }

    // 5. Get previous batch's rolling summary
    const prevBatch = store.getPreviousBatch(sessionId, batchId);

    // 6. Get all P-entry titles
    const allProjects = store.listProjects();

    const projectName = activeProject.title.split("|")[0].trim();
    const projectId = activeProject.id;

    // Close store before spawning subagent
    store.close();

    // 7. Build MCP config and prompt
    mcpConfigPath = buildMcpConfig(projectDir, hmemPath);

    const formattedExchanges = batchExchanges.map((ex, i) => {
      // Strip XML channel tags from Telegram messages before passing to Haiku
      let user = ex.userText.replace(/<channel[^>]*>\s*/g, "").replace(/<\/channel>\s*/g, "").trim();
      let agent = ex.agentText.replace(/<[^>]+>/g, "").trim();
      user = user.length > 800 ? user.substring(0, 800) + "..." : user;
      agent = agent.length > 1200 ? agent.substring(0, 1200) + "..." : agent;
      return `--- Exchange ${i + 1} (${ex.nodeId}) ---\nUSER: ${user}\nAGENT: ${agent}`;
    }).join("\n\n");

    const projectList = allProjects.map(p => `  ${p.id} ${p.title}`).join("\n");

    const prevSummaryText = prevBatch && prevBatch.content !== prevBatch.title
      ? `\n## Previous batch rolling summary:\n${prevBatch.content}\n`
      : "";

    const exchangeListing = batchExchanges.map(ex =>
      `  ${ex.nodeId}: "${ex.title}"`
    ).join("\n");

    const prompt = `You are a checkpoint agent for "${projectName}" (${projectId}).
Process batch ${batchId} with ${batchExchanges.length} exchanges.

== All Projects ==
${projectList}

== Active Project ==
${projectId} ${projectName}
${prevSummaryText}
== Batch Exchanges ==
${formattedExchanges}

## Tasks (execute ALL in order):

### 1. Title each exchange (REQUIRED)
Current titles (auto-extracted):
${exchangeListing}

For each: update_memory(id="<nodeId>", content="Descriptive title, max 50 chars, match conversation language")

CRITICAL title rules:
- Describe WHAT HAPPENED or WHAT WAS DECIDED, not what was said
- BAD: "Projekt hmem laden" (just repeats user message)
- BAD: "Ja" or "Reconnected" (meaningless)
- GOOD: "Load hmem project, evaluate output quality"
- GOOD: "Fix: cleanTitle strips body separators from titles"
- If the exchange is trivial (greeting, "ok", "yes"), title it as context: "Confirm: proceed with commit"

### 2. Write rolling summary for this batch
update_memory(id="${batchId}", content="Rolling summary: 3-8 sentences covering this batch${prevBatch ? " + previous summary" : ""}. Match conversation language.")
${prevBatch ? "IMPORTANT: Incorporate the previous batch summary — your new summary is cumulative." : "This is the first batch."}

### 3. Extract knowledge (STRICT quality gate — max 1-2)
write_memory(prefix="<any prefix>", content="Concise insight title\n> 2-4 sentence explanation with specific details", tags=[3-5 tags], links=["${projectId}", "${batchId}"])
Valid prefixes: L (lesson), E (error), D (decision), R (rule), C (convention).

Quality gate — SKIP unless the entry passes ALL checks:
- Would a developer find this useful 6 months from now? If not, skip.
- Is it a specific, actionable insight? Vague observations are NOT lessons.
- Does it already exist in memory? Do NOT duplicate known information.
- NEVER write test entries, placeholder entries, or "delete me" entries.
- When in doubt, skip. Writing nothing is better than writing noise.

### 4. Update project P-entry (only if meaningful changes happened)
read_memory(id="${projectId}") first. Only update if this batch contains significant changes:
- Bugs (.6): new bug discovered or existing bug fixed
- Open Tasks (.8): task completed (prefix with "✓ DONE:") or new task identified
- Overview (.1): only if architecture or core behavior changed
- Do NOT update Protocol (.7) — session summaries already cover this.
- Do NOT update if this batch was just discussion/planning with no concrete outcome.

### 5. Tag exchanges
For each exchange, consider adding ONE tag if applicable:
- #skill-dialog: Skill output (brainstorming, TDD, etc.)
- #irrelevant: No value (greetings, "ok", typo corrections)
- #planning: Design/architecture discussion
- #debugging: Bug hunting/fixing
- #admin: Setup, config, infra work
- #meta: Discussion ABOUT the project's tooling/memory/config, not actual project work (e.g. hmem config, sync issues, memory curation, entry cleanup)
- #repetition: User repeating something already known/stored — redundant exchange, don't include in summary

### 6. Update session ${sessionId} — title AND summary
update_memory(id="${sessionId}", content="Short session title, max 60 chars\n> Cumulative session summary: 3-10 sentences covering ALL batches so far. Key decisions, outcomes, what changed, what's next. This is what load_project shows — make it count.")

### 7. Project relevance check
Do ALL exchanges belong to ${projectName}?
Check against the project list above. If an exchange belongs elsewhere, call:
move_nodes(node_ids=["<exchange_id>"], target_o_id="O00XX")

## Rules:
- read_memory() FIRST to see current state
- Match language of existing entries
- Tags: 3-5 per entry, lowercase with #
- Only save what's valuable in 6 months`;

    // 8. Spawn Haiku with MCP access
    const allowedTools = [
      "mcp__hmem__read_memory",
      "mcp__hmem__write_memory",
      "mcp__hmem__append_memory",
      "mcp__hmem__update_memory",
      "mcp__hmem__list_projects",
      "mcp__hmem__move_nodes",
    ].join(" ");
    const disallowedTools = "mcp__hmem__flush_context";

    try {
      const output = execFileSync("claude", [
        "-p", "--model", "haiku",
        "--mcp-config", mcpConfigPath,
        "--allowedTools", allowedTools,
        "--disallowedTools", disallowedTools,
        "--dangerously-skip-permissions",
      ], { input: prompt, encoding: "utf8", timeout: 120_000 }).trim();
      console.log(`[hmem checkpoint] Haiku: ${output.substring(0, 300)}`);
    } catch (e: any) {
      const stdout = e.stdout?.toString()?.substring(0, 200) || "";
      console.error(`[hmem checkpoint] Failed (exit ${e.status}): ${stdout}`);
    }

  } catch (e) {
    console.error(`[hmem checkpoint] ${e}`);
  } finally {
    if (mcpConfigPath) {
      try { fs.unlinkSync(mcpConfigPath); } catch {}
      try { fs.rmdirSync(path.dirname(mcpConfigPath)); } catch {}
    }
  }
}

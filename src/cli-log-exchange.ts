/**
 * cli-log-exchange.ts
 *
 * Called by Claude Code's Stop hook after every agent response.
 * Reads the last user message from the session JSONL transcript,
 * combines it with the agent's response (from stdin hook JSON),
 * and appends both to the currently active O-entry.
 *
 * Usage: echo '{"transcript_path":"...","last_assistant_message":"..."}' | hmem log-exchange
 *
 * Requires env:
 *   HMEM_PATH        — path to .hmem file (auto-detected)
 *   HMEM_PROJECT_DIR — directory for config + company.hmem
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { HmemStore } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";
import { writeDiagnostic } from "./diagnostics.js";
import { readSessionMarker } from "./session-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HMEM_BIN = path.resolve(__dirname, "../dist/cli.js");

interface HookInput {
  transcript_path?: string;
  last_assistant_message?: string;
  /** Direct mode (e.g. OpenCode plugin): bypass transcript_path lookup. */
  last_user_message?: string;
  stop_hook_active?: boolean;
  session_id?: string;
}

/** Read the last real user message from a JSONL transcript file.
 *  Only reads the last 500KB to avoid loading huge files into memory. */
function readLastUserMessage(transcriptPath: string): string | null {
  if (!fs.existsSync(transcriptPath)) return null;

  const stat = fs.statSync(transcriptPath);
  const TAIL_BYTES = 5 * 1024 * 1024; // 5MB — large tool outputs can push user messages far back
  const start = Math.max(0, stat.size - TAIL_BYTES);

  const fd = fs.openSync(transcriptPath, "r");
  const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);

  const content = buf.toString("utf8");
  // If we started mid-file, skip the first (likely partial) line
  const lines = start > 0 ? content.substring(content.indexOf("\n") + 1).split("\n") : content.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (
        entry.type === "user" &&
        entry.message?.role === "user" &&
        !entry.toolUseResult &&
        !entry.isCompactSummary &&
        !entry.isVisibleInTranscriptOnly
      ) {
        const msg = entry.message.content;
        if (typeof msg === "string") return msg;
        if (Array.isArray(msg)) {
          return msg.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        }
      }
    } catch { continue; }
  }
  return null;
}

/** Read the last assistant message from the transcript (fallback when hook input lacks it). */
function readLastAssistantMessage(transcriptPath: string): string | null {
  if (!fs.existsSync(transcriptPath)) return null;

  const stat = fs.statSync(transcriptPath);
  const TAIL_BYTES = 2 * 1024 * 1024;
  const start = Math.max(0, stat.size - TAIL_BYTES);

  const fd = fs.openSync(transcriptPath, "r");
  const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);

  const content = buf.toString("utf8");
  const lines = start > 0 ? content.substring(content.indexOf("\n") + 1).split("\n") : content.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant" && entry.message?.role === "assistant") {
        const msg = entry.message.content;
        if (typeof msg === "string") return msg;
        if (Array.isArray(msg)) {
          const text = msg.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
          if (text) return text;
        }
      }
    } catch { continue; }
  }
  return null;
}

/** Auto-extract a short title from text (first line, max 80 chars). */
function extractTitle(text: string): string {
  const firstLine = text.split("\n")[0].trim().replace(/[<>\[\]]/g, "");
  if (firstLine.length <= 80) return firstLine;
  const lastSpace = firstLine.substring(0, 80).lastIndexOf(" ");
  return (lastSpace > 40 ? firstLine.substring(0, lastSpace) : firstLine.substring(0, 80));
}

export async function logExchange(): Promise<void> {
  // Read hook JSON from stdin synchronously (hook pipes JSON in one shot).
  // When invoked from a TTY (manual run), sync-reading fd 0 blocks forever — bail out.
  if (process.stdin.isTTY) process.exit(0);
  let input: HookInput;
  try {
    const data = fs.readFileSync(0, "utf8"); // fd 0 = stdin
    input = JSON.parse(data || "{}");
  } catch {
    process.exit(0);
  }

  // Resolve env defaults (HMEM_PATH, HMEM_PROJECT_DIR)
  resolveEnvDefaults();

  // Guards
  if (input.stop_hook_active) process.exit(0);
  if (process.env.HMEM_NO_SESSION === "1") process.exit(0);

  const directMode = !!input.last_user_message;
  if (!directMode && !input.transcript_path) process.exit(0);

  // Fallback: if last_assistant_message is missing (e.g. channel sessions),
  // read it from the transcript
  if (!input.last_assistant_message && input.transcript_path) {
    input.last_assistant_message = readLastAssistantMessage(input.transcript_path) || "";
  }
  if (!input.last_assistant_message) process.exit(0);

  // Skip subagent sessions — their transcripts are in /tmp/claude-* task directories
  // and contain MCP tool calls, not real user conversation
  if (input.transcript_path && input.transcript_path.includes("/tasks/")) process.exit(0);

  const userMessage = directMode
    ? input.last_user_message!
    : readLastUserMessage(input.transcript_path!);
  if (!userMessage) process.exit(0);

  // Skip empty exchanges and internal hook prompts
  if (userMessage.length < 2) process.exit(0);
  if (userMessage.startsWith("Generate a concise one-line title")) process.exit(0);

  // Open hmem store
  const projectDir = process.env.HMEM_PROJECT_DIR;
  if (!projectDir) process.exit(0);

  const hmemPath = process.env.HMEM_PATH!;
  if (!fs.existsSync(hmemPath)) process.exit(0);

  const hmemConfig = loadHmemConfig(path.dirname(hmemPath));

  let store: HmemStore;
  try {
    store = new HmemStore(hmemPath, hmemConfig);
  } catch (e) {
    // DB locked (Windows WAL locking) or other open failure → queue for later
    const pendingPath = path.join(path.dirname(hmemPath), "pending-exchanges.jsonl");
    const entry = {
      ts: new Date().toISOString(),
      userMessage,
      agentMessage: input.last_assistant_message,
      transcriptPath: input.transcript_path,
    };
    fs.appendFileSync(pendingPath, JSON.stringify(entry) + "\n");
    console.error(`[hmem log-exchange] DB locked, queued to ${pendingPath}: ${e}`);
    process.exit(0);
  }

  try {
    // Process any previously queued exchanges first
    store.processPendingExchanges();

    // Auto-purge irrelevant entries older than 30 days (~1% chance)
    if (Math.random() < 0.01) {
      const purged = store.purgeIrrelevant(30);
      if (purged > 0) console.error(`[hmem] purged ${purged} irrelevant entries`);
    }

    // Step 1: Resolve project O-entry (per-session)
    const claudeSessionId = input.session_id;
    const marker = claudeSessionId ? readSessionMarker(claudeSessionId) : null;
    const markerSource: "session-marker" | "db-fallback" | "none" =
      marker ? "session-marker" : (claudeSessionId ? "db-fallback" : "none");

    const activeProject = store.getActiveProject(claudeSessionId);
    const projectSeq = activeProject ? parseInt(activeProject.id.replace(/\D/g, ""), 10) : 0;
    const oId = store.resolveProjectO(projectSeq);

    // Loud warnings on fallback / drift
    if (!activeProject) {
      console.error(`[hmem] WARNING: no active project for session ${claudeSessionId ?? "(none)"}, writing to O0000`);
    }
    if (markerSource === "db-fallback") {
      console.error(`[hmem] WARNING: session ${claudeSessionId} has no marker file, using legacy DB flag`);
    }
    if (marker && marker.hmemPath && marker.hmemPath !== hmemPath) {
      console.error(`[hmem] DRIFT: marker hmemPath=${marker.hmemPath} resolved=${hmemPath}`);
    }

    // Step 2: Resolve session (transcript_path tracking, or session_id in direct mode)
    //         — internal DB session row keyed by a stable per-conversation identifier
    const sessionKey = input.transcript_path || `direct:${claudeSessionId ?? "global"}`;
    const internalSessionId = store.resolveSession(oId, sessionKey);

    // Step 3: Resolve batch (create new if full)
    const batchSize = hmemConfig.checkpointInterval || 5;
    const batchId = store.resolveBatch(internalSessionId, oId, batchSize);

    // Diagnostics entry
    writeDiagnostic({
      op: "log-exchange",
      sessionId: claudeSessionId,
      hmemPath,
      activeProjectId: activeProject?.id ?? null,
      oId,
      batchId,
      markerSource,
      warning: !activeProject ? "no-active-project-O0000" : undefined,
    });

    // Step 4: Append exchange (L4 + L5.1 user + L5.2 agent)
    store.appendExchangeV2(batchId, oId, userMessage, input.last_assistant_message!);

    // Step 5: Trigger checkpoint if batch just became full
    const checkpointMode = hmemConfig.checkpointMode;
    if (batchSize > 0) {
      const exchangeCount = store.countBatchExchanges(batchId);

      if (exchangeCount >= batchSize) {
        if (checkpointMode === "auto") {
          const child = spawn(process.execPath, [HMEM_BIN, "checkpoint"], {
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              HMEM_PROJECT_DIR: projectDir,
              HMEM_PATH: process.env.HMEM_PATH,
              ...(claudeSessionId ? { HMEM_SESSION_ID: claudeSessionId } : {}),
              ...(activeProject ? { HMEM_ACTIVE_PROJECT: activeProject.id } : {}),
            },
          });
          child.unref();
        } else {
          const nudge = {
            decision: "block",
            reason: `Batch ${batchId} ist voll (${exchangeCount} exchanges). Schreibe wichtige Erkenntnisse in den Speicher (write_memory). Aktueller Batch: ${batchId}`,
          };
          process.stdout.write(JSON.stringify(nudge));
        }
      }
    }

  } catch (e) {
    console.error(`[hmem log-exchange] ${e}`);
  } finally {
    store.close();
  }
}

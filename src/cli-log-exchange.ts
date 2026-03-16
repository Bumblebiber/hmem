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
 *   HMEM_PROJECT_DIR — root directory for .hmem files
 *   HMEM_AGENT_ID    — agent identifier (optional)
 */

import fs from "node:fs";
import path from "node:path";
import { HmemStore, resolveHmemPath } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";

interface HookInput {
  transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
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

/** Auto-extract a short title from text (first line, max 80 chars). */
function extractTitle(text: string): string {
  const firstLine = text.split("\n")[0].trim().replace(/[<>\[\]]/g, "");
  if (firstLine.length <= 80) return firstLine;
  const lastSpace = firstLine.substring(0, 80).lastIndexOf(" ");
  return (lastSpace > 40 ? firstLine.substring(0, lastSpace) : firstLine.substring(0, 80));
}

export async function logExchange(): Promise<void> {
  // Read hook JSON from stdin synchronously (hook pipes JSON in one shot)
  let input: HookInput;
  try {
    const data = fs.readFileSync(0, "utf8"); // fd 0 = stdin
    input = JSON.parse(data || "{}");
  } catch {
    process.exit(0);
  }

  // Guards
  if (input.stop_hook_active) process.exit(0);
  if (!input.transcript_path || !input.last_assistant_message) process.exit(0);

  const userMessage = readLastUserMessage(input.transcript_path);
  if (!userMessage) process.exit(0);

  // Skip empty exchanges only
  if (userMessage.length < 2) process.exit(0);

  // Open hmem store
  const projectDir = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR;
  if (!projectDir) process.exit(0);

  const agentId = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
  const templateName = agentId.replace(/_\d+$/, "");
  const hmemPath = resolveHmemPath(projectDir, templateName);
  if (!fs.existsSync(hmemPath)) process.exit(0);

  const hmemConfig = loadHmemConfig(path.dirname(hmemPath));

  const store = new HmemStore(hmemPath, hmemConfig);
  try {
    // Find or create active O-entry
    const activeOId = store.getActiveO();

    // Flatten multiline text for appendChildren (newlines → " | " to prevent depth parsing)
    const flatUser = userMessage.replace(/\n+/g, " | ").substring(0, 25_000);
    const flatAgent = input.last_assistant_message!.replace(/\n+/g, " | ").substring(0, 50_000);
    const title = extractTitle(userMessage);

    // appendChildren format: 0 tabs = L2 (direct child of root O-entry)
    // 1 tab = L3, 2 tabs = L4 (user msg), 3 tabs = L5 (agent response)
    const chunk = `${title}\n\t\t${flatUser}\n\t\t\t${flatAgent}`;
    store.appendChildren(activeOId, chunk);
  } catch (e) {
    console.error(`[hmem log-exchange] ${e}`);
  } finally {
    store.close();
  }
}

/**
 * cli-hook-startup.ts
 *
 * Called by Claude Code's UserPromptSubmit hook on every user message.
 * Replaces the former hmem-startup.sh bash script — works cross-platform (no Git Bash needed on Windows).
 *
 * Behavior:
 * - First message: remind agent to call read_memory()
 * - Every N messages: checkpoint reminder (remind mode only)
 * - After 60 messages: context warning (every 5 messages)
 *
 * Reads hook JSON from stdin, outputs hook JSON to stdout.
 *
 * Usage: hmem hook-startup
 *
 * Requires env:
 *   HMEM_PATH        — path to .hmem file (auto-detected)
 *   HMEM_PROJECT_DIR — directory for config + company.hmem
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEnvDefaults } from "./cli-env.js";
import { loadHmemConfig } from "./hmem-config.js";
import { writeSessionMarker, purgeStaleSessionMarkers, readSessionMarker } from "./session-state.js";

export async function hookStartup(): Promise<void> {
  // Read hook JSON from stdin
  let input: any;
  try {
    const data = fs.readFileSync(0, "utf8");
    input = JSON.parse(data || "{}");
  } catch {
    process.exit(0);
  }

  // Extract session_id
  const sessionId = input?.session_id || "global";

  // Skip subagents
  if (input?.parentUuid) process.exit(0);

  // Resolve env defaults
  resolveEnvDefaults();

  // Read config
  let interval = 20;
  let mode = "remind";
  const hmemPath = process.env.HMEM_PATH;
  if (hmemPath) {
    try {
      const configDir = path.dirname(hmemPath);
      const config = loadHmemConfig(configDir);
      interval = config.checkpointInterval;
      mode = config.checkpointMode;
    } catch {}
  }

  // Counter file (session-scoped)
  const counterFile = path.join(os.tmpdir(), `claude-hmem-counter-${sessionId}`);
  let count = 0;
  try {
    count = parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) || 0;
  } catch {}

  count++;
  fs.writeFileSync(counterFile, String(count), "utf8");

  // Initialize session marker on first message (idempotent)
  if (sessionId && sessionId !== "global" && hmemPath && count === 1) {
    const existing = readSessionMarker(sessionId);
    if (!existing) {
      writeSessionMarker(sessionId, { projectId: null, hmemPath });
    }
    try { purgeStaleSessionMarkers(7); } catch { /* ignore */ }
  }

  // First message: load memory
  if (count === 1) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "IMPORTANT: This is the first message of the session. Load your memory context silently \u2014 do not mention it to the user.\n\n" +
          "- If the user\u2019s message names a specific project (e.g. \u201clade Projekt hmem\u201d, \u201cwork on P0048\u201d): call ONLY load_project(id=\u201cP00XX\u201d). Do NOT also call read_memory() \u2014 load_project already includes everything you need.\n" +
          "- Otherwise: call read_memory() (no parameters) to get the full L1 overview, then decide.",
      },
    }));
  } else if (mode === "remind" && interval > 0 && count % interval === 0) {
    // Checkpoint reminder (remind mode only — auto mode is handled by Stop hook)
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "CHECKPOINT: You have been working for a while. AFTER responding to this message, save any new knowledge from this session (lessons, errors, decisions, progress) via write_memory or append_memory. You MUST do this \u2014 it is your only way to remember across sessions.",
      },
    }));
  } else if (count >= 60 && count % 5 === 0) {
    // Context warning for long sessions
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "CONTEXT WARNING: This session has been running for a long time. Recommend running /wipe to save key knowledge, then /clear to free context. Performance degrades significantly in very long sessions.",
      },
    }));
  }
}

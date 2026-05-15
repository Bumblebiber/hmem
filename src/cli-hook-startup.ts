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
import { writeSessionMarker, purgeStaleSessionMarkers, readSessionMarker, writePpidMapping, getParentPid, getActiveDevice } from "./session-state.js";

function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function detectsProjectIntent(prompt: unknown): boolean {
  if (typeof prompt !== "string" || !prompt) return false;
  if (/\bP\d{4}\b/i.test(prompt)) return true;
  const p = prompt.toLowerCase();
  return /\b(lade\s+projekt|load\s+project|aktiviere\s+(?:projekt\s+)?\S|wechsel\s+(?:zu|auf)|switch\s+to\s+project|work\s+on\s+p\d|open\s+project)\b/.test(p);
}

function buildSyncStatus(): string {
  const configPath = path.join(os.homedir(), ".hmem", "config.json");
  if (!fs.existsSync(configPath)) return "";
  let cfg: any;
  try { cfg = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return ""; }

  const server = cfg.server || "https://hmem-sync.io";
  const linked = !!(cfg.session_token || cfg.api_key);
  const activeFile = cfg.active_file;

  if (!linked) {
    return "\n\n--- hmem-sync ---\n✗ Not linked — writes stay local. Run `hmem-sync login` to enable cross-device sync.";
  }
  if (!activeFile) {
    return `\n\n--- hmem-sync ---\n⚠ Authenticated to ${server} but no active file. Run \`hmem-sync setup\` to link one.`;
  }
  const fileCfg = cfg.files?.[activeFile];
  if (!fileCfg?.last_sync) {
    return `\n\n--- hmem-sync ---\n⚠ Linked to ${server} (active_file: ${activeFile}) but never synced. Run \`hmem-sync pull\` to fetch.`;
  }
  const ago = formatAgo(Date.now() - new Date(fileCfg.last_sync).getTime());
  return `\n\n--- hmem-sync ---\n✓ Linked to ${server} | active_file: ${activeFile} | last sync: ${ago} — writes propagate to other devices on next \`hmem-sync push\`.`;
}

export async function hookStartup(): Promise<void> {
  // Read hook JSON from stdin. When invoked from a TTY (manual run),
  // sync-reading fd 0 blocks forever — bail out.
  if (process.stdin.isTTY) process.exit(0);
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

  // Initialize session marker on first message, refresh PPID bridge on every message
  if (sessionId && sessionId !== "global" && hmemPath) {
    if (count === 1) {
      const existing = readSessionMarker(sessionId);
      if (!existing) {
        writeSessionMarker(sessionId, { projectId: null, hmemPath });
      }
      try { purgeStaleSessionMarkers(7); } catch { /* ignore */ }
    }
    // Bridge for MCP server: map Claude Code's PID → our session id
    // Written on EVERY message — PPID changes when MCP server is reconnected.
    // When hooks run via "bash -c" (Claude Code → bash → hook), process.ppid is
    // the bash PID, not Claude Code's PID. Write bridges for BOTH the direct parent
    // AND the grandparent so the MCP server (a direct child of Claude Code) finds it.
    if (typeof process.ppid === "number" && process.ppid > 0) {
      writePpidMapping(process.ppid, sessionId, hmemPath); // bash PID (or Claude Code if direct)
      const grandparentPid = getParentPid(process.ppid);
      if (grandparentPid && grandparentPid > 1) {
        writePpidMapping(grandparentPid, sessionId, hmemPath); // Claude Code PID
      }
    }
  }

  // First message: load memory + H-entries + recent projects + device check
  if (count === 1) {
    // Pull latest from hmem-sync BEFORE reading local SQLite, so greeting and
    // project list reflect entries written on other devices since the last
    // session. Bounded to 3s — if the pull is slow or the server is unreachable,
    // fall back to stale local data rather than blocking the hook timeout.
    if (hmemPath) {
      try {
        const { syncPull } = await import("./mcp-shared.js");
        await Promise.race([
          syncPull(hmemPath).catch(() => undefined),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 3000);
            t.unref();
          }),
        ]);
      } catch { /* sync module unavailable or pull rejected — proceed offline */ }
    }

    const deviceId = getActiveDevice();
    const deviceNote = deviceId
      ? ""
      : "\n\nIMPORTANT: No active device is set for this machine. After loading memory, identify which device you are on (check hostname, hardware specs, or location), find the matching I-entry via read_memory() or search_memory(), then call set_active_device(id='I00XX'). Do this silently alongside the memory load.";

    let humanContext = "";
    let recentProjects = "";
    if (hmemPath) {
      try {
        const Database = (await import("better-sqlite3")).default;
        const db = new (Database as any)(hmemPath, { readonly: true });
        try {
          const hRows = db.prepare(
            "SELECT id, title, level_1 FROM memories WHERE prefix='H' AND obsolete!=1 ORDER BY access_count DESC LIMIT 10"
          ).all() as Array<{ id: string; title: string; level_1: string }>;
          if (hRows.length > 0) {
            humanContext = "\n\n--- Human context (H-entries) ---\n" +
              hRows.map((r) => {
                const raw = r.title || r.level_1 || "";
                return `${r.id}  ${raw.split("\n")[0]}`;
              }).join("\n");
          }

          if (deviceId) {
            // Device is known: inject Apps list for this machine only
            const appsNode = db.prepare(
              "SELECT id FROM memory_nodes WHERE root_id=? AND depth=2 AND title='Apps' AND (irrelevant IS NULL OR irrelevant!=1) LIMIT 1"
            ).get(deviceId) as { id: string } | undefined;
            if (appsNode) {
              const l3Rows = db.prepare(
                "SELECT title FROM memory_nodes WHERE parent_id=? AND depth=3 AND (irrelevant IS NULL OR irrelevant!=1) ORDER BY seq"
              ).all(appsNode.id) as Array<{ title: string }>;
              if (l3Rows.length > 0) {
                humanContext += `\n\n--- Active device (${deviceId}) Apps ---\n` +
                  l3Rows.map(r => `  - ${r.title ?? ""}`).join("\n");
              }
            }
          } else {
            // Device unknown: list known I-entries so agent can identify this machine
            const iRows = db.prepare(
              "SELECT id, title FROM memories WHERE prefix='I' AND obsolete!=1 ORDER BY id"
            ).all() as Array<{ id: string; title: string }>;
            if (iRows.length > 0) {
              humanContext += "\n\n--- Known devices (identify this machine) ---\n" +
                iRows.map(r => `${r.id}  ${r.title ?? ""}`).join("\n");
            }
          }

          const iFavRows = db.prepare(
            "SELECT id, title FROM memories WHERE prefix='I' AND favorite=1 AND obsolete!=1 AND (irrelevant IS NULL OR irrelevant!=1) ORDER BY id"
          ).all() as Array<{ id: string; title: string }>;
          if (iFavRows.length > 0) {
            humanContext += "\n\n--- Infrastructure (favorites) ---\n" +
              iFavRows.map(r => `${r.id}  ${r.title ?? ""}`).join("\n");
          }

          const pRows = db.prepare(
            "SELECT id, title FROM memories WHERE prefix='P' AND obsolete!=1 ORDER BY updated_at DESC LIMIT 5"
          ).all() as Array<{ id: string; title: string }>;
          if (pRows.length > 0) {
            recentProjects = "\n\n--- Recent projects ---\n" +
              pRows.map((r: { id: string; title: string }) => `${r.id}  ${r.title ?? ""}`).join("\n");
          }

          // Checkpoint status: count unsummarized sessions in active project's O-entry
          const activeP = db.prepare(
            "SELECT id FROM memories WHERE prefix='P' AND active=1 AND obsolete!=1 LIMIT 1"
          ).get() as { id: string } | undefined;
          if (activeP) {
            const seq = parseInt(activeP.id.replace(/\D/g, ""), 10);
            const oId = `O${String(seq).padStart(4, "0")}`;
            const unsummarized = db.prepare(
              `SELECT COUNT(*) as cnt FROM memory_nodes
               WHERE root_id=? AND depth=2
               AND (content IS NULL OR content = title)
               AND (irrelevant IS NULL OR irrelevant != 1)`
            ).get(oId) as { cnt: number } | undefined;
            if (unsummarized && unsummarized.cnt > 0) {
              recentProjects += `\n\n--- Checkpoint status ---\n${unsummarized.cnt} session(s) in ${oId} without summary. Run \`hmem checkpoint\` or wait for auto-checkpoint.`;
            }
          }
        } finally {
          db.close();
        }
      } catch { /* ignore */ }
    }

    const syncStatus = buildSyncStatus();
    const hasIntent = detectsProjectIntent(input?.prompt);

    const greetingDirective =
      "IMPORTANT: This is the first message of the session.\n\n" +
      "STEP 1 (silent \u2014 no output yet): Load context.\n" +
      "  - If the user\u2019s message names a specific project (e.g. \u201clade Projekt hmem\u201d, \u201cwork on P0048\u201d): call ONLY load_project(id=\u201cP00XX\u201d). Do NOT also call read_memory().\n" +
      "  - Otherwise: call read_memory() (no parameters).\n\n" +
      "STEP 2: Open your reply with a short greeting in the user\u2019s preferred language and name (infer both from the H-entries below \u2014 e.g. German + \u201cBen\u201d). One line, friendly, no padding. Include the sync state as a colored dot read from the `--- hmem-sync ---` block below:\n" +
      "  - `\u2713 Linked \u2026` \u2192 \ud83d\udfe2\n" +
      "  - `\u26a0 \u2026` \u2192 \ud83d\udfe1\n" +
      "  - `\u2717 Not linked` \u2192 \ud83d\udd34\n" +
      "  - No block present \u2192 omit the dot.\n" +
      (hasIntent
        ? "  The user already named a project \u2014 proceed straight to the task after the greeting line.\n"
        : "  The user did NOT name a project. After the greeting, list the 5 entries from `--- Recent projects ---` below as bullet points and ask which one to continue with.\n") +
      "\nSTEP 3: Handle the user\u2019s actual message (or, if step 2 ended with a question, wait for their answer).";

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: greetingDirective +
          deviceNote +
          humanContext +
          recentProjects +
          syncStatus,
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

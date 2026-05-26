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
import { loadHmemConfig, type HmemConfig } from "./hmem-config.js";
import { writeSessionMarker, purgeStaleSessionMarkers, readSessionMarker, writePpidMapping, getParentPid, getActiveDevice } from "./session-state.js";
import { createV2Store } from "./v2/store-facade.js";
import { getSchemaMajor, V1FileError } from "./store/db.js";
import type { EntryRow, NodeRow } from "./store/types.js";

export const TIP_BLOCK = `
--- Tip ---
Type \`! hmem help\` for quick tips and command reference.
`;

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
  if (!fs.existsSync(configPath)) {
    return "\n\n--- hmem-sync ---\n✗ Not configured on this device — memories stay local, no cross-device sync. Run `hmem-sync login` then `hmem-sync setup` to enable.";
  }
  let cfg: any;
  try { cfg = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {
    return "\n\n--- hmem-sync ---\n✗ Config file unreadable — sync inactive. Check ~/.hmem/config.json.";
  }

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

/**
 * Testable core: open the v2 store at `hmemPath` and build the two session-start
 * context fragments the UserPromptSubmit hook injects on the first message:
 *
 *   `humanContext`   — Human context (H-entries) + Active-device Apps (or known
 *                      devices) + Infrastructure (favorites)
 *   `recentProjects` — Recent projects + Checkpoint status
 *
 * These are returned as separate strings so the caller can interleave them with
 * the greeting directive / device note / sync status exactly as v1 did.
 *
 * v2 model: reads the v2 `entries` / `nodes` / `sessions` tables. There is NO
 * v1-style `memories` / `memory_nodes` table and NO `active` column — "active
 * project" is the open `session_bindings` segment for `sessionId` (mirrors
 * `cli-context-inject.ts`). When the file is not a schema_major=2 store
 * (defensive — should never happen after the v1→v2 cutover) `wrote` is `false`
 * and both fragments are empty.
 *
 * Note: `createV2Store` opens the DB read-write (FTS triggers require it), so the
 * literal v1 `{ readonly: true }` cannot be honoured via the facade — but this
 * function performs NO writes, preserving the read-only *intent*. Performs no
 * stdin/env side-effects, so it is safe to call from tests against a temp DB.
 */
export function buildHookStartupContextV2(
  hmemPath: string,
  config: HmemConfig,
  opts: { deviceId?: string | null; sessionId?: string | null } = {},
): { wrote: boolean; schemaMajor: string | null; humanContext: string; recentProjects: string } {
  let store: ReturnType<typeof createV2Store>;
  try {
    store = createV2Store(hmemPath, config);
  } catch (e) {
    // A v1 file (openDb throws V1FileError) → no-op with the empty "not v2" contract;
    // the SessionStart hook must never crash the harness for an un-migrated user.
    if (e instanceof V1FileError) return { wrote: false, schemaMajor: "1", humanContext: "", recentProjects: "" };
    throw e;
  }
  try {
    const schemaMajor = getSchemaMajor(store.db);
    if (schemaMajor !== "2") return { wrote: false, schemaMajor, humanContext: "", recentProjects: "" };

    const deviceId = opts.deviceId ?? null;
    const sessionId = opts.sessionId ?? null;
    const oneLine = (s: string | null | undefined) => store.entries.renderRefs(s ?? "").split("\n")[0];

    let humanContext = "";
    let recentProjects = "";

    // ── Human context (H-entries) ── pinned first, then most-accessed. Pinned
    // entries also expand their direct child bullets (v1 behaviour).
    const hRows = store.db.prepare(
      `SELECT uid, label, level_1, pinned FROM entries
        WHERE prefix='H' AND deleted_at IS NULL AND obsolete=0 AND irrelevant=0
        ORDER BY pinned DESC, access_count DESC LIMIT 10`,
    ).all() as Array<Pick<EntryRow, "uid" | "label" | "level_1" | "pinned">>;
    if (hRows.length > 0) {
      const childStmt = store.db.prepare(
        `SELECT content FROM nodes
          WHERE root_uid=? AND parent_uid IS NULL AND deleted_at IS NULL ORDER BY seq`,
      );
      const lines: string[] = [];
      for (const r of hRows) {
        lines.push(`${r.label}  ${oneLine(r.level_1)}`);
        if (r.pinned) {
          const children = childStmt.all(r.uid) as Array<Pick<NodeRow, "content">>;
          for (const n of children) {
            const text = oneLine(n.content);
            if (text) lines.push(`  • ${text}`);
          }
        }
      }
      humanContext = "\n\n--- Human context (H-entries) ---\n" + lines.join("\n");
    }

    if (deviceId) {
      // Device known: inject the Apps list for this machine only.
      const dUid = store.entries.labelToUid(deviceId);
      if (dUid) {
        const appsNode = store.db.prepare(
          `SELECT uid FROM nodes
            WHERE root_uid=? AND parent_uid IS NULL AND content='Apps' AND deleted_at IS NULL
            ORDER BY seq LIMIT 1`,
        ).get(dUid) as { uid: string } | undefined;
        if (appsNode) {
          const apps = store.db.prepare(
            `SELECT content FROM nodes
              WHERE root_uid=? AND parent_uid=? AND deleted_at IS NULL ORDER BY seq`,
          ).all(dUid, appsNode.uid) as Array<Pick<NodeRow, "content">>;
          if (apps.length > 0) {
            humanContext += `\n\n--- Active device (${deviceId}) Apps ---\n` +
              apps.map(n => `  - ${oneLine(n.content)}`).join("\n");
          }
        }
      }
    } else {
      // Device unknown: list known I-entries so the agent can identify this machine.
      const iRows = store.db.prepare(
        `SELECT label, level_1 FROM entries
          WHERE prefix='I' AND deleted_at IS NULL AND obsolete=0 AND irrelevant=0
          ORDER BY seq`,
      ).all() as Array<Pick<EntryRow, "label" | "level_1">>;
      if (iRows.length > 0) {
        humanContext += "\n\n--- Known devices (identify this machine) ---\n" +
          iRows.map(r => `${r.label}  ${oneLine(r.level_1)}`).join("\n");
      }
    }

    // ── Infrastructure (favorites) ── favorite I-entries.
    const iFavRows = store.db.prepare(
      `SELECT label, level_1 FROM entries
        WHERE prefix='I' AND favorite=1 AND deleted_at IS NULL AND obsolete=0 AND irrelevant=0
        ORDER BY seq`,
    ).all() as Array<Pick<EntryRow, "label" | "level_1">>;
    if (iFavRows.length > 0) {
      humanContext += "\n\n--- Infrastructure (favorites) ---\n" +
        iFavRows.map(r => `${r.label}  ${oneLine(r.level_1)}`).join("\n");
    }

    // ── Recent projects ── 5 most recently edited P-entries (recency stands in
    // for the dropped v1 `active` flag).
    const pRows = store.db.prepare(
      `SELECT label, level_1 FROM entries
        WHERE prefix='P' AND deleted_at IS NULL AND obsolete=0 AND irrelevant=0
        ORDER BY updated_at DESC LIMIT 5`,
    ).all() as Array<Pick<EntryRow, "label" | "level_1">>;
    if (pRows.length > 0) {
      recentProjects = "\n\n--- Recent projects ---\n" +
        pRows.map(r => `${r.label}  ${oneLine(r.level_1)}`).join("\n");
    }

    // ── Checkpoint status ── v2 equivalent of v1's "N sessions in O00xx without
    // summary": sessions bound to the active project (the open binding segment
    // for this session) that still have no rolling summary. NOTE: when this hook
    // fires (before load_project binds a project) `currentProject` is usually
    // null, so this block is empty in practice — see report.
    if (sessionId) {
      const activeUid = store.sessions.currentProject(sessionId);
      if (activeUid) {
        const label = store.entries.uidToLabel(activeUid) ?? activeUid;
        const row = store.db.prepare(
          `SELECT COUNT(DISTINCT s.session_id) AS cnt
             FROM sessions s JOIN session_bindings b ON b.session_id = s.session_id
            WHERE b.project_uid = ? AND (s.summary IS NULL OR s.summary = '')`,
        ).get(activeUid) as { cnt: number } | undefined;
        if (row && row.cnt > 0) {
          recentProjects += `\n\n--- Checkpoint status ---\n${row.cnt} session(s) bound to ${label} without summary. Run \`hmem checkpoint\` or wait for auto-checkpoint.`;
        }
      }
    }

    return { wrote: true, schemaMajor, humanContext, recentProjects };
  } finally {
    store.close();
  }
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
        let cfg;
        try { cfg = loadHmemConfig(path.dirname(hmemPath)); } catch { cfg = undefined; }
        if (cfg) {
          const ctx = buildHookStartupContextV2(hmemPath, cfg, { deviceId, sessionId });
          humanContext = ctx.humanContext;
          recentProjects = ctx.recentProjects;
        }
      } catch { /* swallow — never block the user's prompt on a read failure */ }
    }

    const syncStatus = buildSyncStatus();
    const hasIntent = detectsProjectIntent(input?.prompt);

    const greetingDirective = hasIntent
      ? "Session start. User named a project \u2014 call `load_project` for it, then invoke the `o9k-session-start` skill before responding."
      : "Session start. User did not name a project. Invoke the `o9k-session-start` skill \u2014 it will list recent projects below and ask which to continue with.";

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: greetingDirective +
          deviceNote +
          humanContext +
          recentProjects +
          syncStatus +
          TIP_BLOCK,
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
        additionalContext: "CONTEXT WARNING: This session has been running for a long time. Recommend running /o9k-handoff to save key knowledge, then /clear to free context. Performance degrades significantly in very long sessions.",
      },
    }));
  }
}

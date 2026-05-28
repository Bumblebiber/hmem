/**
 * cli-v2-checkpoint.ts
 *
 * Async Stop-hook entry point for the v2 checkpoint pipeline.
 * Opens a v2 store exclusively — never touches HmemStore or any v1 path.
 *
 * On a v1 file, a missing/unreadable file, or a missing HMEM_PATH env:
 *   → silent no-op return (never throws, never constructs HmemStore).
 *
 * On a v2 file with a resolvable session:
 *   → runs one checkpoint-extraction pass (see ./v2/checkpoint.ts).
 *
 * Usage (hook): claude pipes `{ session_id, stop_hook_active }` on stdin.
 *
 * Requires env:
 *   HMEM_PATH        — path to .hmem file (the hook sets this explicitly)
 *   HMEM_PROJECT_DIR — directory for config + company.hmem (derived from
 *                      HMEM_PATH by resolveEnvDefaults — the hook does NOT set it)
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createV2Store } from "./v2/store-facade.js";
import { getSchemaMajor, V1FileError } from "./store/db.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveSessionId } from "./v2/session-id.js";
import { resolveEnvDefaults } from "./cli-env.js";
import { runV2Checkpoint, type RunV2CheckpointOptions } from "./v2/checkpoint.js";

/**
 * Read-only schema-major probe. Returns '2' only when the file exists and
 * carries schema_major='2'. Any other case — v1 file, missing file, locked
 * handle, corrupt header — returns null. Never throws.
 *
 * Uses a readonly better-sqlite3 handle so openDb's WAL pragma and schema
 * bootstrap are NEVER run against the file (symmetric to the probe in
 * cli-checkpoint.ts#isV2Store, but returns the raw major string instead of
 * a boolean so callers can distinguish v1 vs. absent).
 */
function probeSchemaMajor(hmemPath: string): string | null {
  let db: Database.Database | undefined;
  try {
    db = new Database(hmemPath, { readonly: true });
    return getSchemaMajor(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

interface StopHookInput {
  /** Claude Code passes the session id in the Stop-hook JSON on stdin. */
  session_id?: string;
  /** Set when Claude re-fires the Stop hook for its own continuation. */
  stop_hook_active?: boolean;
}

/**
 * Hook entry point (dispatched by cli.ts). Reads the Stop-hook JSON from stdin to
 * obtain the session id — Claude Code provides it there, NOT in the environment —
 * mirroring cli-log-exchange.ts. A TTY (manual run) has no hook payload, so stdin
 * is skipped and the core falls back to env/ppid session resolution.
 */
export async function runCliV2Checkpoint(): Promise<void> {
  let input: StopHookInput = {};
  if (!process.stdin.isTTY) {
    try {
      input = JSON.parse(fs.readFileSync(0, "utf8") || "{}") as StopHookInput;
    } catch {
      // No / invalid stdin payload — core falls back to resolveSessionId().
    }
  }
  // Re-entry guard: Claude re-fires Stop with this flag set; don't double-run.
  if (input.stop_hook_active) return;
  await runCliV2CheckpointCore(input.session_id);
}

/**
 * Testable core: resolve env, guard, open the v2 store, run one checkpoint pass.
 * Kept separate from the stdin-reading wrapper so tests can drive it directly
 * (same split as cli-log-exchange.ts's appendExchangeV2Path).
 *
 * @param sessionId explicit session id (from the hook stdin). Falls back to
 *                  resolveSessionId() (HMEM_SESSION_ID env → ppid bridge) when omitted.
 * @param opts      test seams (agent `invoke`, gate/agent probes) forwarded to
 *                  runV2Checkpoint. The production hook passes none → real spawn.
 */
export async function runCliV2CheckpointCore(
  sessionId?: string,
  opts: RunV2CheckpointOptions = {},
): Promise<void> {
  // 1. HMEM_PATH guard FIRST — the hook sets it explicitly. Guarding before
  //    resolveEnvDefaults() preserves the "unset → no-op" contract and stops the
  //    HMEM_PATH auto-resolver from reaching a real store.
  if (!process.env.HMEM_PATH) return;

  // 2. Derive HMEM_PROJECT_DIR from HMEM_PATH. The Stop hook sets only HMEM_PATH;
  //    without this the original code early-returned into a silent no-op, and
  //    downstream config/agent wiring (which reads HMEM_PROJECT_DIR) would break.
  resolveEnvDefaults();

  const hmemPath = process.env.HMEM_PATH;
  if (!fs.existsSync(hmemPath)) return;

  // 3. Read-only schema probe BEFORE opening anything heavy.
  //    Not v2 (v1 file, empty file, missing schema_version) → no-op.
  //    This is the primary guard; the V1FileError catch below is belt-and-suspenders.
  const schemaMajor = probeSchemaMajor(hmemPath);
  if (schemaMajor !== "2") {
    return;
  }

  // 4. Open via createV2Store exclusively (never HmemStore).
  const config = loadHmemConfig(path.dirname(hmemPath));
  let store: ReturnType<typeof createV2Store> | undefined;
  try {
    try {
      store = createV2Store(hmemPath, config);
    } catch (e) {
      // Belt-and-suspenders: if the probe is bypassed and the file turns out
      // to be v1, openDb throws V1FileError — swallow it into a no-op.
      if (e instanceof V1FileError) return;
      throw e;
    }

    // Real extraction pass. With no resolvable session, or a session with no open
    // binding, runV2Checkpoint is a clean no-op.
    const sid = sessionId ?? resolveSessionId();
    if (sid) {
      await runV2Checkpoint(store, sid, config, hmemPath, opts);
    }

  } finally {
    try { store?.close(); } catch { /* ignore */ }
  }
}

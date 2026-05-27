/**
 * cli-v2-checkpoint.ts
 *
 * Guard-only scaffold for the v2 checkpoint pipeline (Chunk 5).
 * Opens a v2 store exclusively — never touches HmemStore or any v1 path.
 *
 * On a v1 file, a missing/unreadable file, or a missing HMEM_PATH env:
 *   → silent no-op return (never throws, never constructs HmemStore).
 *
 * On a v2 file:
 *   → opens via createV2Store, then exits (extraction logic lands in Chunk 6).
 *
 * Usage: hmem v2-checkpoint
 *
 * Requires env:
 *   HMEM_PATH        — path to .hmem file (auto-detected)
 *   HMEM_PROJECT_DIR — directory for config + company.hmem
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createV2Store } from "./v2/store-facade.js";
import { getSchemaMajor, V1FileError } from "./store/db.js";
import { loadHmemConfig } from "./hmem-config.js";

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

export async function runV2Checkpoint(): Promise<void> {
  // 1. Env guard — same pattern as cli-log-exchange.ts
  const projectDir = process.env.HMEM_PROJECT_DIR;
  if (!projectDir) return;

  const hmemPath = process.env.HMEM_PATH;
  if (!hmemPath) return;
  if (!fs.existsSync(hmemPath)) return;

  // 2. Read-only schema probe BEFORE opening anything heavy.
  //    Not v2 (v1 file, empty file, missing schema_version) → no-op.
  //    This is the primary guard; the V1FileError catch below is belt-and-suspenders.
  const schemaMajor = probeSchemaMajor(hmemPath);
  if (schemaMajor !== "2") {
    return;
  }

  // 3. Open via createV2Store exclusively (never HmemStore).
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

    // TODO(chunk6): runV2Checkpoint(store, config) — extraction core lands here.

  } finally {
    try { store?.close(); } catch { /* ignore */ }
  }
}

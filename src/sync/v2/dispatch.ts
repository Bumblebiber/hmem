import Database from 'better-sqlite3';
import { getSchemaMajor } from '../../store/db.js';

export type SyncLane = 'v1' | 'v2';
export function syncLaneFor(db: Database.Database): SyncLane {
  return getSchemaMajor(db) === '2' ? 'v2' : 'v1';
}

/** Open the file READ-ONLY (never via openDb — that would stamp schema_major='2' and corrupt a
 *  v1 file) and decide the sync lane. Returns 'v1' if the file is missing/unreadable. */
export function syncLaneForPath(hmemPath: string): SyncLane {
  let db: Database.Database | undefined;
  try {
    db = new Database(hmemPath, { readonly: true });
    return syncLaneFor(db);
  } catch {
    return 'v1';
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * hmem v2 — full-text search over the SEPARATE contentless events index.
 *
 * Events are ~75% of the store, so they get their own `events_fts` index (created
 * by the Phase-2 migration in `db.ts`) rather than polluting the curated `fts`.
 * Events are immutable, so the index only ever gains rows (AFTER-INSERT trigger) —
 * there is no update/delete path to mirror. `events_fts_map` maps each FTS rowid
 * back to the source `event_uid`, exactly as `fts_rowid_map` does for entries/nodes.
 *
 * MATCH expressions reuse `fts.ts`'s `toMatchExpr`, which quotes every term so
 * arbitrary user input cannot inject FTS5 syntax.
 */
import type Database from 'better-sqlite3';
import type { EventRow } from './types.js';
import { toMatchExpr } from './fts.js';

export interface EventsFtsApi {
  searchEvents(query: string, limit?: number): EventRow[];
}

export function createEventsFtsApi(db: Database.Database): EventsFtsApi {
  const stmt = db.prepare(
    `SELECT e.* FROM events_fts
       JOIN events_fts_map m ON m.fts_rowid = events_fts.rowid
       JOIN events e ON e.event_uid = m.event_uid
      WHERE events_fts MATCH ?
      ORDER BY e.session_id, e.seq
      LIMIT ?`,
  );

  return {
    searchEvents(query, limit = 50) {
      const expr = toMatchExpr(query);
      if (!expr) return [];
      return stmt.all(expr, limit) as EventRow[];
    },
  };
}

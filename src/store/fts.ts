/**
 * hmem v2 — full-text search over the contentless FTS5 index (L0095 pattern).
 *
 * The `fts` virtual table stores no content; triggers (see schema-v2.sql) keep it
 * in sync and `fts_rowid_map` maps each FTS rowid back to a source `(root_uid,
 * node_uid)`. node_uid IS NULL ⇒ the hit is an entry's own level_1; otherwise it
 * is a node's content. Soft-deleted rows stay indexed (soft-delete is a column
 * update, not a row DELETE), so they are filtered out here at query time.
 */
import type Database from 'better-sqlite3';

export interface SearchHit {
  root_uid: string;
  node_uid: string | null;
}

export interface FtsApi {
  search(query: string, limit?: number): SearchHit[];
}

/**
 * Build a safe FTS5 MATCH expression: each whitespace-separated term becomes a
 * quoted phrase (internal double-quotes doubled), joined by spaces → implicit AND.
 * Quoting neutralizes FTS5 operators so arbitrary user input cannot inject syntax.
 */
export function toMatchExpr(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return terms.length ? terms.join(' ') : null;
}

export function createFtsApi(db: Database.Database): FtsApi {
  const stmt = db.prepare(
    `SELECT m.root_uid AS root_uid, m.node_uid AS node_uid
       FROM fts
       JOIN fts_rowid_map m ON m.fts_rowid = fts.rowid
       LEFT JOIN entries e ON e.uid = m.root_uid
       LEFT JOIN nodes   n ON n.uid = m.node_uid
      WHERE fts MATCH ?
        AND (
          (m.node_uid IS NULL     AND e.deleted_at IS NULL) OR
          (m.node_uid IS NOT NULL AND n.deleted_at IS NULL)
        )
      LIMIT ?`,
  );

  return {
    search(query, limit = 50) {
      const expr = toMatchExpr(query);
      if (!expr) return [];
      return stmt.all(expr, limit) as SearchHit[];
    },
  };
}

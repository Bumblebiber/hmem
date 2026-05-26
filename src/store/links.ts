/**
 * hmem v2 — links table (typed cross-references by ULID).
 *
 * Replaces both v1's JSON `links` column and in-prose ID references. Edges are
 * stored by `uid`, so renaming a label never touches a link row (master-plan
 * Goal #1: retire the deep-rename subsystem).
 *
 * `resolveRefs` is the write-time complement to `entries.renderRefs`: it scans
 * free text for label-shaped tokens that resolve to a *live* entry and rewrites
 * them to `{{u:<uid>}}` so the stored form is rename-stable. Unknown labels are
 * left verbatim. Node-path refs (`P0048.2.1`) are out of scope for Phase 1 —
 * only root-entry labels are encoded.
 */
import type Database from 'better-sqlite3';
import type { EntriesApi } from './entries.js';
import type { LinkRow } from './types.js';

const LABEL_TOKEN = /\b[A-Z]{1,2}\d{4}\b/g;

export interface LinksApi {
  addLink(src_uid: string, dst_uid: string, kind?: string): void;
  getLinks(src_uid: string): LinkRow[];
  getBacklinks(dst_uid: string): LinkRow[];
  removeLink(src_uid: string, dst_uid: string): boolean;
  resolveRefs(text: string): string;
}

export function createLinksApi(db: Database.Database, entries: EntriesApi): LinksApi {
  const upsert = db.prepare(
    `INSERT INTO links (src_uid, dst_uid, kind) VALUES (?, ?, ?)
     ON CONFLICT(src_uid, dst_uid) DO UPDATE SET kind = excluded.kind`,
  );
  const selBySrc = db.prepare('SELECT * FROM links WHERE src_uid = ?');
  const selByDst = db.prepare('SELECT * FROM links WHERE dst_uid = ?');
  const del = db.prepare('DELETE FROM links WHERE src_uid = ? AND dst_uid = ?');

  return {
    addLink(src_uid, dst_uid, kind) {
      upsert.run(src_uid, dst_uid, kind ?? null);
    },
    getLinks(src_uid) {
      return selBySrc.all(src_uid) as LinkRow[];
    },
    getBacklinks(dst_uid) {
      return selByDst.all(dst_uid) as LinkRow[];
    },
    removeLink(src_uid, dst_uid) {
      return del.run(src_uid, dst_uid).changes > 0;
    },
    resolveRefs(text) {
      return text.replace(LABEL_TOKEN, (m) => {
        const uid = entries.labelToUid(m);
        return uid ? `{{u:${uid}}}` : m;
      });
    },
  };
}

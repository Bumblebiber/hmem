import type { V2Store } from './store-facade.js';
import { resolveAddress } from './addressing.js';
import type { EntryRow } from '../store/types.js';

function rewriteTags(json: string | null, fn: (tags: string[]) => string[]): string | null {
  let tags: string[] = [];
  if (json) {
    try {
      const t = JSON.parse(json);
      if (Array.isArray(t)) tags = t;
    } catch { /* ignore */ }
  }
  const next = fn(tags);
  return next.length ? JSON.stringify(next) : null;
}

export function tagRename(store: V2Store, oldTag: string, newTag: string): number {
  return store.db.transaction(() => {
    let count = 0;
    for (const table of ['entries', 'nodes'] as const) {
      const rows = store.db
        .prepare(`SELECT rowid, tags FROM ${table} WHERE tags LIKE ?`)
        .all(`%${oldTag}%`) as { rowid: number; tags: string | null }[];
      for (const r of rows) {
        const next = rewriteTags(r.tags, ts => ts.map(t => (t === oldTag ? newTag : t)));
        if (next !== r.tags) {
          store.db.prepare(`UPDATE ${table} SET tags=? WHERE rowid=?`).run(next, r.rowid);
          count++;
        }
      }
    }
    return count;
  })();
}

export function tagBulk(
  store: V2Store,
  filter: { prefix?: string },
  add: string[] = [],
  remove: string[] = [],
): number {
  const where = filter.prefix ? 'prefix=? AND deleted_at IS NULL' : 'deleted_at IS NULL';
  const args = filter.prefix ? [filter.prefix] : [];
  return store.db.transaction(() => {
    const rows = store.db
      .prepare(`SELECT uid, tags FROM entries WHERE ${where}`)
      .all(...args) as { uid: string; tags: string | null }[];
    let count = 0;
    for (const r of rows) {
      const next = rewriteTags(r.tags, ts => {
        const set = new Set(ts.filter(t => !remove.includes(t)));
        for (const a of add) set.add(a);
        return [...set];
      });
      if (next !== r.tags) {
        store.db.prepare('UPDATE entries SET tags=? WHERE uid=?').run(next, r.uid);
        count++;
      }
    }
    return count;
  })();
}

export interface MemStats {
  total: number;
  byPrefix: Record<string, number>;
  nodes: number;
}

export function memoryStats(store: V2Store): MemStats {
  const total = (
    store.db
      .prepare('SELECT COUNT(*) c FROM entries WHERE deleted_at IS NULL')
      .get() as { c: number }
  ).c;
  const nodes = (
    store.db
      .prepare('SELECT COUNT(*) c FROM nodes WHERE deleted_at IS NULL')
      .get() as { c: number }
  ).c;
  const rows = store.db
    .prepare(
      'SELECT prefix, COUNT(*) c FROM entries WHERE deleted_at IS NULL GROUP BY prefix',
    )
    .all() as { prefix: string; c: number }[];
  const byPrefix: Record<string, number> = {};
  for (const r of rows) byPrefix[r.prefix] = r.c;
  return { total, byPrefix, nodes };
}

export interface HealthReport {
  brokenLinks: { src: string; dst: string }[];
  orphanNodes: number;
}

export function memoryHealth(store: V2Store): HealthReport {
  const brokenLinks = store.db
    .prepare(
      `SELECT src_uid src, dst_uid dst FROM links
        WHERE dst_uid NOT IN (SELECT uid FROM entries WHERE deleted_at IS NULL)
          AND dst_uid NOT IN (SELECT uid FROM nodes WHERE deleted_at IS NULL)`,
    )
    .all() as { src: string; dst: string }[];
  const orphanNodes = (
    store.db
      .prepare(
        `SELECT COUNT(*) c FROM nodes
          WHERE deleted_at IS NULL
            AND root_uid NOT IN (SELECT uid FROM entries WHERE deleted_at IS NULL)`,
      )
      .get() as { c: number }
  ).c;
  return { brokenLinks, orphanNodes };
}

export function deleteEntryOrNode(store: V2Store, address: string): boolean {
  const addr = resolveAddress(store, address);
  if (!addr) return false;
  return addr.node_uid
    ? store.entries.softDelete(addr.node_uid)
    : store.entries.softDelete(addr.root_uid);
}

export function renameId(store: V2Store, address: string, newLabel: string): boolean {
  const addr = resolveAddress(store, address);
  if (!addr || addr.node_uid) return false; // only root entries are relabelable
  return store.entries.relabel(addr.root_uid, newLabel);
}

export function reparentNode(
  store: V2Store,
  sourceAddr: string,
  targetAddr: string,
): boolean {
  const src = resolveAddress(store, sourceAddr);
  const tgt = resolveAddress(store, targetAddr);
  if (!src?.node_uid || !tgt) return false;
  // NOTE: if the moved node has its own children they keep the OLD root_uid.
  // Single-level reparent is sufficient for Phase 4; deep subtree moves are out of scope.
  const newParent = tgt.node_uid; // null → direct child of target root entry
  const newRoot = tgt.root_uid;
  store.db
    .prepare('UPDATE nodes SET parent_uid=?, root_uid=? WHERE uid=?')
    .run(newParent, newRoot, src.node_uid);
  return true;
}

export function exportMarkdown(store: V2Store): string {
  const rows = store.db
    .prepare(
      'SELECT label, level_1 FROM entries WHERE deleted_at IS NULL ORDER BY prefix, seq',
    )
    .all() as Pick<EntryRow, 'label' | 'level_1'>[];
  return rows.map(r => `## ${r.label}\n${r.level_1}`).join('\n\n');
}

import type { V2Store } from './store-facade.js';

export interface Address {
  root_uid: string;
  node_uid: string | null;
}

const LABEL_RE = /^([A-Z]+\d{1,})(?:\.(\d+(?:\.\d+)*))?$/;

/** Resolve 'P0048' or 'P0048.2.1' to { root_uid, node_uid }. null if not found. */
export function resolveAddress(store: V2Store, address: string): Address | null {
  const m = LABEL_RE.exec(address.trim());
  if (!m) return null;
  const rootUid = store.entries.labelToUid(m[1]);
  if (!rootUid) return null;
  if (!m[2]) return { root_uid: rootUid, node_uid: null };

  const segs = m[2].split('.').map(n => parseInt(n, 10));
  let parentUid: string | null = null;
  let nodeUid: string | null = null;
  for (const seq of segs) {
    const row = (parentUid === null
      ? store.db.prepare(
          `SELECT uid FROM nodes
            WHERE root_uid = ? AND parent_uid IS NULL
              AND seq = ? AND deleted_at IS NULL`,
        ).get(rootUid, seq)
      : store.db.prepare(
          `SELECT uid FROM nodes
            WHERE root_uid = ? AND parent_uid = ?
              AND seq = ? AND deleted_at IS NULL`,
        ).get(rootUid, parentUid, seq)) as { uid: string } | undefined;
    if (!row) return null;
    nodeUid = row.uid;
    parentUid = row.uid;
  }
  return { root_uid: rootUid, node_uid: nodeUid };
}

/** Rebuild 'P0048.2.1' for a node uid by walking the parent chain and collecting seq values. */
export function nodePathOf(store: V2Store, nodeUid: string): string | null {
  const node = store.entries.getNode(nodeUid);
  if (!node) return null;
  const parts: number[] = [];
  let cur = node;
  while (cur) {
    parts.unshift(cur.seq);
    if (!cur.parent_uid) break;
    const p = store.entries.getNode(cur.parent_uid);
    if (!p) break;
    cur = p;
  }
  const label = store.entries.uidToLabel(node.root_uid);
  if (!label) return null;
  return `${label}.${parts.join('.')}`;
}

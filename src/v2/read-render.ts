import type { V2Store } from './store-facade.js';
import { resolveAddress } from './addressing.js';
import type { NodeRow } from '../store/types.js';

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function childrenOf(store: V2Store, rootUid: string, parentUid: string | null): NodeRow[] {
  if (parentUid === null) {
    return store.db.prepare(
      `SELECT * FROM nodes
        WHERE root_uid = ? AND parent_uid IS NULL
          AND deleted_at IS NULL ORDER BY seq`,
    ).all(rootUid) as NodeRow[];
  }
  return store.db.prepare(
    `SELECT * FROM nodes
      WHERE root_uid = ? AND parent_uid = ?
        AND deleted_at IS NULL ORDER BY seq`,
  ).all(rootUid, parentUid) as NodeRow[];
}

function renderChildren(
  store: V2Store,
  rootUid: string,
  parentUid: string | null,
  depth: number,
  indent: number,
  maxNode: number,
  out: string[],
): void {
  if (depth <= 1) return; // depth counts levels of children to show
  for (const n of childrenOf(store, rootUid, parentUid)) {
    out.push(
      '  '.repeat(indent) + '• ' + cap(store.entries.renderRefs(n.content).split('\n')[0], maxNode),
    );
    renderChildren(store, rootUid, n.uid, depth - 1, indent + 1, maxNode, out);
  }
}

/** Render an entry or node subtree as the read_memory({id}) handler emits it. */
export function renderEntryTree(store: V2Store, address: string, depth = 2): string {
  const addr = resolveAddress(store, address);
  if (!addr) return `‹${address} not found›`;
  const maxNode = store.config.maxNodeChars ?? 600;
  const out: string[] = [];
  if (addr.node_uid === null) {
    const e = store.entries.getEntry(addr.root_uid);
    if (!e) return `‹${address} not found›`;
    out.push(`${e.label}  ${cap(store.entries.renderRefs(e.level_1), maxNode)}`);
    renderChildren(store, addr.root_uid, null, depth, 1, maxNode, out);
  } else {
    const n = store.entries.getNode(addr.node_uid);
    if (!n) return `‹${address} not found›`;
    out.push(cap(store.entries.renderRefs(n.content), maxNode));
    renderChildren(store, addr.root_uid, n.uid, depth, 1, maxNode, out);
  }
  return out.join('\n');
}

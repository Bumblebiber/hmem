import type { V2Store } from './store-facade.js';
import { resolveAddress } from './addressing.js';
import type { NodeRow, EntryRow } from '../store/types.js';

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** A section whose first title word is "History" or "Protocol" — a chronological
 *  log that grows unbounded. Capped to config.historyLimit in broad reads. */
function isHistorySection(content: string): boolean {
  const first = content.toLowerCase().split(/[\s—:-]/)[0]?.trim();
  return first === 'history' || first === 'protocol';
}

function childrenOf(store: V2Store, rootUid: string, parentUid: string | null, showAll = false): NodeRow[] {
  // Default reads hide irrelevant [-] nodes; show_all (curation/review) bypasses.
  const irr = showAll ? '' : ' AND irrelevant = 0';
  if (parentUid === null) {
    return store.db.prepare(
      `SELECT * FROM nodes
        WHERE root_uid = ? AND parent_uid IS NULL
          AND deleted_at IS NULL${irr} ORDER BY seq`,
    ).all(rootUid) as NodeRow[];
  }
  return store.db.prepare(
    `SELECT * FROM nodes
      WHERE root_uid = ? AND parent_uid = ?
        AND deleted_at IS NULL${irr} ORDER BY seq`,
  ).all(rootUid, parentUid) as NodeRow[];
}

function renderChildren(
  store: V2Store,
  rootUid: string,
  parentUid: string | null,
  depth: number,
  indent: number,
  maxNode: number,
  historyLimit: number,
  showAll: boolean,
  out: string[],
  limit?: number,
): void {
  if (depth <= 1) return; // depth counts levels of children to show
  let children = childrenOf(store, rootUid, parentUid, showAll);
  // `limit` caps THIS level's children (set when descending into a History
  // section): keep the most recent (highest seqs = tail) and collapse the rest.
  if (limit !== undefined && children.length > limit) {
    out.push('  '.repeat(indent) + `… [+${children.length - limit} older]`);
    children = limit === 0 ? [] : children.slice(-limit);
  }
  for (const n of children) {
    out.push(
      '  '.repeat(indent) + '.' + n.seq + ' ' + cap(store.entries.renderRefs(n.content).split('\n')[0], maxNode),
    );
    const childLimit = isHistorySection(n.content) ? historyLimit : undefined;
    renderChildren(store, rootUid, n.uid, depth - 1, indent + 1, maxNode, historyLimit, showAll, out, childLimit);
  }
}

/**
 * Render an entry or node subtree as the read_memory({id}) handler emits it.
 *
 * `depth` counts **levels of children** to show, not total levels:
 * - `depth=1` → entry header only (no children rendered)
 * - `depth=2` → direct children shown, grandchildren suppressed
 * - `depth>=3` → grandchildren shown, and so on
 *
 * Pass `depth >= 2` to show any children at all.
 */
export function renderEntryTree(store: V2Store, address: string, depth = 2, showAll = false): string {
  const addr = resolveAddress(store, address);
  if (!addr) return `‹${address} not found›`;
  const maxNode = store.config.maxNodeChars ?? 600;
  const historyLimit = store.config.historyLimit ?? 8;
  const out: string[] = [];
  if (addr.node_uid === null) {
    const e = store.entries.getEntry(addr.root_uid);
    if (!e) return `‹${address} not found›`;
    out.push(`${e.label}  ${cap(store.entries.renderRefs(e.level_1), maxNode)}`);
    renderChildren(store, addr.root_uid, null, depth, 1, maxNode, historyLimit, showAll, out);
  } else {
    // Drilling directly into a node renders its children uncapped — even a
    // History node: the caller explicitly asked for the full log.
    const n = store.entries.getNode(addr.node_uid);
    if (!n) return `‹${address} not found›`;
    out.push(`${address}  ${cap(store.entries.renderRefs(n.content), maxNode)}`);
    renderChildren(store, addr.root_uid, n.uid, depth, 1, maxNode, historyLimit, showAll, out);
  }
  return out.join('\n');
}

// ── readBulk ──────────────────────────────────────────────────────────────────

export interface ReadBulkOpts {
  prefix?: string;
  after?: string;
  before?: string;
  limit?: number;
  why?: boolean;
  titlesOnly?: boolean;
  tag?: string;
}

export interface WhyRow {
  label: string;
  shown: 'expanded' | 'title';
  reason: string;
}

export interface ReadBulkResult {
  text: string;
  why?: WhyRow[];
}

export function readBulk(store: V2Store, opts: ReadBulkOpts = {}): ReadBulkResult {
  const where: string[] = ['deleted_at IS NULL', 'irrelevant = 0'];
  const args: unknown[] = [];
  if (opts.prefix) { where.push('prefix = ?'); args.push(opts.prefix); }
  if (opts.after)  { where.push('created_at >= ?'); args.push(opts.after); }
  if (opts.before) { where.push('created_at <= ?'); args.push(opts.before); }
  if (opts.tag)    { where.push('tags LIKE ?'); args.push(`%"${opts.tag}"%`); }

  const sql =
    `SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, seq DESC` +
    (Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? ` LIMIT ${Math.floor(opts.limit as number)}` : '');

  const rows = store.db.prepare(sql).all(...args) as EntryRow[];

  const topNewest  = store.config.bulkReadV2?.topNewestCount  ?? 5;
  const topObsolete = store.config.bulkReadV2?.topObsoleteCount ?? 3;

  const live     = rows.filter(r => !r.obsolete);
  const obsolete = rows.filter(r =>  r.obsolete).slice(0, topObsolete);

  // Collect the newest-N UIDs per prefix (rows are already DESC by created_at).
  const newestByPrefix = new Map<string, Set<string>>();
  for (const r of live) {
    let set = newestByPrefix.get(r.prefix);
    if (!set) { set = new Set(); newestByPrefix.set(r.prefix, set); }
    if (set.size < topNewest) set.add(r.uid);
  }

  const whyTrace: WhyRow[] = [];
  const out: string[] = [];

  for (const r of live) {
    if (opts.titlesOnly) {
      const maxNode = store.config.maxNodeChars ?? 600;
      out.push(`${r.label}  ${cap(store.entries.renderRefs(r.level_1).split('\n')[0], maxNode)}`);
      whyTrace.push({ label: r.label, shown: 'title', reason: 'titles_only mode' });
      continue;
    }

    const isFav    = !!r.favorite;
    const isPin    = !!r.pinned;
    const isNewest = newestByPrefix.get(r.prefix)?.has(r.uid) ?? false;

    if (isFav || isPin || isNewest) {
      out.push(renderEntryTree(store, r.label, 2));
      whyTrace.push({
        label: r.label,
        shown: 'expanded',
        reason: isPin ? 'pinned' : isFav ? 'favorite' : 'newest-in-prefix',
      });
    } else {
      const maxNode = store.config.maxNodeChars ?? 600;
      out.push(`${r.label}  ${cap(store.entries.renderRefs(r.level_1).split('\n')[0], maxNode)}`);
      whyTrace.push({
        label: r.label,
        shown: 'title',
        reason: 'suppressed: not in newest/favorite/pinned set',
      });
    }
  }

  for (const r of obsolete) {
    const maxNode = store.config.maxNodeChars ?? 600;
    out.push(`[obsolete] ${r.label}  ${cap(store.entries.renderRefs(r.level_1).split('\n')[0], maxNode)}`);
    whyTrace.push({ label: r.label, shown: 'title', reason: 'obsolete (capped)' });
  }

  return opts.why
    ? { text: out.join('\n\n'), why: whyTrace }
    : { text: out.join('\n\n') };
}

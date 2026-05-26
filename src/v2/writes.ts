import type { V2Store } from './store-facade.js';
import { findRelated, type RelatedHit } from './related.js';
import { resolveAddress } from './addressing.js';

export interface WriteInput {
  prefix: string;
  content: string;            // 'level_1\n\tchild\n\t\tgrandchild'
  links?: string[];           // label refs to link
  favorite?: boolean;
  pinned?: boolean;
  tags?: string[];
}
export interface WriteResult { label: string; uid: string; related: RelatedHit[]; }

interface ParsedLine { depth: number; text: string; }

function parseTabbed(content: string): { level_1: string; children: ParsedLine[] } {
  const lines = content.replace(/\r/g, '').split('\n');
  const level_1 = (lines.shift() ?? '').trim();
  const children: ParsedLine[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const depth = (raw.match(/^\t*/)?.[0].length ?? 0) + 1; // tab count → depth offset (1-based child depth)
    children.push({ depth, text: raw.replace(/^\t+/, '').trim() });
  }
  return { level_1, children };
}

export function writeMemory(store: V2Store, input: WriteInput): WriteResult {
  const { level_1, children } = parseTabbed(input.content);
  return store.db.transaction(() => {
    const { uid, label } = store.entries.createEntry({
      prefix: input.prefix,
      level_1: store.links.resolveRefs(level_1),
    });

    const sets: string[] = []; const args: unknown[] = [];
    if (input.tags?.length) { sets.push('tags=?'); args.push(JSON.stringify(input.tags)); }
    if (input.favorite) { sets.push('favorite=1'); }
    if (input.pinned) { sets.push('pinned=1'); }
    if (sets.length) {
      sets.push('updated_at=?'); args.push(new Date().toISOString());
      store.db.prepare(`UPDATE entries SET ${sets.join(',')} WHERE uid=?`).run(...args, uid);
    }

    const stack: { depth: number; uid: string }[] = [];
    for (const c of children) {
      while (stack.length && stack[stack.length - 1].depth >= c.depth) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].uid : undefined;
      const { uid: nUid } = store.entries.addNode({
        root_uid: uid, parent_uid: parent, content: store.links.resolveRefs(c.text), tags: input.tags,
      });
      stack.push({ depth: c.depth, uid: nUid });
    }

    for (const ref of input.links ?? []) {
      const dst = store.entries.labelToUid(ref.split('.')[0]);
      if (dst) store.links.addLink(uid, dst);
    }

    return { uid, label, related: findRelated(store, label, 3) };
  })();
}

export function appendMemory(store: V2Store, address: string, content: string): { count: number } {
  const addr = resolveAddress(store, address);
  if (!addr) return { count: 0 };
  // Re-base: treat the given content as children of the target. Prepend a tab to each
  // line so parseTabbed's depth math nests them one level under the target.
  const { children } = parseTabbed('_root_\n' + content.split('\n').map(l => '\t' + l).join('\n'));
  const baseParent = addr.node_uid; // null → direct child of root
  return store.db.transaction(() => {
    const stack: { depth: number; uid: string }[] = [];
    let count = 0;
    for (const c of children) {
      while (stack.length && stack[stack.length - 1].depth >= c.depth) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].uid : (baseParent ?? undefined);
      const { uid: nUid } = store.entries.addNode({ root_uid: addr.root_uid, parent_uid: parent, content: store.links.resolveRefs(c.text) });
      stack.push({ depth: c.depth, uid: nUid });
      count++;
    }
    store.db.prepare('UPDATE entries SET updated_at=? WHERE uid=?').run(new Date().toISOString(), addr.root_uid);
    return { count };
  })();
}

export interface UpdatePatch {
  content?: string; obsolete?: boolean; favorite?: boolean; irrelevant?: boolean; pinned?: boolean;
  newLabel?: string; delete?: boolean; tags?: string[];
}

export function updateMemory(store: V2Store, address: string, patch: UpdatePatch): boolean {
  const addr = resolveAddress(store, address);
  if (!addr) return false;
  return store.db.transaction(() => {
    if (patch.delete) {
      return addr.node_uid ? store.entries.softDelete(addr.node_uid) : store.entries.softDelete(addr.root_uid);
    }
    // Node addresses support content + tags only; entry-only flags
    // (obsolete/favorite/irrelevant/pinned/newLabel) don't apply to nodes and are ignored.
    if (addr.node_uid) {
      if (patch.content !== undefined) store.entries.updateNodeContent(addr.node_uid, store.links.resolveRefs(patch.content));
      if (patch.tags) store.db.prepare('UPDATE nodes SET tags=?, updated_at=? WHERE uid=?').run(JSON.stringify(patch.tags), new Date().toISOString(), addr.node_uid);
      return true;
    }
    if (patch.newLabel) store.entries.relabel(addr.root_uid, patch.newLabel);
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.content !== undefined) { sets.push('level_1=?'); args.push(store.links.resolveRefs(patch.content)); }
    if (patch.obsolete !== undefined) { sets.push('obsolete=?'); args.push(patch.obsolete ? 1 : 0); }
    if (patch.favorite !== undefined) { sets.push('favorite=?'); args.push(patch.favorite ? 1 : 0); }
    if (patch.irrelevant !== undefined) { sets.push('irrelevant=?'); args.push(patch.irrelevant ? 1 : 0); }
    if (patch.pinned !== undefined) { sets.push('pinned=?'); args.push(patch.pinned ? 1 : 0); }
    if (patch.tags) { sets.push('tags=?'); args.push(JSON.stringify(patch.tags)); }
    if (sets.length) {
      sets.push('updated_at=?'); args.push(new Date().toISOString());
      store.db.prepare(`UPDATE entries SET ${sets.join(',')} WHERE uid=?`).run(...args, addr.root_uid);
    }
    return true;
  })();
}

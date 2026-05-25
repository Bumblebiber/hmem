import type { V2Store } from './store-facade.js';
import { findRelated, type RelatedHit } from './related.js';

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
  const { uid, label } = store.entries.createEntry({
    prefix: input.prefix,
    level_1: store.links.resolveRefs(level_1),
  });

  const sets: string[] = []; const args: unknown[] = [];
  if (input.tags?.length) { sets.push('tags=?'); args.push(JSON.stringify(input.tags)); }
  if (input.favorite) { sets.push('favorite=1'); }
  if (input.pinned) { sets.push('pinned=1'); }
  if (sets.length) { store.db.prepare(`UPDATE entries SET ${sets.join(',')} WHERE uid=?`).run(...args, uid); }

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
}

import type { V2Store } from './store-facade.js';
import type { EntryRow } from '../store/types.js';

export interface RelatedHit { label: string; level_1: string; overlap: number; via: 'link' | 'tag'; }

function tagsOf(row: { tags: string | null }): string[] {
  if (!row.tags) return [];
  try { const t = JSON.parse(row.tags); return Array.isArray(t) ? t : []; } catch { return []; }
}

export function findRelated(store: V2Store, address: string, limit = 5): RelatedHit[] {
  const uid = store.entries.labelToUid(address.split('.')[0]);
  if (!uid) return [];
  const self = store.entries.getEntry(uid);
  if (!self) return [];
  const myTags = new Set(tagsOf(self));

  const linked = new Set(store.links.getLinks(uid).map(l => l.dst_uid));
  const all = store.db.prepare(
    'SELECT * FROM entries WHERE deleted_at IS NULL AND irrelevant = 0 AND uid != ?'
  ).all(uid) as EntryRow[];

  const hits: RelatedHit[] = [];
  for (const r of all) {
    if (linked.has(r.uid)) { hits.push({ label: r.label, level_1: r.level_1.split('\n')[0], overlap: 999, via: 'link' }); continue; }
    const overlap = tagsOf(r).filter(t => myTags.has(t)).length;
    if (overlap > 0) hits.push({ label: r.label, level_1: r.level_1.split('\n')[0], overlap, via: 'tag' });
  }
  hits.sort((a, b) => b.overlap - a.overlap || a.label.localeCompare(b.label));
  return hits.slice(0, limit);
}

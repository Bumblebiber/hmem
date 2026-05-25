import type { V2Store } from './store-facade.js';

export interface SearchOpts { scope?: 'memory' | 'events'; max?: number; }

export function searchMemory(store: V2Store, query: string, opts: SearchOpts = {}): string {
  const max = opts.max && opts.max > 0 ? opts.max : 20;
  if (opts.scope === 'events') {
    const hits = store.eventsFts.searchEvents(query, max);
    if (!hits.length) return 'No matches in events.';
    return hits.map(e => `[${e.session_id}#${e.seq}] ${e.role}: ${e.content.split('\n')[0].slice(0, 200)}`).join('\n');
  }
  const hits = store.fts.search(query, max);
  if (!hits.length) return 'No results.';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const h of hits) {
    const label = store.entries.uidToLabel(h.root_uid);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const e = store.entries.getEntry(h.root_uid);
    lines.push(`${label}  ${e ? store.entries.renderRefs(e.level_1).split('\n')[0] : ''}`);
  }
  return lines.join('\n');
}

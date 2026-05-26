import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { findRelated } from '../../src/v2/related.js';

describe('findRelated', () => {
  it('returns entries sharing a tag, ranked by overlap count', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'L', level_1: 'A' });
    const b = s.entries.createEntry({ prefix: 'L', level_1: 'B' });
    const c = s.entries.createEntry({ prefix: 'L', level_1: 'C' });
    s.db.prepare('UPDATE entries SET tags=? WHERE uid=?').run(JSON.stringify(['#x', '#y']), a.uid);
    s.db.prepare('UPDATE entries SET tags=? WHERE uid=?').run(JSON.stringify(['#x', '#y']), b.uid); // overlap 2
    s.db.prepare('UPDATE entries SET tags=? WHERE uid=?').run(JSON.stringify(['#x']), c.uid);        // overlap 1
    const res = findRelated(s, a.label, 5);
    expect(res.map(r => r.label)).toEqual([b.label, c.label]);
    s.close();
  });

  it('returns [] for an unknown entry', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    expect(findRelated(s, 'P9999', 5)).toEqual([]);
    s.close();
  });
});

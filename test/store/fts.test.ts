import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createEntriesApi } from '../../src/store/entries.js';
import { createFtsApi } from '../../src/store/fts.js';

function setup() {
  const db = openDb(':memory:');
  const e = createEntriesApi(db);
  return { e, f: createFtsApi(db) };
}

describe('fts', () => {
  it('finds entries by title and nodes by content', () => {
    const { e, f } = setup();
    const p = e.createEntry({ prefix: 'P', level_1: 'kangaroo migration plan' });
    e.addNode({ root_uid: p.uid, content: 'platypus storage detail' });
    expect(f.search('kangaroo').some((r) => r.root_uid === p.uid && r.node_uid === null)).toBe(true);
    expect(f.search('platypus').some((r) => r.node_uid !== null)).toBe(true);
    expect(f.search('kangaroo zebra')).toHaveLength(0); // implicit AND across one fts row
  });

  it('excludes soft-deleted entries and their nodes', () => {
    const { e, f } = setup();
    const p = e.createEntry({ prefix: 'P', level_1: 'wombat' });
    e.addNode({ root_uid: p.uid, content: 'wombat burrow' });
    expect(f.search('wombat').length).toBeGreaterThan(0);
    e.softDelete(p.uid);
    expect(f.search('wombat')).toHaveLength(0);
  });

  it('reflects content updates (trigger re-index)', () => {
    const { e, f } = setup();
    const p = e.createEntry({ prefix: 'P', level_1: 'r' });
    const n = e.addNode({ root_uid: p.uid, content: 'aardvark' });
    expect(f.search('aardvark')).toHaveLength(1);
    e.updateNodeContent(n.uid, 'beaver');
    expect(f.search('aardvark')).toHaveLength(0);
    expect(f.search('beaver')).toHaveLength(1);
  });

  it('empty query returns nothing and special chars do not throw', () => {
    const { e, f } = setup();
    e.createEntry({ prefix: 'P', level_1: 'normal title' });
    expect(f.search('')).toHaveLength(0);
    expect(f.search('   ')).toHaveLength(0);
    expect(() => f.search('"); DROP TABLE entries; --')).not.toThrow();
  });
});

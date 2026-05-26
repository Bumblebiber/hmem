import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createEntriesApi } from '../../src/store/entries.js';
import { createLinksApi } from '../../src/store/links.js';

function setup() {
  const db = openDb(':memory:');
  const e = createEntriesApi(db);
  return { db, e, l: createLinksApi(db, e) };
}

describe('links', () => {
  it('stores + queries links by uid', () => {
    const { e, l } = setup();
    const a = e.createEntry({ prefix: 'D', level_1: 'a' });
    const b = e.createEntry({ prefix: 'L', level_1: 'b' });
    l.addLink(a.uid, b.uid, 'cites');
    expect(l.getLinks(a.uid).map((x) => x.dst_uid)).toContain(b.uid);
    expect(l.getLinks(a.uid)[0].kind).toBe('cites');
    expect(l.getBacklinks(b.uid).map((x) => x.src_uid)).toContain(a.uid);
  });

  it('addLink is idempotent on (src,dst)', () => {
    const { e, l } = setup();
    const a = e.createEntry({ prefix: 'D', level_1: 'a' });
    const b = e.createEntry({ prefix: 'L', level_1: 'b' });
    l.addLink(a.uid, b.uid);
    l.addLink(a.uid, b.uid, 'updated');
    expect(l.getLinks(a.uid)).toHaveLength(1);
    expect(l.getLinks(a.uid)[0].kind).toBe('updated');
  });

  it('removeLink deletes the edge', () => {
    const { e, l } = setup();
    const a = e.createEntry({ prefix: 'D', level_1: 'a' });
    const b = e.createEntry({ prefix: 'L', level_1: 'b' });
    l.addLink(a.uid, b.uid);
    expect(l.removeLink(a.uid, b.uid)).toBe(true);
    expect(l.getLinks(a.uid)).toHaveLength(0);
  });

  it('resolveRefs encodes live labels, ignores unknowns', () => {
    const { e, l } = setup();
    const p = e.createEntry({ prefix: 'P', level_1: 'r' }); // P0001
    expect(l.resolveRefs('see P0001 not P9999')).toBe(`see {{u:${p.uid}}} not P9999`);
  });

  it('round-trip survives rename with zero stored rewrite', () => {
    const { e, l } = setup();
    const p = e.createEntry({ prefix: 'P', level_1: 'r' });
    const stored = l.resolveRefs('ref P0001');
    expect(e.renderRefs(stored)).toBe('ref P0001');
    e.relabel(p.uid, 'P0099');
    expect(e.renderRefs(stored)).toBe('ref P0099'); // stored string unchanged
  });
});

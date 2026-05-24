import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createEntriesApi } from '../../src/store/entries.js';

const api = () => createEntriesApi(openDb(':memory:'));

describe('entries', () => {
  it('assigns ULID uid + zero-padded per-prefix label', () => {
    const e = api();
    const p1 = e.createEntry({ prefix: 'P', level_1: 'a' });
    expect(p1.label).toBe('P0001');
    expect(p1.uid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(e.createEntry({ prefix: 'E', level_1: 'b' }).label).toBe('E0001');
    expect(e.createEntry({ prefix: 'P', level_1: 'c' }).label).toBe('P0002');
  });

  it('round-trips label↔uid', () => {
    const e = api();
    const { uid, label } = e.createEntry({ prefix: 'L', level_1: 'x' });
    expect(e.labelToUid(label)).toBe(uid);
    expect(e.uidToLabel(uid)).toBe(label);
    expect(e.labelToUid('P9999')).toBeNull();
    expect(e.uidToLabel('NOPE')).toBeNull();
  });

  it('addNode nests by depth and orders siblings', () => {
    const e = api();
    const { uid } = e.createEntry({ prefix: 'P', level_1: 'r' });
    const a = e.addNode({ root_uid: uid, content: 'sec a' });
    const b = e.addNode({ root_uid: uid, content: 'sec b' });
    const sub = e.addNode({ root_uid: uid, parent_uid: a.uid, content: 'sub' });
    expect(e.getNode(a.uid)!.depth).toBe(2);
    expect(e.getNode(a.uid)!.seq).toBe(1);
    expect(e.getNode(b.uid)!.seq).toBe(2);
    expect(e.getNode(sub.uid)!.depth).toBe(3);
    expect(e.getNode(sub.uid)!.seq).toBe(1);
  });

  it('renderRefs reflects current label (rename = zero stored rewrite)', () => {
    const e = api();
    const { uid } = e.createEntry({ prefix: 'P', level_1: 'r' });
    const stored = `see {{u:${uid}}}`;
    expect(e.renderRefs(stored)).toBe('see P0001');
    e.relabel(uid, 'P0042');
    expect(e.renderRefs(stored)).toBe('see P0042'); // identical stored string
  });

  it('renderRefs marks dead refs', () => {
    const e = api();
    expect(e.renderRefs('see {{u:01ARZ3NDEKTSV4RRFFQ69G5FAV}}')).toBe('see ‹dead-ref›');
  });

  it('softDelete hides the entry; seq stays monotonic (deleted labels never resurrect)', () => {
    const e = api();
    const { uid, label } = e.createEntry({ prefix: 'P', level_1: 'r' });
    e.softDelete(uid);
    expect(e.labelToUid(label)).toBeNull();
    expect(e.getEntry(uid)).toBeNull();
    expect(e.uidToLabel(uid)).toBeNull();
    // seq is monotonic over ALL rows: the next P is P0002, not a recycled P0001
    const next = e.createEntry({ prefix: 'P', level_1: 'fresh' });
    expect(next.label).toBe('P0002');
  });
});

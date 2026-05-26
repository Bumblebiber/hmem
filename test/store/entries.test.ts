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

// raw insert bypassing createEntry — lets us seed transient collision shapes
// (a live label-collision can't be made via createEntry; the loser always carries a placeholder).
function seed(db: ReturnType<typeof openDb>, uid: string, prefix: string, seq: number, label: string) {
  db.prepare(
    `INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(uid, label, prefix, seq, `lvl-${uid}`);
}
const U = (n: number) => String(n).padStart(26, '0'); // valid-length pseudo-ULID, lexicographically ordered

describe('resolveLabelCollisions', () => {
  it('pairwise: smaller uid keeps the seq, larger is bumped to next free', () => {
    const db = openDb(':memory:'); const e = createEntriesApi(db);
    seed(db, U(1), 'P', 1, 'P0001');     // winner (smaller uid)
    seed(db, U(2), 'P', 1, U(2));        // loser carries placeholder label (= its uid)
    expect(e.resolveLabelCollisions('P')).toBe(1);
    expect(e.getEntry(U(1))!.label).toBe('P0001');
    expect(e.getEntry(U(2))!.label).toBe('P0002');
    expect(e.getEntry(U(2))!.seq).toBe(2);
  });

  it('is order-independent for a 3-way collision (deterministic by seq,uid)', () => {
    const db = openDb(':memory:'); const e = createEntriesApi(db);
    seed(db, U(1), 'P', 1, 'P0001');
    seed(db, U(3), 'P', 1, U(3));
    seed(db, U(2), 'P', 1, U(2));        // inserted out of uid order on purpose
    e.resolveLabelCollisions('P');
    expect(e.getEntry(U(1))!.label).toBe('P0001');
    expect(e.getEntry(U(2))!.label).toBe('P0002');
    expect(e.getEntry(U(3))!.label).toBe('P0003');
  });

  it('does not displace a legit non-colliding holder', () => {
    const db = openDb(':memory:'); const e = createEntriesApi(db);
    seed(db, U(1), 'P', 1, 'P0001');
    seed(db, U(2), 'P', 1, U(2));        // collides with seq 1
    seed(db, U(3), 'P', 2, 'P0002');     // legit holder of P0002
    e.resolveLabelCollisions('P');
    expect(e.getEntry(U(1))!.label).toBe('P0001'); // kept
    expect(e.getEntry(U(3))!.label).toBe('P0002'); // NOT displaced
    expect(e.getEntry(U(2))!.label).toBe('P0003'); // bumped past the taken seqs
  });

  it('is idempotent — a second run changes nothing', () => {
    const db = openDb(':memory:'); const e = createEntriesApi(db);
    seed(db, U(1), 'P', 1, 'P0001');
    seed(db, U(2), 'P', 1, U(2));
    e.resolveLabelCollisions('P');
    expect(e.resolveLabelCollisions('P')).toBe(0);
  });

  it('ignores soft-deleted rows and other prefixes', () => {
    const db = openDb(':memory:'); const e = createEntriesApi(db);
    seed(db, U(1), 'P', 1, 'P0001');
    seed(db, U(2), 'P', 1, U(2));
    db.prepare(`UPDATE entries SET deleted_at='2026-01-02T00:00:00.000Z' WHERE uid=?`).run(U(2));
    seed(db, U(3), 'E', 1, 'E0001');     // different prefix, untouched
    expect(e.resolveLabelCollisions('P')).toBe(0); // the only live P-row is U(1)
    expect(e.getEntry(U(3))!.label).toBe('E0001');
  });
});

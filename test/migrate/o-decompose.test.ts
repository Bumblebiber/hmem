import { test, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makeV1Fixture } from './fixture.js';
import { migrateTree } from '../../src/migrate/tree.js';
import { decomposeORoots } from '../../src/migrate/o-decompose.js';

function setup() {
  const v1 = makeV1Fixture(); const v2 = openDb(':memory:');
  const maps = migrateTree(v1, v2);
  const res = decomposeORoots(v1, v2, maps);
  return { v1, v2, maps, res };
}

test('normal O-root: chunk -> session bound to its project, exchanges -> events', () => {
  const { v2, maps, res } = setup();
  const pUid = maps.labelToUid.get('P0001')!;
  // O0001 has one chunk -> one session bound to P0001
  const sess = v2.prepare(`SELECT s.* FROM sessions s
    JOIN session_bindings b ON b.session_id=s.session_id
    WHERE b.project_uid=? AND b.to_seq IS NULL`).all(pUid) as any[];
  expect(sess.length).toBeGreaterThanOrEqual(1);
  const s = sess.find(x => x.summary.includes('did X and Y'))!;
  expect(s.started_at).toBe('2026-03-01T10:00:00Z');
  const evs = v2.prepare(`SELECT role,content,seq,ts FROM events WHERE session_id=? ORDER BY seq`).all(s.session_id) as any[];
  expect(evs.map(e => [e.role, e.content])).toEqual([
    ['user', 'user msg 1'], ['assistant', 'assistant msg 1']]);
  expect(evs[0].ts).toBe('2026-03-01T10:00:00Z'); // original v1 node created_at preserved
});

test('O0000: unattributed sessions with no binding; .66 garbage chunk skipped', () => {
  const { v2, res } = setup();
  expect(res.unattributedSessions).toBeGreaterThanOrEqual(1);
  // the orphan event exists
  const ev = v2.prepare(`SELECT * FROM events WHERE content='orphan user msg'`).get() as any;
  expect(ev).toBeTruthy();
  // its session has NO binding
  expect(v2.prepare(`SELECT COUNT(*) c FROM session_bindings WHERE session_id=?`).get(ev.session_id))
    .toMatchObject({ c: 0 });
  // .66 garbage produced no events
  expect(v2.prepare(`SELECT COUNT(*) c FROM events WHERE content LIKE 'xxxx%'`).get())
    .toMatchObject({ c: 0 });
});

test('collision twin O90001 is dropped; empty O0002 yields an event-less session', () => {
  const { v2, res } = setup();
  expect(res.skippedTwins).toContain('O90001');
  expect(v2.prepare(`SELECT COUNT(*) c FROM events WHERE content='dup'`).get()).toMatchObject({ c: 0 });
  expect(res.emptyORoots).toContain('O0002');
});

test('oNodeToLoc maps original O-node ids to their session+seq', () => {
  const { res } = setup();
  expect(res.oNodeToLoc['O0001.1.1.1']).toMatchObject({ seq: expect.any(Number) });
  expect(typeof res.oNodeToLoc['O0001.1.1.1'].session_id).toBe('string');
});

test('summary detection checks content, not just title (rolling-summary in content under a label title)', () => {
  const { v2, maps } = setup();
  const pUid = maps.labelToUid.get('P0001')!;
  const s = (v2.prepare(`SELECT s.summary FROM sessions s
    JOIN session_bindings b ON b.session_id=s.session_id
    WHERE b.project_uid=?`).all(pUid) as any[]).find(x => x.summary.includes('did X and Y'))!;
  expect(s.summary).toBe('Rolling summary: did X and Y'); // content-based, not the 'Session A\n\n...' fallback
});

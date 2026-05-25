/**
 * Phase 2 acceptance — the 6 master-plan scenarios end-to-end.
 *
 * Scenarios 1–5 are exercised per-task (sessions.test.ts, loop.test.ts); this file
 * is the combined end-to-end run plus the explicit Scenario 6 structural guard:
 * attribution is *derived only*, so no API can physically move an event row.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createEntriesApi } from '../../src/store/entries.js';
import { createEventsApi } from '../../src/store/events.js';
import { createSessionsApi } from '../../src/store/sessions.js';
import { createSummarizer } from '../../src/summarize/loop.js';

function setup(cadence = 5) {
  const db = openDb(':memory:');
  const entries = createEntriesApi(db);
  const events = createEventsApi(db);
  const stub = (evs: { seq: number }[]) => 'S:' + evs.map((e) => e.seq).join('-');
  const sum = createSummarizer({ db, entries, events, summarize: stub, cadence });
  const sessions = createSessionsApi(db, { onSegmentClose: sum.flushSegment });
  return {
    db,
    entries,
    events,
    sessions,
    sum,
    pA: entries.createEntry({ prefix: 'P', level_1: 'A' }).uid,
    pB: entries.createEntry({ prefix: 'P', level_1: 'B' }).uid,
  };
}

describe('Phase 2 acceptance', () => {
  it('end-to-end: checkpoint → boundary flush → late switch partitions attribution + materializes summaries', () => {
    const { db, entries, events, sessions, sum, pA, pB } = setup(5);
    sessions.createSession({ session_id: 'S' });

    sessions.bind('S', pA);
    for (let i = 0; i < 20; i++) events.appendEvent({ session_id: 'S', role: 'user', content: 'x' }); // 1..20
    sum.maybeCheckpoint('S'); // summarize 1..20 under pA

    sessions.bind('S', pB); // boundary flush of [1,20] into pA, open [21,NULL] pB
    for (let i = 0; i < 10; i++) events.appendEvent({ session_id: 'S', role: 'user', content: 'x' }); // 21..30

    sessions.bind('S', pA, 26); // late switch: flush [21,25] into pB, open [26,NULL] pA

    // attribution partitions every event, disjointly
    const seqA = events.eventsForProject(pA).map((e) => e.seq);
    const seqB = events.eventsForProject(pB).map((e) => e.seq);
    expect(seqA).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 26, 27, 28, 29, 30]);
    expect(seqB).toEqual([21, 22, 23, 24, 25]);
    expect([...seqA, ...seqB].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );

    // every materialized summary node is live AND under its segment's project
    const rows = db
      .prepare('SELECT session_id, from_seq, node_uid FROM segment_summaries')
      .all() as { session_id: string; from_seq: number; node_uid: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      const node = entries.getNode(r.node_uid);
      expect(node).not.toBeNull();
      const seg = db
        .prepare('SELECT project_uid FROM session_bindings WHERE session_id=? AND from_seq=?')
        .get(r.session_id, r.from_seq) as { project_uid: string };
      expect(node!.root_uid).toBe(seg.project_uid);
    }
  });

  it('scenario 6: no API physically moves event rows (attribution is derived only)', () => {
    const db = openDb(':memory:');
    const evApi = createEventsApi(db) as unknown as Record<string, unknown>;
    // no mutation/reattribution surface on the events API
    expect(evApi.moveEvent ?? evApi.reattribute ?? evApi.setProject).toBeUndefined();
    expect(evApi.updateEvent ?? evApi.deleteEvent).toBeUndefined();
    // the events table carries NO project column — attribution lives only in bindings
    const cols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('project_uid');
    expect(cols.sort()).toEqual(['content', 'event_uid', 'role', 'seq', 'session_id', 'ts']);
  });
});

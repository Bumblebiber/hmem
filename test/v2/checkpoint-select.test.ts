/**
 * Chunk 6a — selectSegmentsForExtraction tests (TDD — written BEFORE the implementation).
 *
 * Fixture strategy: in-memory openDb + low-level APIs + raw SQL for rows the
 * function-under-test reads but no existing API writes (segment_extractions).
 * We also bump sessions.updated_at via raw SQL to make ordering tests
 * non-trivial (the API's touchSession sets updated_at to now() — we need
 * independently-controlled timestamps).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../../src/store/db.js';
import { createSessionsApi } from '../../src/store/sessions.js';
import { createEventsApi } from '../../src/store/events.js';
import { createEntriesApi } from '../../src/store/entries.js';
import { selectSegmentsForExtraction } from '../../src/v2/checkpoint-select.js';

// ── Helper: build a minimal in-memory DB with sessions + entries + events ────

function makeDb() {
  const db = openDb(':memory:');
  const sessions = createSessionsApi(db);
  const events = createEventsApi(db);
  const entries = createEntriesApi(db);
  return { db, sessions, events, entries };
}

/** Force sessions.updated_at to a specific ISO string (bypasses the API). */
function setUpdatedAt(db: Database.Database, session_id: string, ts: string) {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(ts, session_id);
}

/** Insert (or replace) a segment_extractions marker row. */
function setExtracted(
  db: Database.Database,
  session_id: string,
  from_seq: number,
  last_extracted_seq: number,
) {
  db.prepare(
    `INSERT INTO segment_extractions (session_id, from_seq, last_extracted_seq)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id, from_seq) DO UPDATE SET last_extracted_seq = excluded.last_extracted_seq`,
  ).run(session_id, from_seq, last_extracted_seq);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function appendN(events: ReturnType<typeof createEventsApi>, sid: string, n: number) {
  for (let i = 0; i < n; i++) {
    events.appendEvent({ session_id: sid, role: 'user', content: `msg-${i}` });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('selectSegmentsForExtraction — current segment cadence gate', () => {
  it('current segment with unextracted < cadence is NOT selected', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    sessions.createSession({ session_id: 'S1' });
    sessions.bind('S1', p.uid);
    appendN(events, 'S1', 3); // 3 events, cadence = 5 → below threshold

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'S1',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    expect(result).toHaveLength(0);
  });

  it('current segment with unextracted === cadence IS selected (first in result)', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    sessions.createSession({ session_id: 'S1' });
    sessions.bind('S1', p.uid);
    appendN(events, 'S1', 5); // exactly cadence = 5 → eligible

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'S1',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe('S1');
    expect(result[0].toSeqInclusive).toBe(5);
    expect(result[0].fromSeqExclusive).toBe(0); // no marker yet
  });

  it('current segment with unextracted > cadence IS selected', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    sessions.createSession({ session_id: 'S1' });
    sessions.bind('S1', p.uid);
    appendN(events, 'S1', 12); // 12 > cadence 5

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'S1',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe('S1');
    expect(result[0].toSeqInclusive).toBe(12);
  });

  it('current segment with marker: respects last_extracted_seq in unextracted count', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    sessions.createSession({ session_id: 'S1' });
    sessions.bind('S1', p.uid);
    appendN(events, 'S1', 8);
    // Mark 6 as already extracted → only 2 unextracted (8-6=2), below cadence 5
    setExtracted(db, 'S1', 1, 6);

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'S1',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    expect(result).toHaveLength(0);
  });

  it('current segment partial extraction with enough remaining is selected', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    sessions.createSession({ session_id: 'S1' });
    sessions.bind('S1', p.uid);
    appendN(events, 'S1', 12);
    // Mark 3 as extracted → 9 unextracted, above cadence 5
    setExtracted(db, 'S1', 1, 3);

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'S1',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0].fromSeqExclusive).toBe(3);
    expect(result[0].toSeqInclusive).toBe(12);
  });
});

describe('selectSegmentsForExtraction — backlog segments', () => {
  it('backlog segment with unextracted > 0 and NO marker is selected', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });

    // Closed backlog session (different session_id from current)
    sessions.createSession({ session_id: 'SBACK' });
    sessions.bind('SBACK', p.uid);
    appendN(events, 'SBACK', 5);
    // Close it by creating a new binding (bind in same session is the normal close mechanism)
    // Actually, we need to close it; we do this by binding a new project which closes the old
    const p2 = entries.createEntry({ prefix: 'P', level_1: 'Project B' });
    sessions.bind('SBACK', p2.uid); // closes the [1, to_seq] binding

    // Current session (a different one, no events)
    sessions.createSession({ session_id: 'SCURR' });
    sessions.bind('SCURR', p.uid);
    // no events → current segment unextracted = 0, below any cadence

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'SCURR',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    // The closed segment [SBACK, from_seq=1] should be selected (unextracted > 0)
    const backlogSeg = result.find((r) => r.session_id === 'SBACK');
    expect(backlogSeg).toBeDefined();
    expect(backlogSeg!.from_seq).toBe(1);
  });

  it('backlog segment fully extracted (marker covers maxSeq) is NOT selected (idempotent)', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });

    sessions.createSession({ session_id: 'SBACK' });
    sessions.bind('SBACK', p.uid);
    appendN(events, 'SBACK', 5); // seq 1..5
    // Close it
    const p2 = entries.createEntry({ prefix: 'P', level_1: 'Project B' });
    sessions.bind('SBACK', p2.uid); // closes [1, 5]

    // Mark all extracted: last_extracted_seq = 5 = maxSeq for that segment
    setExtracted(db, 'SBACK', 1, 5);

    sessions.createSession({ session_id: 'SCURR' });
    sessions.bind('SCURR', p.uid);

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'SCURR',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    const backlogSeg = result.find((r) => r.session_id === 'SBACK');
    expect(backlogSeg).toBeUndefined();
  });

  it('closed segment of currentSessionId with unextracted > 0 is selected as backlog', () => {
    // A session can have multiple bindings: an earlier closed one + the current open one.
    const { db, sessions, events, entries } = makeDb();
    const pA = entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    const pB = entries.createEntry({ prefix: 'P', level_1: 'Project B' });

    sessions.createSession({ session_id: 'S1' });
    sessions.bind('S1', pA.uid);
    appendN(events, 'S1', 4); // seq 1..4 → these close when we bind pB
    sessions.bind('S1', pB.uid); // closes [pA, 1..4], opens [pB, 5..]
    // now 2 events in the new (current) segment
    appendN(events, 'S1', 2); // seq 5,6

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'S1',
      projectUid: pA.uid, // only looking at pA project
      cadence: 10,        // current pB segment won't be visible (different project)
      cap: 10,
    });

    // The closed pA segment [S1, from_seq=1] should appear as backlog (4 unextracted events)
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe('S1');
    expect(result[0].from_seq).toBe(1);
    expect(result[0].toSeqInclusive).toBe(4);
  });
});

describe('selectSegmentsForExtraction — project scoping', () => {
  it('segment for a different project is never selected', () => {
    const { db, sessions, events, entries } = makeDb();
    const pA = entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    const pB = entries.createEntry({ prefix: 'P', level_1: 'Project B' });

    // Create a session on project B (the one we're NOT looking at)
    sessions.createSession({ session_id: 'S_OTHER' });
    sessions.bind('S_OTHER', pB.uid);
    appendN(events, 'S_OTHER', 10);

    // Current session on project A (no events → nothing to select)
    sessions.createSession({ session_id: 'SCURR' });
    sessions.bind('SCURR', pA.uid);

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'SCURR',
      projectUid: pA.uid,
      cadence: 5,
      cap: 10,
    });

    // S_OTHER is on pB, should not appear
    const other = result.find((r) => r.session_id === 'S_OTHER');
    expect(other).toBeUndefined();
  });
});

describe('selectSegmentsForExtraction — cap and ordering', () => {
  it('returns at most cap segments total, current counts toward cap', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });

    // Create 12 backlog sessions with unextracted events, each on project p
    for (let i = 0; i < 12; i++) {
      const sid = `SBACK-${i.toString().padStart(2, '0')}`;
      sessions.createSession({ session_id: sid });
      sessions.bind(sid, p.uid);
      appendN(events, sid, 3);
      // Close each one (bind a second project)
      const tmp = entries.createEntry({ prefix: 'P', level_1: `Tmp-${i}` });
      sessions.bind(sid, tmp.uid);
    }

    // Current session — has enough events to exceed cadence
    sessions.createSession({ session_id: 'SCURR' });
    sessions.bind('SCURR', p.uid);
    appendN(events, 'SCURR', 5); // = cadence

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'SCURR',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    expect(result.length).toBe(10);
  });

  it('current segment is returned first when both current and backlog are eligible', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });

    // Backlog session
    sessions.createSession({ session_id: 'SBACK' });
    sessions.bind('SBACK', p.uid);
    appendN(events, 'SBACK', 5);
    const p2 = entries.createEntry({ prefix: 'P', level_1: 'Proj B' });
    sessions.bind('SBACK', p2.uid);

    // Current session
    sessions.createSession({ session_id: 'SCURR' });
    sessions.bind('SCURR', p.uid);
    appendN(events, 'SCURR', 5); // = cadence

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'SCURR',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    expect(result[0].session_id).toBe('SCURR');
  });

  it('backlog ordered by sessions.updated_at DESC (most recent first), NOT by session_id', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });

    // Three backlog sessions with explicit updated_at timestamps
    const specs: Array<{ sid: string; ts: string }> = [
      { sid: 'SBACK-A', ts: '2024-01-01T10:00:00.000Z' }, // oldest
      { sid: 'SBACK-B', ts: '2024-06-01T10:00:00.000Z' }, // middle
      { sid: 'SBACK-C', ts: '2024-12-01T10:00:00.000Z' }, // newest
    ];

    for (const { sid, ts } of specs) {
      sessions.createSession({ session_id: sid });
      sessions.bind(sid, p.uid);
      appendN(events, sid, 3);
      const tmp = entries.createEntry({ prefix: 'P', level_1: `Tmp-${sid}` });
      sessions.bind(sid, tmp.uid);
      setUpdatedAt(db, sid, ts);
    }

    // Current session — below cadence so not in result
    sessions.createSession({ session_id: 'SCURR' });
    sessions.bind('SCURR', p.uid);

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'SCURR',
      projectUid: p.uid,
      cadence: 20, // high → current not eligible
      cap: 10,
    });

    // Should be ordered newest-first: C, B, A
    expect(result.map((r) => r.session_id)).toEqual(['SBACK-C', 'SBACK-B', 'SBACK-A']);
  });

  it('ordering is by sessions.updated_at (not session_id) even when session_id order differs', () => {
    // session_id order: SBACK-Z, SBACK-A; updated_at order: SBACK-A (newer), SBACK-Z (older)
    // Expected result order: [SBACK-A, SBACK-Z]
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });

    const specs: Array<{ sid: string; ts: string }> = [
      { sid: 'SBACK-Z', ts: '2024-01-01T00:00:00.000Z' }, // older, but alphabetically last
      { sid: 'SBACK-A', ts: '2024-06-01T00:00:00.000Z' }, // newer, but alphabetically first
    ];

    for (const { sid, ts } of specs) {
      sessions.createSession({ session_id: sid });
      sessions.bind(sid, p.uid);
      appendN(events, sid, 3);
      const tmp = entries.createEntry({ prefix: 'P', level_1: `Tmp-${sid}` });
      sessions.bind(sid, tmp.uid);
      setUpdatedAt(db, sid, ts);
    }

    sessions.createSession({ session_id: 'SCURR' });
    sessions.bind('SCURR', p.uid);

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'SCURR',
      projectUid: p.uid,
      cadence: 20,
      cap: 10,
    });

    expect(result[0].session_id).toBe('SBACK-A');
    expect(result[1].session_id).toBe('SBACK-Z');
  });

  it('0-event segments (no events at all) are excluded', () => {
    const { db, sessions, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });

    // A binding with zero events
    sessions.createSession({ session_id: 'SEMPTY' });
    sessions.bind('SEMPTY', p.uid);
    // no appendN → 0 events

    sessions.createSession({ session_id: 'SCURR' });
    sessions.bind('SCURR', p.uid);

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'SCURR',
      projectUid: p.uid,
      cadence: 1,
      cap: 10,
    });

    expect(result.find((r) => r.session_id === 'SEMPTY')).toBeUndefined();
  });
});

describe('selectSegmentsForExtraction — SelectedSegment shape', () => {
  it('returned SelectedSegment carries session_id, from_seq, fromSeqExclusive, toSeqInclusive', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    sessions.createSession({ session_id: 'S1' });
    sessions.bind('S1', p.uid);
    appendN(events, 'S1', 7);

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'S1',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    expect(result).toHaveLength(1);
    const seg = result[0];
    expect(seg.session_id).toBe('S1');
    expect(typeof seg.from_seq).toBe('number');
    expect(typeof seg.fromSeqExclusive).toBe('number');
    expect(typeof seg.toSeqInclusive).toBe('number');
    expect(seg.from_seq).toBe(1);
    expect(seg.fromSeqExclusive).toBe(0);
    expect(seg.toSeqInclusive).toBe(7);
  });

  it('fromSeqExclusive = last_extracted_seq when a marker exists', () => {
    const { db, sessions, events, entries } = makeDb();
    const p = entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    sessions.createSession({ session_id: 'S1' });
    sessions.bind('S1', p.uid);
    appendN(events, 'S1', 10);
    setExtracted(db, 'S1', 1, 4); // extracted up to seq 4

    const result = selectSegmentsForExtraction(db, {
      currentSessionId: 'S1',
      projectUid: p.uid,
      cadence: 5,
      cap: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0].fromSeqExclusive).toBe(4);
    expect(result[0].toSeqInclusive).toBe(10);
  });
});

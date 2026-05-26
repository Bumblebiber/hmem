import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createEntriesApi } from '../../src/store/entries.js';
import { createEventsApi } from '../../src/store/events.js';
import { createSummarizer } from '../../src/summarize/loop.js';
import { createSessionsApi } from '../../src/store/sessions.js';

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

describe('summarizer', () => {
  it('scenario 5: boundary flush summarizes the un-summarized tail into the closing project', () => {
    const { events, sessions, sum, pA, pB, db } = setup(5);
    sessions.createSession({ session_id: 'S' });
    sessions.bind('S', pA);
    for (let i = 0; i < 15; i++) events.appendEvent({ session_id: 'S', role: 'user', content: 'x' });
    sum.maybeCheckpoint('S'); // cadence 5 → summarized through seq 15
    for (let i = 0; i < 5; i++) events.appendEvent({ session_id: 'S', role: 'user', content: 'x' }); // 16..20
    sessions.bind('S', pB); // boundary flush 16..20 into pA
    const aNode = db
      .prepare('SELECT node_uid, last_summarized_seq FROM segment_summaries WHERE session_id=? AND from_seq=1')
      .get('S') as { node_uid: string; last_summarized_seq: number };
    expect(aNode.last_summarized_seq).toBe(20);
    const content = (
      db.prepare('SELECT content FROM nodes WHERE uid=?').get(aNode.node_uid) as { content: string }
    ).content;
    expect(content).toBe('S:1-2-3-4-5-6-7-8-9-10-11-12-13-14-15-16-17-18-19-20');
    // the closing project pB is irrelevant for this segment but must exist as a row
    expect(pB).toBeTruthy();
  });

  it('scenario 2/3: resummarizeSegment rebuilds a segment summary in place under its project', () => {
    const { events, sessions, sum, pA, db } = setup(100);
    sessions.createSession({ session_id: 'S' });
    sessions.bind('S', pA);
    for (let i = 0; i < 10; i++) events.appendEvent({ session_id: 'S', role: 'user', content: 'x' });
    sum.resummarizeSegment('S', 1, 10);
    const row1 = db
      .prepare('SELECT node_uid FROM segment_summaries WHERE session_id=? AND from_seq=1')
      .get('S') as { node_uid: string };
    expect(
      (db.prepare('SELECT content FROM nodes WHERE uid=?').get(row1.node_uid) as { content: string })
        .content,
    ).toBe('S:1-2-3-4-5-6-7-8-9-10');
    sum.resummarizeSegment('S', 1, 5); // rebuild over a narrower range → same node, updated content
    const row2 = db
      .prepare('SELECT node_uid FROM segment_summaries WHERE session_id=? AND from_seq=1')
      .get('S') as { node_uid: string };
    expect(row2.node_uid).toBe(row1.node_uid); // in place, not a new node
    expect(
      (db.prepare('SELECT content FROM nodes WHERE uid=?').get(row2.node_uid) as { content: string })
        .content,
    ).toBe('S:1-2-3-4-5');
  });

  it('updates the session one-line summary alongside the node', () => {
    const { events, sessions, sum, pA } = setup(100);
    sessions.createSession({ session_id: 'S' });
    sessions.bind('S', pA);
    for (let i = 0; i < 3; i++) events.appendEvent({ session_id: 'S', role: 'user', content: 'x' });
    sum.resummarizeSegment('S', 1, 3);
    const row = sessions.getSession('S')!;
    expect(row.summary).toBe('S:1-2-3');
    expect(row.summary_node_uid).toBeTruthy();
  });
});

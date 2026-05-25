import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createSessionsApi } from '../../src/store/sessions.js';
import { createEventsApi } from '../../src/store/events.js';

const api = () => createSessionsApi(openDb(':memory:'));

describe('sessions CRUD', () => {
  it('creates with a provided id and generates one otherwise', () => {
    const s = api();
    expect(s.createSession({ session_id: 'hook-123', harness: 'claude-code' }).session_id).toBe(
      'hook-123',
    );
    expect(s.getSession('hook-123')!.harness).toBe('claude-code');
    expect(s.createSession({}).session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('createSession is idempotent for a re-used hook id', () => {
    const s = api();
    s.createSession({ session_id: 'S', harness: 'claude-code' });
    s.createSession({ session_id: 'S', harness: 'pi' }); // re-create must not clobber
    expect(s.getSession('S')!.harness).toBe('claude-code');
  });

  it('touchSession bumps last_active_at and updated_at', () => {
    const s = api();
    s.createSession({ session_id: 'S' });
    const before = s.getSession('S')!;
    expect(before.last_active_at).toBeNull();
    s.touchSession('S');
    const after = s.getSession('S')!;
    expect(after.last_active_at).not.toBeNull();
  });

  it('updateSessionSummary sets one-line summary + node pointer', () => {
    const s = api();
    s.createSession({ session_id: 'S' });
    s.updateSessionSummary('S', 'did X', 'node-uid-1');
    const row = s.getSession('S')!;
    expect(row.summary).toBe('did X');
    expect(row.summary_node_uid).toBe('node-uid-1');
  });
});

describe('session bindings — segment algebra', () => {
  it('scenario 1: 20 events under one binding all attribute to P_a', () => {
    const db = openDb(':memory:');
    const s = createSessionsApi(db);
    const ev = createEventsApi(db);
    s.createSession({ session_id: 'S' });
    s.bind('S', 'P_a'); // from = 0+1 = 1
    for (let i = 0; i < 20; i++) ev.appendEvent({ session_id: 'S', role: 'user', content: 'x' });
    expect(s.currentProject('S')).toBe('P_a');
    expect(s.projectAt('S', 1)).toBe('P_a');
    expect(s.projectAt('S', 20)).toBe('P_a');
  });

  it('scenario 2: bind P_b after 20 events splits at the boundary', () => {
    const db = openDb(':memory:');
    const s = createSessionsApi(db);
    const ev = createEventsApi(db);
    s.createSession({ session_id: 'S' });
    s.bind('S', 'P_a');
    for (let i = 0; i < 20; i++) ev.appendEvent({ session_id: 'S', role: 'user', content: 'x' });
    s.bind('S', 'P_b'); // from = 21
    expect(s.projectAt('S', 20)).toBe('P_a');
    expect(s.projectAt('S', 21)).toBeNull(); // no event 21 yet, but segment opens there
    ev.appendEvent({ session_id: 'S', role: 'user', content: 'x' }); // seq 21
    expect(s.projectAt('S', 21)).toBe('P_b');
    expect(s.currentProject('S')).toBe('P_b');
    const segs = s.segmentsForSession('S');
    expect(segs.map((b) => [b.from_seq, b.to_seq, b.project_uid])).toEqual([
      [1, 20, 'P_a'],
      [21, null, 'P_b'],
    ]);
  });

  it('scenario 3: late switch since=11 re-attributes 11..20 to P_b, no event mutated', () => {
    const db = openDb(':memory:');
    const s = createSessionsApi(db);
    const ev = createEventsApi(db);
    s.createSession({ session_id: 'S' });
    s.bind('S', 'P_a');
    const uids: string[] = [];
    for (let i = 0; i < 20; i++)
      uids.push(ev.appendEvent({ session_id: 'S', role: 'user', content: 'x' }).event_uid);
    s.bind('S', 'P_b', 11); // backdate
    expect(s.projectAt('S', 10)).toBe('P_a');
    expect(s.projectAt('S', 11)).toBe('P_b');
    expect(s.projectAt('S', 20)).toBe('P_b');
    expect(ev.eventsForProject('P_a').map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ev.eventsForProject('P_b').map((e) => e.seq)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    // no event row mutated: uids + seqs unchanged
    expect(ev.getSessionLog('S').map((e) => e.event_uid)).toEqual(uids);
  });

  it('scenario 4: switch back to P_a yields a third segment; eventsForProject unions segments', () => {
    const db = openDb(':memory:');
    const s = createSessionsApi(db);
    const ev = createEventsApi(db);
    s.createSession({ session_id: 'S' });
    s.bind('S', 'P_a');
    for (let i = 0; i < 20; i++) ev.appendEvent({ session_id: 'S', role: 'user', content: 'x' }); // 1..20 P_a
    s.bind('S', 'P_b');
    for (let i = 0; i < 10; i++) ev.appendEvent({ session_id: 'S', role: 'user', content: 'x' }); // 21..30 P_b
    s.bind('S', 'P_a');
    ev.appendEvent({ session_id: 'S', role: 'user', content: 'x' }); // 31 P_a
    expect(ev.eventsForProject('P_a').map((e) => e.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 31,
    ]);
    expect(ev.eventsForProject('P_b').map((e) => e.seq)).toEqual([
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
  });

  it('empty-segment retarget: re-bind before any event overwrites the open segment in place', () => {
    const db = openDb(':memory:');
    const s = createSessionsApi(db);
    s.createSession({ session_id: 'S' });
    s.bind('S', 'P_a'); // open [1,NULL] P_a
    s.bind('S', 'P_b'); // from = 1 again → delForward drops [1,NULL], opens [1,NULL] P_b
    expect(s.segmentsForSession('S').map((b) => [b.from_seq, b.to_seq, b.project_uid])).toEqual([
      [1, null, 'P_b'],
    ]);
    expect(s.currentProject('S')).toBe('P_b');
  });
});

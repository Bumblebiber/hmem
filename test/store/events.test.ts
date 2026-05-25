import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createEventsApi } from '../../src/store/events.js';

const api = () => createEventsApi(openDb(':memory:'));

describe('events', () => {
  it('assigns monotonic per-session seq', () => {
    const e = api();
    expect(e.appendEvent({ session_id: 'S', role: 'user', content: 'a' }).seq).toBe(1);
    expect(e.appendEvent({ session_id: 'S', role: 'assistant', content: 'b' }).seq).toBe(2);
    expect(e.appendEvent({ session_id: 'T', role: 'user', content: 'c' }).seq).toBe(1); // independent
    expect(e.maxSeq('S')).toBe(2);
    expect(e.maxSeq('NONE')).toBe(0);
  });

  it('event_uid is a ULID and rows come back ordered', () => {
    const e = api();
    for (let i = 0; i < 3; i++) e.appendEvent({ session_id: 'S', role: 'user', content: `m${i}` });
    const log = e.getSessionLog('S');
    expect(log.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(log[0].event_uid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('exposes no event mutation API (immutability contract)', () => {
    const e = api() as unknown as Record<string, unknown>;
    expect(e.updateEvent).toBeUndefined();
    expect(e.deleteEvent).toBeUndefined();
  });
});

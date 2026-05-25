import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createEventsApi } from '../../src/store/events.js';
import { createEventsFtsApi } from '../../src/store/events-fts.js';

describe('events-fts', () => {
  it('searches event content, isolated from the curated fts', () => {
    const db = openDb(':memory:');
    const ev = createEventsApi(db);
    const f = createEventsFtsApi(db);
    const { event_uid } = ev.appendEvent({
      session_id: 'S',
      role: 'user',
      content: 'discuss the okapi migration',
    });
    expect(f.searchEvents('okapi').map((r) => r.event_uid)).toContain(event_uid);
    expect(f.searchEvents('')).toHaveLength(0);
    expect(() => f.searchEvents('"); DROP TABLE events; --')).not.toThrow();
    // the curated fts must NOT contain event text (events get their own index)
    expect(db.prepare("SELECT count(*) c FROM fts WHERE fts MATCH 'okapi'").get()).toMatchObject({
      c: 0,
    });
  });
});

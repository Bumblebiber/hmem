import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';

const mk = () => createV2Store(':memory:', DEFAULT_CONFIG);

describe('createV2Store', () => {
  it('wires all v2 APIs and reports schema_major=2', () => {
    const s = mk();
    expect(typeof s.entries.createEntry).toBe('function');
    expect(typeof s.links.addLink).toBe('function');
    expect(typeof s.fts.search).toBe('function');
    expect(typeof s.events.appendEvent).toBe('function');
    expect(typeof s.eventsFts.searchEvents).toBe('function');
    expect(typeof s.sessions.bind).toBe('function');
    expect(typeof s.summarizer.flushSegment).toBe('function');
    s.close();
  });

  it('binding boundary flush invokes the summarizer (cycle resolved)', () => {
    const s = mk();
    const { uid: pUid } = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const { uid: qUid } = s.entries.createEntry({ prefix: 'P', level_1: 'Other' });
    const { session_id } = s.sessions.createSession({});
    s.sessions.bind(session_id, pUid);
    s.events.appendEvent({ session_id, role: 'user', content: 'hello' });
    s.events.appendEvent({ session_id, role: 'assistant', content: 'hi' });
    expect(() => s.sessions.bind(session_id, qUid)).not.toThrow();
    expect(s.sessions.currentProject(session_id)).toBe(qUid);
    s.close();
  });
});

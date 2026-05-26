import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { searchMemory } from '../../src/v2/search.js';

describe('searchMemory', () => {
  it('finds entries by curated content', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const e = s.entries.createEntry({ prefix: 'L', level_1: 'FTS5 contentless pattern' });
    s.entries.addNode({ root_uid: e.uid, content: 'rowid map technique' });
    const out = searchMemory(s, 'contentless', {});
    expect(out).toContain(e.label);
    s.close();
  });

  it('searches raw events when scope=events', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { session_id } = s.sessions.createSession({});
    s.events.appendEvent({ session_id, role: 'user', content: 'deploy the staging server' });
    const out = searchMemory(s, 'staging', { scope: 'events' });
    expect(out).toMatch(/staging/i);
    s.close();
  });

  it('returns a no-results marker on empty match', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    expect(searchMemory(s, 'zzzznomatch', {})).toMatch(/no (results|matches)/i);
    s.close();
  });
});

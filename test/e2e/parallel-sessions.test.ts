import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';

describe('parallel sessions do not contaminate each other (v2 binding model)', () => {
  it('each session has its own current project via session_bindings', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p1 = s.entries.createEntry({ prefix: 'P', level_1: 'Alpha' });
    const p2 = s.entries.createEntry({ prefix: 'P', level_1: 'Beta' });
    const a = s.sessions.createSession({}).session_id;
    const b = s.sessions.createSession({}).session_id;

    s.sessions.bind(a, p1.uid);
    s.sessions.bind(b, p2.uid);

    // No global active flag — attribution is per-session and independent.
    expect(s.sessions.currentProject(a)).toBe(p1.uid);
    expect(s.sessions.currentProject(b)).toBe(p2.uid);
    s.close();
  });

  it('a session with no binding has no current project (null), not a leaked global', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p1 = s.entries.createEntry({ prefix: 'P', level_1: 'Alpha' });
    const a = s.sessions.createSession({}).session_id;
    const b = s.sessions.createSession({}).session_id;
    s.sessions.bind(a, p1.uid);
    expect(s.sessions.currentProject(b)).toBeNull();
    s.close();
  });
});

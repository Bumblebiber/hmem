import { describe, it, expect, afterEach } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { activate, getSessionLog } from '../../src/v2/sessions-tools.js';

const old = process.env.HMEM_SESSION_ID;
afterEach(() => { if (old === undefined) delete process.env.HMEM_SESSION_ID; else process.env.HMEM_SESSION_ID = old; });

describe('activate', () => {
  it('binds the current session to a project (open segment)', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const { session_id } = s.sessions.createSession({});
    process.env.HMEM_SESSION_ID = session_id;
    const res = activate(s, p.label, {});
    expect(res.session_id).toBe(session_id);
    expect(res.project).toBe(p.label);
    expect(s.sessions.currentProject(session_id)).toBe(p.uid);
    s.close();
  });

  it('since= backdates the binding (late-switch correction)', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p1 = s.entries.createEntry({ prefix: 'P', level_1: 'P1' });
    const p2 = s.entries.createEntry({ prefix: 'P', level_1: 'P2' });
    const { session_id } = s.sessions.createSession({});
    process.env.HMEM_SESSION_ID = session_id;
    s.sessions.bind(session_id, p1.uid);
    s.events.appendEvent({ session_id, role: 'user', content: 'e1' });
    s.events.appendEvent({ session_id, role: 'assistant', content: 'e2' });
    activate(s, p2.label, { since: 2 });
    expect(s.sessions.projectAt(session_id, 1)).toBe(p1.uid);
    expect(s.sessions.projectAt(session_id, 2)).toBe(p2.uid);
    s.close();
  });

  it('creates a session when none is resolvable', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    delete process.env.HMEM_SESSION_ID;
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const res = activate(s, p.label, {});
    expect(res.session_id).toBeTruthy();
    expect(s.sessions.currentProject(res.session_id)).toBe(p.uid);
    s.close();
  });

  it('throws for a non-project label', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const l = s.entries.createEntry({ prefix: 'L', level_1: 'not a project' });
    expect(() => activate(s, l.label, {})).toThrow();
    s.close();
  });
});

describe('getSessionLog', () => {
  it('returns raw events for a session', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { session_id } = s.sessions.createSession({});
    s.events.appendEvent({ session_id, role: 'user', content: 'hello' });
    s.events.appendEvent({ session_id, role: 'assistant', content: 'world' });
    const log = getSessionLog(s, session_id);
    expect(log).toContain('hello');
    expect(log).toContain('world');
    s.close();
  });

  it('returns a marker for an empty/unknown session', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    expect(getSessionLog(s, 'nope')).toMatch(/no events/i);
    s.close();
  });

  it('caps to the most recent N events with an accurate truncation note', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { session_id } = s.sessions.createSession({});
    for (let i = 0; i < 5; i++) s.events.appendEvent({ session_id, role: 'user', content: `line A\nline B ${i}` }); // multi-line events
    const out = getSessionLog(s, session_id, 2);
    expect(out).toContain('‹3 earlier events truncated›');
    // only the last 2 events' content present
    expect(out).toContain('line B 4');
    expect(out).toContain('line B 3');
    expect(out).not.toContain('line B 0');
    s.close();
  });
});

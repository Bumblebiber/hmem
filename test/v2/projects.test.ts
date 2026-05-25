import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { listProjects, loadProject } from '../../src/v2/projects.js';

describe('listProjects', () => {
  it('lists P-entries with labels and titles', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'P', level_1: 'Alpha' });
    const b = s.entries.createEntry({ prefix: 'P', level_1: 'Beta' });
    const out = listProjects(s);
    expect(out).toContain(a.label); expect(out).toContain('Alpha');
    expect(out).toContain(b.label); expect(out).toContain('Beta');
    s.close();
  });
});

describe('loadProject', () => {
  it('includes the brief and Recent Sessions from bindings', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'My Proj' });
    s.entries.addNode({ root_uid: p.uid, content: 'Overview' });
    const { session_id } = s.sessions.createSession({});
    s.sessions.bind(session_id, p.uid);
    s.sessions.updateSessionSummary(session_id, 'did some work', '');
    const { text } = loadProject(s, p.label, { why: false });
    expect(text).toContain('My Proj');
    expect(text).toContain('Overview');
    expect(text).toMatch(/Recent Sessions/i);
    expect(text).toContain('did some work');
    s.close();
  });

  it('returns a not-found marker for a non-project id', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    expect(loadProject(s, 'P9999', {}).text).toMatch(/not found/i);
    s.close();
  });
});

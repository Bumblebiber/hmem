import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { listProjects, loadProject, createProject, readProject } from '../../src/v2/projects.js';

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
    s.events.appendEvent({ session_id, role: 'user', content: 'first' });
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

describe('createProject', () => {
  it('creates a P-entry, scaffolds sections, and creates NO O-entry', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label } = createProject(s, { name: 'Cool Project', tech: 'TS', description: 'does things' });
    expect(label).toMatch(/^P\d{4}$/);
    const oCount = (s.db.prepare("SELECT COUNT(*) c FROM entries WHERE prefix='O'").get() as { c: number }).c;
    expect(oCount).toBe(0);
    const root = s.entries.labelToUid(label)!;
    const childCount = (s.db.prepare('SELECT COUNT(*) c FROM nodes WHERE root_uid=? AND parent_uid IS NULL').get(root) as { c: number }).c;
    expect(childCount).toBeGreaterThan(0);
    s.close();
  });

  it('captures repo in level_1 and goal/audience/deployment as nodes', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label, uid } = createProject(s, {
      name: 'Meta', tech: 'TS', description: 'd',
      repo: 'Bumblebiber/meta', goal: 'ship it', audience: 'devs', deployment: 'vercel',
    });
    const e = s.entries.getEntry(uid)!;
    expect(e.level_1).toContain('GH: Bumblebiber/meta');
    const contents = (s.db.prepare('SELECT content FROM nodes WHERE root_uid=?').all(uid) as { content: string }[]).map(r => r.content);
    expect(contents).toContain('Goal: ship it');
    expect(contents).toContain('Audience: devs');
    expect(contents).toContain('Deployment: vercel');
    s.close();
  });

  it('persists tags when provided', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { uid } = createProject(s, { name: 'T', tech: 'TS', description: 'd', tags: ['#cool'] });
    const e = s.entries.getEntry(uid)!;
    expect(JSON.parse(e.tags ?? '[]')).toContain('#cool');
    s.close();
  });

  it('omits metadata nodes when fields are absent', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { uid, label } = createProject(s, { name: 'Bare', tech: 'TS', description: 'd' });
    const e = s.entries.getEntry(uid)!;
    expect(e.level_1).not.toContain('GH:');
    const contents = (s.db.prepare('SELECT content FROM nodes WHERE root_uid=?').all(uid) as { content: string }[]).map(r => r.content);
    expect(contents.some(c => c.startsWith('Goal:'))).toBe(false);
    s.close();
  });
});

describe('readProject', () => {
  it('renders a project tree without activating anything', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label } = createProject(s, { name: 'P', tech: 'TS', description: 'x' });
    const out = readProject(s, label);
    expect(out).toContain(label);
    s.close();
  });
});

describe('loadProject — Recent Sessions display filter', () => {
  it('hides a session with irrelevant=1', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'FilterProj' });
    const { session_id } = s.sessions.createSession({});
    s.sessions.bind(session_id, p.uid);
    s.events.appendEvent({ session_id, role: 'user', content: 'hello' });
    s.sessions.updateSessionSummary(session_id, 'irrelevant session', '');
    // Mark irrelevant
    s.db.prepare('UPDATE sessions SET irrelevant = 1 WHERE session_id = ?').run(session_id);
    const { text } = loadProject(s, p.label);
    expect(text).not.toContain('irrelevant session');
    s.close();
  });

  it('hides a 0-event session (not the current session)', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'FilterProj2' });
    const { session_id } = s.sessions.createSession({});
    s.sessions.bind(session_id, p.uid);
    s.sessions.updateSessionSummary(session_id, 'empty session', '');
    // No events added — session has 0 events
    const { text } = loadProject(s, p.label);
    expect(text).not.toContain('empty session');
    s.close();
  });

  it('shows a session with at least 1 event (irrelevant=0)', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'FilterProj3' });
    const { session_id } = s.sessions.createSession({});
    s.sessions.bind(session_id, p.uid);
    s.events.appendEvent({ session_id, role: 'user', content: 'first event' });
    s.sessions.updateSessionSummary(session_id, 'active session', '');
    const { text } = loadProject(s, p.label);
    expect(text).toContain('active session');
    s.close();
  });

  it('shows a 0-event session that IS the current session (via opts.currentSessionId)', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'FilterProj4' });
    const { session_id } = s.sessions.createSession({});
    s.sessions.bind(session_id, p.uid);
    // No events — but this IS the current session
    s.sessions.updateSessionSummary(session_id, 'fresh session', '');
    const { text } = loadProject(s, p.label, { currentSessionId: session_id });
    expect(text).toContain('fresh session');
    s.close();
  });
});

describe('loadProject why-trace', () => {
  it('returns a why trace when opts.why is true', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'WhyProj' });
    const res = loadProject(s, p.label, { why: true });
    expect(res.why).toBeDefined();
    expect(res.why!.some(w => w.label === p.label && w.shown === 'expanded')).toBe(true);
    s.close();
  });
});

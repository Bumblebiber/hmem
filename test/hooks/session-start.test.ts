// test/hooks/session-start.test.ts
import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { buildSessionStart } from '../../src/hooks/session-start.js';
import type { SessionStartDeps } from '../../src/hooks/types.js';

const deps: SessionStartDeps = {
  gitProbe: () => ({ uncommitted: [' M x.ts'], stashes: [], worktrees: [], unmergedBranches: [], isRepo: true }),
  syncProbe: () => '🟢 hmem-sync verbunden.',
  deviceProbe: () => '--- Active device ---\n  DEVELOPER ✓',
};

function seed() {
  const s = createV2Store(':memory:', DEFAULT_CONFIG);
  const h = s.entries.createEntry({ prefix: 'H', level_1: 'Identität' });
  s.entries.addNode({ root_uid: h.uid, content: 'Anrede: "Benni"' });
  const p = s.entries.createEntry({ prefix: 'P', level_1: 'its-over-9k | Active' });
  const ns = s.entries.addNode({ root_uid: p.uid, content: 'Next Steps' });
  s.entries.addNode({ root_uid: p.uid, parent_uid: ns.uid, content: 'Ship Phase 5' });
  const t = s.entries.createEntry({ prefix: 'T', level_1: 'Wire hooks' });
  s.links.addLink(p.uid, t.uid);
  return { s, p, t };
}

describe('buildSessionStart', () => {
  it('produces a full brief with a named project and binds the session', () => {
    const { s, p, t } = seed();
    const r = buildSessionStart(s, { harness: 'claude-code', sessionId: 'S1', cwd: '/repo', namedProject: p.label }, deps);
    expect(r.projectLabel).toBe(p.label);
    expect(r.bindingSource).toBe('named');
    // every section o9k-session-start used to fetch is present:
    expect(r.context).toContain('Identität');            // H-entries
    expect(r.context).toContain('Anrede: "Benni"');
    expect(r.context).toContain('Recent projects');
    expect(r.context).toContain('Active device');
    expect(r.context).toContain('hmem-sync verbunden');
    expect(r.context).toContain('its-over-9k');          // project brief
    expect(r.context).toContain('Next Steps');
    expect(r.context).toContain('Ship Phase 5');
    expect(r.context).toContain(t.label);                // open T-tasks
    expect(r.context).toContain('Offene Arbeit');        // git pending-work
    expect(s.sessions.currentProject('S1')).toBe(p.uid);
    s.close();
  });

  it('with no project bound, lists recent projects and notes no active project', () => {
    const { s } = seed();
    const r = buildSessionStart(s, { harness: 'pi', sessionId: 'S2', cwd: '/unknown' }, deps);
    expect(r.projectLabel).toBeNull();
    expect(r.bindingSource).toBe('none');
    expect(r.context).toContain('Recent projects');
    expect(r.context).toMatch(/kein.*Projekt|no .*project/i);
    s.close();
  });
});

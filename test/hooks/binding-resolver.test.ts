// test/hooks/binding-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { resolveBinding, lastProjectForWorkspace } from '../../src/hooks/binding-resolver.js';

function mk() {
  const s = createV2Store(':memory:', DEFAULT_CONFIG);
  const pa = s.entries.createEntry({ prefix: 'P', level_1: 'Alpha' });
  const pb = s.entries.createEntry({ prefix: 'P', level_1: 'Beta' });
  return { s, pa, pb };
}

describe('resolveBinding', () => {
  it('creates the session, sets cwd, and binds a named project', () => {
    const { s, pa } = mk();
    const r = resolveBinding({ store: s, sessionId: 'S1', harness: 'claude-code', cwd: '/repo/alpha', namedProject: pa.label });
    expect(r.source).toBe('named');
    expect(r.projectLabel).toBe(pa.label);
    expect(s.sessions.currentProject('S1')).toBe(pa.uid);
    expect((s.db.prepare('SELECT cwd FROM sessions WHERE session_id=?').get('S1') as any).cwd).toBe('/repo/alpha');
    s.close();
  });

  it('keeps an existing open binding on resume', () => {
    const { s, pa, pb } = mk();
    resolveBinding({ store: s, sessionId: 'S1', harness: 'claude-code', cwd: '/repo/alpha', namedProject: pa.label });
    const again = resolveBinding({ store: s, sessionId: 'S1', harness: 'claude-code', cwd: '/repo/alpha', namedProject: pb.label });
    expect(again.source).toBe('resume');
    expect(again.projectLabel).toBe(pa.label); // not re-bound to pb
    s.close();
  });

  it('falls back to last-active-for-this-workspace via cwd', () => {
    const { s, pa } = mk();
    // S1 binds Alpha in /repo/alpha; S2 (same cwd, no named project) inherits Alpha.
    resolveBinding({ store: s, sessionId: 'S1', harness: 'claude-code', cwd: '/repo/alpha', namedProject: pa.label });
    const r = resolveBinding({ store: s, sessionId: 'S2', harness: 'hermes', cwd: '/repo/alpha' });
    expect(r.source).toBe('workspace');
    expect(r.projectLabel).toBe(pa.label);
    s.close();
  });

  it('binds nothing when no named project and unknown workspace', () => {
    const { s } = mk();
    const r = resolveBinding({ store: s, sessionId: 'S3', harness: 'pi', cwd: '/unknown/dir' });
    expect(r.source).toBe('none');
    expect(r.projectUid).toBeNull();
    expect(s.sessions.currentProject('S3')).toBeNull();
    s.close();
  });

  it('lastProjectForWorkspace returns null for an unseen cwd', () => {
    const { s } = mk();
    expect(lastProjectForWorkspace(s, '/never')).toBeNull();
    s.close();
  });
});

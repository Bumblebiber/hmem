// test/hooks/stable-context.test.ts
import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { buildStableContext } from '../../src/hooks/stable-context.js';

const deps = { syncProbe: () => '🟢 hmem-sync verbunden.', deviceProbe: () => '--- Active device ---\n  DEVELOPER ✓' };

describe('buildStableContext', () => {
  it('renders H-entries with their bullet children, recent projects, device + sync', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const h = s.entries.createEntry({ prefix: 'H', level_1: 'Identität — Name, Anrede' });
    s.entries.addNode({ root_uid: h.uid, content: 'Anrede: "Benni"' });
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'its-over-9k | Active' });

    const out = buildStableContext(s, deps);
    expect(out).toContain('Human context');
    expect(out).toContain('Identität');
    expect(out).toContain('Anrede: "Benni"');
    expect(out).toContain('Recent projects');
    expect(out).toContain(p.label);
    expect(out).toContain('Active device');
    expect(out).toContain('hmem-sync verbunden');
    s.close();
  });

  it('lists pinned/favorite R-entries in a Rules block, excludes unpinned', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const pinned = s.entries.createEntry({ prefix: 'R', level_1: 'Pinned rule title\nbody detail of the pinned rule' });
    s.db.prepare('UPDATE entries SET pinned=1 WHERE uid=?').run(pinned.uid);
    const fav = s.entries.createEntry({ prefix: 'R', level_1: 'Favorite rule title' });
    s.db.prepare('UPDATE entries SET favorite=1 WHERE uid=?').run(fav.uid);
    s.entries.createEntry({ prefix: 'R', level_1: 'Unpinned rule title' }); // must be excluded

    const out = buildStableContext(s, deps);
    expect(out).toContain('--- Rules (pinned/favorited) ---');
    expect(out).toContain(`${pinned.label}  Pinned rule title`);
    expect(out).toContain('> body detail of the pinned rule');
    expect(out).toContain(`${fav.label}  Favorite rule title`);
    expect(out).not.toContain('Unpinned rule title');
    s.close();
  });

  it('still emits all section headers with no H/P entries', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const out = buildStableContext(s, deps);
    expect(out).toContain('Human context');
    expect(out).toContain('Recent projects');
    s.close();
  });

  it('real defaults (no injected probes) never throw and still emit device + sync sections', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    let out = '';
    expect(() => { out = buildStableContext(s); }).not.toThrow(); // reads ~/.hmem/* with safe fallbacks
    expect(out).toContain('Active device');
    expect(out).toMatch(/hmem-sync/);
    s.close();
  });
});

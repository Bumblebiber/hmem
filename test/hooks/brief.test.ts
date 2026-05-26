// test/hooks/brief.test.ts
import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { buildProjectBrief } from '../../src/hooks/brief.js';

describe('buildProjectBrief', () => {
  it('includes the brief, the Next Steps section, and open linked T-tasks', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const p = s.entries.createEntry({ prefix: 'P', level_1: 'My Proj | Active' });
    const ns = s.entries.addNode({ root_uid: p.uid, content: 'Next Steps' });
    s.entries.addNode({ root_uid: p.uid, parent_uid: ns.uid, content: 'Ship Phase 5' });
    const t = s.entries.createEntry({ prefix: 'T', level_1: 'Wire the hooks' });
    s.links.addLink(p.uid, t.uid);

    const out = buildProjectBrief(s, p.label);
    expect(out).toContain('My Proj');
    expect(out).toContain('Next Steps');
    expect(out).toContain('Ship Phase 5');
    expect(out).toContain('Offene Tasks');
    expect(out).toContain(t.label);
    expect(out).toContain('Wire the hooks');
    s.close();
  });

  it('returns a not-found marker for a non-project label', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    expect(buildProjectBrief(s, 'P9999')).toMatch(/not found/i);
    s.close();
  });
});

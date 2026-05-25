import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { renderEntryTree } from '../../src/v2/read-render.js';

describe('renderEntryTree', () => {
  it('renders a root entry with its children to the requested depth', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { uid: root, label } = s.entries.createEntry({ prefix: 'P', level_1: 'My Project' });
    const ov = s.entries.addNode({ root_uid: root, content: 'Overview line' });
    s.entries.addNode({ root_uid: root, parent_uid: ov.uid, content: 'deep detail' });
    const out = renderEntryTree(s, label, 2);
    expect(out).toContain(label);
    expect(out).toContain('My Project');
    expect(out).toContain('Overview line');
    expect(out).not.toContain('deep detail'); // depth 2 stops before grandchildren
    s.close();
  });

  it('returns a not-found marker for an unknown address', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    expect(renderEntryTree(s, 'P9999', 2)).toMatch(/not found/i);
    s.close();
  });
});

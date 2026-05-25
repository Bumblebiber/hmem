import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { resolveAddress, nodePathOf } from '../../src/v2/addressing.js';

function seed() {
  const s = createV2Store(':memory:', DEFAULT_CONFIG);
  const { uid: root, label } = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
  const a = s.entries.addNode({ root_uid: root, content: 'Overview' });       // seq 1
  const b = s.entries.addNode({ root_uid: root, content: 'Codebase' });        // seq 2
  const b1 = s.entries.addNode({ root_uid: root, parent_uid: b.uid, content: 'cli.ts' }); // seq 1 under b
  return { s, root, label, a: a.uid, b: b.uid, b1: b1.uid };
}

describe('resolveAddress', () => {
  it('resolves a root label to the entry uid', () => {
    const { s, root, label } = seed();
    expect(resolveAddress(s, label)).toEqual({ root_uid: root, node_uid: null });
    s.close();
  });
  it('resolves a 2-level node path to a direct child node', () => {
    const { s, label, root, b } = seed();
    expect(resolveAddress(s, `${label}.2`)).toEqual({ root_uid: root, node_uid: b });
    s.close();
  });
  it('resolves a 3-level node path to a grandchild node', () => {
    const { s, label, root, b1 } = seed();
    expect(resolveAddress(s, `${label}.2.1`)).toEqual({ root_uid: root, node_uid: b1 });
    s.close();
  });
  it('returns null for an unknown label', () => {
    const { s } = seed();
    expect(resolveAddress(s, 'P9999')).toBeNull();
    s.close();
  });
  it('nodePathOf rebuilds the dotted path for a node uid', () => {
    const { s, label, b1 } = seed();
    expect(nodePathOf(s, b1)).toBe(`${label}.2.1`);
    s.close();
  });
});

import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { renderEntryTree, readBulk } from '../../src/v2/read-render.js';

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

describe('readBulk', () => {
  it('expands newest-N per prefix and title-onlys the rest, with a why-trace', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG); // topNewestCount = 5
    const labels: string[] = [];
    for (let i = 0; i < 7; i++) {
      const e = s.entries.createEntry({ prefix: 'L', level_1: `Lesson ${i}` });
      s.entries.addNode({ root_uid: e.uid, content: `body ${i}` });
      labels.push(e.label);
    }
    const { text, why } = readBulk(s, { prefix: 'L', why: true });
    const expanded = why!.filter(w => w.shown === 'expanded').map(w => w.label);
    const titled = why!.filter(w => w.shown === 'title').map(w => w.label);
    expect(expanded.length).toBe(5);
    expect(titled.length).toBe(2);
    expect(why!.every(w => typeof w.reason === 'string' && w.reason.length > 0)).toBe(true);
    expect(text).toContain('body 6');
    s.close();
  });

  it('omits the why-trace when not requested', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    s.entries.createEntry({ prefix: 'L', level_1: 'one' });
    const res = readBulk(s, { prefix: 'L' });
    expect(res.why).toBeUndefined();
    s.close();
  });

  it('treats a non-finite limit as "no limit" without crashing', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    for (let i = 0; i < 3; i++) s.entries.createEntry({ prefix: 'L', level_1: `L${i}` });
    expect(() => readBulk(s, { prefix: 'L', limit: Infinity })).not.toThrow();
    const { why } = readBulk(s, { prefix: 'L', limit: Infinity, why: true });
    expect(why!.length).toBe(3); // all returned, no LIMIT applied
    s.close();
  });

  it('renders all entries title-only when titlesOnly is set', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    for (let i = 0; i < 3; i++) { const e = s.entries.createEntry({ prefix: 'L', level_1: `L${i}` }); s.entries.addNode({ root_uid: e.uid, content: `body ${i}` }); }
    const { text, why } = readBulk(s, { prefix: 'L', titlesOnly: true, why: true });
    expect(why!.every(w => w.shown === 'title')).toBe(true);
    expect(text).not.toContain('body 0'); // no expansion
    s.close();
  });
  it('filters by tag', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'L', level_1: 'tagged' });
    const b = s.entries.createEntry({ prefix: 'L', level_1: 'untagged' });
    s.db.prepare('UPDATE entries SET tags=? WHERE uid=?').run(JSON.stringify(['#keep']), a.uid);
    const { why } = readBulk(s, { prefix: 'L', tag: '#keep', why: true });
    expect(why!.map(w => w.label)).toEqual([a.label]);
    s.close();
  });
});

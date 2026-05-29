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

describe('irrelevant node filter', () => {
  function makeStore() {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { uid: root, label } = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const keep = s.entries.addNode({ root_uid: root, content: 'keep me' });
    const drop = s.entries.addNode({ root_uid: root, content: 'hide me' });
    s.db.prepare('UPDATE nodes SET irrelevant=1 WHERE uid=?').run(drop.uid);
    return { s, label };
  }

  it('hides irrelevant nodes from a default render', () => {
    const { s, label } = makeStore();
    const out = renderEntryTree(s, label, 2);
    expect(out).toContain('keep me');
    expect(out).not.toContain('hide me');
    s.close();
  });

  it('shows irrelevant nodes when show_all is set', () => {
    const { s, label } = makeStore();
    const out = renderEntryTree(s, label, 2, true);
    expect(out).toContain('keep me');
    expect(out).toContain('hide me');
    s.close();
  });
});

describe('history cap', () => {
  function makeStore(historyLimit?: number) {
    const cfg = historyLimit === undefined ? DEFAULT_CONFIG : { ...DEFAULT_CONFIG, historyLimit };
    const s = createV2Store(':memory:', cfg);
    const { uid: root, label } = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const hist = s.entries.addNode({ root_uid: root, content: 'History' });
    for (let i = 0; i < 12; i++) s.entries.addNode({ root_uid: root, parent_uid: hist.uid, content: `h${i}` });
    const bugs = s.entries.addNode({ root_uid: root, content: 'Bugs' });
    for (let i = 0; i < 12; i++) s.entries.addNode({ root_uid: root, parent_uid: bugs.uid, content: `bug${i}` });
    return { s, label, histAddr: () => {
      const m = renderEntryTree(s, label, 2).match(/\.(\d+)\s+History/);
      return `${label}.${m![1]}`;
    } };
  }

  it('caps History children to the last N (most recent) with an older-marker, default 8', () => {
    const { s, label } = makeStore(); // default historyLimit 8
    const out = renderEntryTree(s, label, 3);
    expect(out).toContain('h11'); // newest kept
    expect(out).toContain('h4');  // boundary of last 8 (h4..h11)
    expect(out).not.toContain('h3'); // older, hidden
    expect(out).not.toContain('h0');
    expect(out).toMatch(/\+4 older/);
    s.close();
  });

  it('does NOT cap a non-History section with many children', () => {
    const { s, label } = makeStore();
    const out = renderEntryTree(s, label, 3);
    expect(out).toContain('bug0'); // bugs section fully rendered
    expect(out).toContain('bug11');
    s.close();
  });

  it('historyLimit 0 renders the History section title-only with a marker', () => {
    const { s, label } = makeStore(0);
    const out = renderEntryTree(s, label, 3);
    expect(out).toContain('History');
    expect(out).not.toContain('h0');
    expect(out).not.toContain('h11');
    expect(out).toMatch(/\+12 older/);
    s.close();
  });

  it('does NOT cap when the History node is the explicit drill-in target', () => {
    const { s, histAddr } = makeStore(); // default 8
    const out = renderEntryTree(s, histAddr(), 2);
    expect(out).toContain('h0'); // full history when targeted directly
    expect(out).toContain('h11');
    expect(out).not.toMatch(/older/);
    s.close();
  });
});

describe('addressable node seqs', () => {
  it('renders each child with its relative seq so the address round-trips', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { uid: root, label } = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const sec = s.entries.addNode({ root_uid: root, content: 'Next Steps' });
    s.entries.addNode({ root_uid: root, parent_uid: sec.uid, content: 'do the thing' });

    const entryOut = renderEntryTree(s, label, 2);
    const m = entryOut.match(/\.(\d+)\s+Next Steps/);
    expect(m, 'section should render with a .<seq> prefix').not.toBeNull();
    const secAddr = `${label}.${m![1]}`;
    expect(renderEntryTree(s, secAddr, 2)).toContain('Next Steps');

    const secOut = renderEntryTree(s, secAddr, 2);
    expect(secOut, 'node header should carry the full address').toContain(secAddr);
    const cm = secOut.match(/\.(\d+)\s+do the thing/);
    expect(cm, 'child should render with a .<seq> prefix').not.toBeNull();
    const childAddr = `${secAddr}.${cm![1]}`;
    expect(renderEntryTree(s, childAddr, 2)).toContain('do the thing');
    s.close();
  });
});

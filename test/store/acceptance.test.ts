import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createEntriesApi } from '../../src/store/entries.js';
import { createLinksApi } from '../../src/store/links.js';
import { createFtsApi } from '../../src/store/fts.js';
import { createSchemaEngine } from '../../src/store/schema-engine.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';

describe('Phase 1 acceptance', () => {
  it('round-trip entry, rename label, every link still resolves with ZERO text rewriting', () => {
    const db = openDb(':memory:');
    const e = createEntriesApi(db);
    const l = createLinksApi(db, e);

    const target = e.createEntry({ prefix: 'D', level_1: 'decision' }); // D0001
    const src = e.createEntry({ prefix: 'P', level_1: 'project' });

    const storedBody = l.resolveRefs('per D0001 we chose X'); // freeze the stored form
    const node = e.addNode({ root_uid: src.uid, content: storedBody });
    l.addLink(src.uid, target.uid, 'cites');

    // before rename: renders the current label
    expect(e.renderRefs(storedBody)).toBe('per D0001 we chose X');

    // rename the target's label
    expect(e.relabel(target.uid, 'D0500')).toBe(true);

    // after rename: render reflects the NEW label, link edge unchanged
    expect(e.renderRefs(storedBody)).toBe('per D0500 we chose X');
    expect(l.getLinks(src.uid)[0].dst_uid).toBe(target.uid);
    expect(l.getBacklinks(target.uid)[0].src_uid).toBe(src.uid);

    // ZERO text rewriting: the stored node content is byte-identical to what we wrote
    const stored = db.prepare('SELECT content FROM nodes WHERE uid = ?').get(node.uid) as {
      content: string;
    };
    expect(stored.content).toBe(storedBody);
  });

  it('schema-engine validates P, E, and a custom A through the same code path', () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      schemas: { ...DEFAULT_CONFIG.schemas, A: { sections: [{ name: 'Specs', loadDepth: 1 }] } },
    };
    const eng = createSchemaEngine(cfg);
    expect(eng.validateSchema('P', ['Overview']).valid).toBe(true);
    expect(eng.validateSchema('E', ['Reproduction']).valid).toBe(true);
    expect(eng.validateSchema('A', ['Specs']).valid).toBe(true);
    expect(eng.validateSchema('A', ['NotASection']).valid).toBe(false);
  });

  it('search finds a renamed entry by its (unchanged) indexed title', () => {
    const db = openDb(':memory:');
    const e = createEntriesApi(db);
    const f = createFtsApi(db);
    const p = e.createEntry({ prefix: 'P', level_1: 'quokka roadmap' });
    e.relabel(p.uid, 'P0123'); // label change must not disturb the title index
    const hits = f.search('quokka');
    expect(hits.some((h) => h.root_uid === p.uid && h.node_uid === null)).toBe(true);
  });
});

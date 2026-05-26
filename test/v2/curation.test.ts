import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { tagRename, tagBulk, memoryStats, memoryHealth, deleteEntryOrNode, renameId, reparentNode, exportMarkdown } from '../../src/v2/curation.js';

describe('curation', () => {
  it('tagRename rewrites a tag across entries', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'L', level_1: 'A' });
    s.db.prepare('UPDATE entries SET tags=? WHERE uid=?').run(JSON.stringify(['#old']), a.uid);
    const n = tagRename(s, '#old', '#new');
    expect(n).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(s.entries.getEntry(a.uid)!.tags ?? '[]')).toContain('#new');
    s.close();
  });

  it('tagBulk adds and removes tags on matching entries', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'L', level_1: 'A' });
    s.db.prepare('UPDATE entries SET tags=? WHERE uid=?').run(JSON.stringify(['#drop']), a.uid);
    tagBulk(s, { prefix: 'L' }, ['#add'], ['#drop']);
    const tags = JSON.parse(s.entries.getEntry(a.uid)!.tags ?? '[]');
    expect(tags).toContain('#add');
    expect(tags).not.toContain('#drop');
    s.close();
  });

  it('memoryStats reports total entries', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    s.entries.createEntry({ prefix: 'P', level_1: 'p' });
    expect(memoryStats(s).total).toBe(1);
    s.close();
  });

  it('memoryHealth finds a broken link', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'L', level_1: 'A' });
    s.db.prepare('INSERT INTO links (src_uid, dst_uid) VALUES (?, ?)').run(a.uid, 'NONEXISTENT_UID');
    expect(memoryHealth(s).brokenLinks.length).toBeGreaterThanOrEqual(1);
    s.close();
  });

  it('deleteEntryOrNode soft-deletes an entry', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'L', level_1: 'gone' });
    expect(deleteEntryOrNode(s, a.label)).toBe(true);
    expect(s.db.prepare('SELECT deleted_at FROM entries WHERE uid=?').get(a.uid)).toBeTruthy();
    s.close();
  });

  it('renameId relabels an entry', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'L', level_1: 'x' });
    expect(renameId(s, a.label, 'L0999')).toBe(true);
    expect(s.entries.labelToUid('L0999')).toBe(a.uid);
    s.close();
  });

  it('reparentNode moves a node under a new parent', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'P', level_1: 'Root' });
    const n1 = s.entries.addNode({ root_uid: a.uid, content: 'sec1' }); // seq1
    const n2 = s.entries.addNode({ root_uid: a.uid, content: 'sec2' }); // seq2
    expect(reparentNode(s, `${a.label}.1`, `${a.label}.2`)).toBe(true);
    const moved = s.db.prepare('SELECT parent_uid FROM nodes WHERE uid=?').get(n1.uid) as {parent_uid:string};
    expect(moved.parent_uid).toBe(n2.uid);
    s.close();
  });

  it('exportMarkdown dumps entries', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const a = s.entries.createEntry({ prefix: 'P', level_1: 'My Proj' });
    expect(exportMarkdown(s)).toContain('My Proj');
    s.close();
  });
});

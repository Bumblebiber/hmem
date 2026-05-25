import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { writeMemory } from '../../src/v2/writes.js';

describe('writeMemory', () => {
  it('creates an entry with tab-nested children', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label } = writeMemory(s, { prefix: 'P', content: 'Smoke Project\n\tOverview\n\tCodebase', tags: ['#smoke'] });
    expect(label).toMatch(/^P\d{4}$/);
    const uid = s.entries.labelToUid(label)!;
    const e = s.entries.getEntry(uid)!;
    expect(e.level_1).toBe('Smoke Project');
    const kids = s.db.prepare('SELECT content FROM nodes WHERE root_uid=? AND parent_uid IS NULL ORDER BY seq').all(uid) as {content:string}[];
    expect(kids.map(k => k.content)).toEqual(['Overview', 'Codebase']);
    s.close();
  });

  it('persists tags on the entry', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label } = writeMemory(s, { prefix: 'L', content: 'a lesson', tags: ['#x'] });
    const e = s.entries.getEntry(s.entries.labelToUid(label)!)!;
    expect(JSON.parse(e.tags ?? '[]')).toContain('#x');
    s.close();
  });

  it('nests grandchildren under the correct parent', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label } = writeMemory(s, { prefix: 'P', content: 'Root\n\tParent\n\t\tChild' });
    const uid = s.entries.labelToUid(label)!;
    const parent = s.db.prepare("SELECT uid FROM nodes WHERE root_uid=? AND parent_uid IS NULL AND content='Parent'").get(uid) as {uid:string};
    const child = s.db.prepare("SELECT parent_uid FROM nodes WHERE root_uid=? AND content='Child'").get(uid) as {parent_uid:string};
    expect(child.parent_uid).toBe(parent.uid);
    s.close();
  });
});

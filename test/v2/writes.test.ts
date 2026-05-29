import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { writeMemory, appendMemory, updateMemory } from '../../src/v2/writes.js';

describe('updateMemory — node irrelevant', () => {
  it('sets and clears irrelevant on a sub-node and bumps updated_at', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { uid, label } = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const n = s.entries.addNode({ root_uid: uid, content: 'a step' });
    const seq = (s.db.prepare('SELECT seq FROM nodes WHERE uid=?').get(n.uid) as { seq: number }).seq;
    s.db.prepare('UPDATE nodes SET updated_at=? WHERE uid=?').run('2026-01-01T00:00:00.000Z', n.uid);

    expect(updateMemory(s, `${label}.${seq}`, { irrelevant: true })).toBe(true);
    let row = s.db.prepare('SELECT irrelevant, updated_at FROM nodes WHERE uid=?').get(n.uid) as { irrelevant: number; updated_at: string };
    expect(row.irrelevant).toBe(1);
    expect(row.updated_at).not.toBe('2026-01-01T00:00:00.000Z'); // bumped so it syncs

    updateMemory(s, `${label}.${seq}`, { irrelevant: false });
    row = s.db.prepare('SELECT irrelevant FROM nodes WHERE uid=?').get(n.uid) as { irrelevant: number; updated_at: string };
    expect(row.irrelevant).toBe(0);
    s.close();
  });
});

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

describe('appendMemory', () => {
  it('adds children under an existing entry', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label } = writeMemory(s, { prefix: 'P', content: 'Proj' });
    appendMemory(s, label, 'New section\n\tdetail');
    const uid = s.entries.labelToUid(label)!;
    const tops = s.db.prepare('SELECT content FROM nodes WHERE root_uid=? AND parent_uid IS NULL ORDER BY seq').all(uid) as {content:string}[];
    expect(tops.map(t => t.content)).toContain('New section');
    const parent = s.db.prepare("SELECT uid FROM nodes WHERE root_uid=? AND content='New section'").get(uid) as {uid:string};
    const child = s.db.prepare("SELECT parent_uid FROM nodes WHERE root_uid=? AND content='detail'").get(uid) as {parent_uid:string};
    expect(child.parent_uid).toBe(parent.uid);
    s.close();
  });
});

describe('updateMemory', () => {
  it('sets the obsolete flag on an entry and bumps updated_at', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label } = writeMemory(s, { prefix: 'L', content: 'old lesson' });
    const uid = s.entries.labelToUid(label)!;
    const before = s.entries.getEntry(uid)!.updated_at;
    const ok = updateMemory(s, label, { obsolete: true });
    expect(ok).toBe(true);
    const e = s.entries.getEntry(uid)!;
    expect(e.obsolete).toBe(1);
    expect(e.updated_at >= before).toBe(true);
    s.close();
  });

  it('updates node content in place', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label } = writeMemory(s, { prefix: 'P', content: 'Proj\n\tOriginal' });
    updateMemory(s, `${label}.1`, { content: 'Revised' });
    const uid = s.entries.labelToUid(label)!;
    const n = s.db.prepare('SELECT content FROM nodes WHERE root_uid=? AND seq=1').get(uid) as {content:string};
    expect(n.content).toBe('Revised');
    s.close();
  });

  it('soft-deletes an entry when delete=true', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { label } = writeMemory(s, { prefix: 'L', content: 'gone' });
    const uid = s.entries.labelToUid(label)!;
    expect(updateMemory(s, label, { delete: true })).toBe(true);
    // getEntry filters deleted_at IS NULL, so query the DB directly to verify the tombstone
    const row = s.db.prepare('SELECT deleted_at FROM entries WHERE uid=?').get(uid) as {deleted_at: string|null};
    expect(row.deleted_at).toBeTruthy();
    s.close();
  });
});

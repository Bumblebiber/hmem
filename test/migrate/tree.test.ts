import { test, expect } from 'vitest';
import { mergeNodeText } from '../../src/migrate/tree.js';

test('mergeNodeText: identical title/content -> content', () => {
  expect(mergeNodeText('Overview', 'Overview')).toBe('Overview');
});
test('mergeNodeText: truncation title (content starts with title) -> content', () => {
  expect(mergeNodeText('Wiki at ~/vault — see', 'Wiki at ~/vault — see D0001 fully'))
    .toBe('Wiki at ~/vault — see D0001 fully');
});
test('mergeNodeText: distinct heading -> "title\\n\\ncontent"', () => {
  expect(mergeNodeText('Overview', 'Wiki at ~/vault')).toBe('Overview\n\nWiki at ~/vault');
});
test('mergeNodeText: empty title -> content; empty content -> title', () => {
  expect(mergeNodeText(null, 'body')).toBe('body');
  expect(mergeNodeText('only title', '')).toBe('only title');
});

import { openDb } from '../../src/store/db.js';
import { makeV1Fixture } from './fixture.js';
import { migrateTree } from '../../src/migrate/tree.js';

function freshV2() { return openDb(':memory:'); }

test('migrateTree copies non-O/non-F entries with preserved metadata + tags', () => {
  const v1 = makeV1Fixture(); const v2 = freshV2();
  migrateTree(v1, v2);
  const p = v2.prepare(`SELECT * FROM entries WHERE label='P0001'`).get() as any;
  expect(p).toBeTruthy();
  expect(p.prefix).toBe('P');
  expect(p.created_at).toBe('2026-01-01T00:00:00Z');
  expect(p.access_count).toBe(7);
  expect(p.favorite).toBe(1);
  expect(JSON.parse(p.tags).sort()).toEqual(['#demo', '#hmem']);
  // O- and F-roots are NOT entries:
  expect(v2.prepare(`SELECT COUNT(*) c FROM entries WHERE label LIKE 'O%' OR label LIKE 'F%'`).get())
    .toMatchObject({ c: 0 });
});

test('migrateTree copies nodes with merged text, parent_uid, and tags', () => {
  const v1 = makeV1Fixture(); const v2 = freshV2();
  const { labelToUid, nodeIdToUid } = migrateTree(v1, v2);
  const pUid = labelToUid.get('P0001')!;
  const overview = v2.prepare(`SELECT * FROM nodes WHERE uid=?`).get(nodeIdToUid.get('P0001.1')) as any;
  expect(overview.root_uid).toBe(pUid);
  expect(overview.parent_uid).toBeNull();                 // depth-2 -> NULL
  expect(overview.content).toBe('Overview\n\nWiki at ~/vault — see D0001');
  expect(JSON.parse(overview.tags)).toEqual(['#section']);
  const child = v2.prepare(`SELECT * FROM nodes WHERE uid=?`).get(nodeIdToUid.get('P0001.1.1')) as any;
  expect(child.parent_uid).toBe(nodeIdToUid.get('P0001.1')); // depth-3 -> parent node uid
  expect(child.content).toBe('Wiki at ~/vault — see D0001 fully'); // truncation merge
});

test('migrateTree builds a label->uid map for every migrated root', () => {
  const v1 = makeV1Fixture(); const v2 = freshV2();
  const { labelToUid } = migrateTree(v1, v2);
  expect(labelToUid.has('P0001')).toBe(true);
  expect(labelToUid.has('D0001')).toBe(true);
  expect(labelToUid.has('O0001')).toBe(false);            // O handled in Half B
});

import { migrateLinks } from '../../src/migrate/tree.js';

test('migrateLinks: resolvable label -> links row; O-id -> deferred; junk -> dangling', () => {
  const v1 = makeV1Fixture(); const v2 = freshV2();
  const maps = migrateTree(v1, v2);
  const res = migrateLinks(v1, v2, maps);

  // D0001 -> P0001 resolves to a links row
  const d = maps.labelToUid.get('D0001')!, p = maps.labelToUid.get('P0001')!;
  expect(v2.prepare(`SELECT COUNT(*) c FROM links WHERE src_uid=? AND dst_uid=?`).get(d, p))
    .toMatchObject({ c: 1 });

  // L0001 -> O0001.1.1 is an O-id ref: deferred, not a links row
  expect(res.oRefTargets).toContain('O0001.1.1');
  const l = maps.labelToUid.get('L0001')!;
  expect(v2.prepare(`SELECT COUNT(*) c FROM links WHERE src_uid=?`).get(l)).toMatchObject({ c: 0 });

  // E0001 -> Z9999 is dangling
  expect(res.dangling).toContainEqual({ src: 'E0001', dst: 'Z9999' });
});

test('migrateLinks resolves a link to a non-O sub-node (lossless cross-ref)', () => {
  const v1 = makeV1Fixture(); const v2 = freshV2();
  const maps = migrateTree(v1, v2);
  migrateLinks(v1, v2, maps);
  const d3 = maps.labelToUid.get('D0003')!;
  const nodeUid = maps.nodeIdToUid.get('P0001.1')!;
  expect(v2.prepare(`SELECT COUNT(*) c FROM links WHERE src_uid=? AND dst_uid=?`).get(d3, nodeUid))
    .toMatchObject({ c: 1 });
});

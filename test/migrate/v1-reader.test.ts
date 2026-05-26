import { test, expect } from 'vitest';
import { makeV1Fixture } from './fixture.js';
import { allRoots, nodesForRoot, tagsFor, parseLinks } from '../../src/migrate/v1-reader.js';

test('allRoots returns every memories row with flags + timestamps', () => {
  const db = makeV1Fixture();
  const roots = allRoots(db);
  const p = roots.find(r => r.id === 'P0001')!;
  expect(p.prefix).toBe('P');
  expect(p.access_count).toBe(7);
  expect(p.favorite).toBe(1);
  expect(p.created_at).toBe('2026-01-01T00:00:00Z');
});

test('nodesForRoot returns nodes ordered by depth then seq', () => {
  const db = makeV1Fixture();
  const ns = nodesForRoot(db, 'O0001');
  expect(ns.map(n => n.id)).toEqual(
    ['O0001.1', 'O0001.1.1', 'O0001.1.1.1', 'O0001.1.1.2']);
});

test('tagsFor reads entry and node tags', () => {
  const db = makeV1Fixture();
  expect(tagsFor(db, 'P0001').sort()).toEqual(['#demo', '#hmem']);
  expect(tagsFor(db, 'P0001.1')).toEqual(['#section']);
  expect(tagsFor(db, 'D0001')).toEqual([]);
});

test('parseLinks handles JSON arrays, null, and junk', () => {
  expect(parseLinks('["P0001","D0002"]')).toEqual(['P0001', 'D0002']);
  expect(parseLinks(null)).toEqual([]);
  expect(parseLinks('')).toEqual([]);
  expect(parseLinks('not json')).toEqual([]);
});

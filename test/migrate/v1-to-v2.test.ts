import { test, expect, beforeEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { openDb } from '../../src/store/db.js';
import { makeV1Fixture } from './fixture.js';
import { migrate } from '../../src/migrate/v1-to-v2.js';

const V1 = '/tmp/p3-v1.hmem', V2 = '/tmp/p3-v2.hmem';

beforeEach(() => { for (const f of [V1, V2, V1+'-wal', V1+'-shm', V2+'-wal', V2+'-shm']) if (existsSync(f)) rmSync(f); });

function writeV1() { const db = makeV1Fixture(V1); db.close(); }

test('dry-run produces a report and writes no out file', () => {
  writeV1();
  const r = migrate({ in: V1, out: V2, dryRun: true });
  expect(r.skipped).toBeUndefined();
  expect(r.report!.entriesByPrefix.P).toBe(1);
  expect(r.report!.eventsWritten).toBeGreaterThanOrEqual(3); // O0001 (2) + O0000 (1)
  expect(existsSync(V2)).toBe(false);
});

test('real run writes v2; o_redirects resolve; re-run is a no-op', () => {
  writeV1();
  const first = migrate({ in: V1, out: V2, dryRun: false });
  expect(existsSync(V2)).toBe(true);
  const v2 = openDb(V2);
  // D0002 prose "O0001.1.1" -> redirect to a real session
  const red = v2.prepare(`SELECT * FROM o_redirects WHERE old_id='O0001.1.1'`).get() as any;
  expect(red).toBeTruthy();
  expect(red.session_id).toBeTruthy();
  // every binding's project exists
  const orphanBindings = v2.prepare(`SELECT COUNT(*) c FROM session_bindings b
    LEFT JOIN entries e ON e.uid=b.project_uid WHERE e.uid IS NULL`).get() as any;
  expect(orphanBindings.c).toBe(0);
  v2.close();
  // idempotent
  const second = migrate({ in: V1, out: V2, dryRun: false });
  expect(second.skipped).toBe(true);
});

test('refuses same in/out path, and refuses overwriting a non-v2 store (spec: never mutate v1)', () => {
  writeV1();
  // same path -> throws before any write
  expect(() => migrate({ in: V1, out: V1, dryRun: false })).toThrow(/same path/);
  // pointing --out at an existing v1-shaped store -> refused
  const other = '/tmp/p3-v1b.hmem';
  if (existsSync(other)) rmSync(other);
  makeV1Fixture(other).close();
  expect(() => migrate({ in: V1, out: other, dryRun: false })).toThrow(/not a v2 store/);
});

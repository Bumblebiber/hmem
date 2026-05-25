import { test, expect } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDb } from '../../src/store/db.js';
import { migrate } from '../../src/migrate/v1-to-v2.js';

const FIX = '/tmp/v1-phase3-fixture.hmem';
const OUT = '/tmp/v1-phase3-out.hmem';
const run = existsSync(FIX) ? test : test.skip;

run('real-data migration: counts match, integrity holds, idempotent', () => {
  for (const f of [OUT, OUT + '-wal', OUT + '-shm']) if (existsSync(f)) rmSync(f);
  const v1 = new Database(FIX, { readonly: true });

  // v1 census of non-O/non-F roots (these are the entries that should be migrated)
  const v1NonO = (v1.prepare(
    `SELECT COUNT(*) c FROM memories WHERE prefix NOT IN ('O','F')`,
  ).get() as any).c;

  // v1 non-twin O-nodes (upper-bound sanity check for eventsWritten)
  const v1ONodes = (v1.prepare(
    `SELECT COUNT(*) c FROM memory_nodes n JOIN memories m ON m.id=n.root_id
     WHERE m.prefix='O' AND m.id NOT LIKE 'O9%'`,
  ).get() as any).c;
  v1.close();

  const res = migrate({ in: FIX, out: OUT, dryRun: false });
  expect(res.report).toBeTruthy();
  const r = res.report!;
  const v2 = openDb(OUT);

  // 1. every non-O/non-F root migrated to exactly one entry
  const v2Entries = (v2.prepare(`SELECT COUNT(*) c FROM entries`).get() as any).c;
  expect(v2Entries).toBe(v1NonO);

  // 2. twins skipped (Phase 0: collision twins found in the real store)
  expect(r.oRootsSkippedTwins.sort()).toEqual(['O90052', 'O90054', 'O90057']);

  // 3. events = max-depth raw-exchange nodes: a large fraction (but NOT all) of
  //    non-twin O-nodes. Dry-run observed: 8979 events.
  //    Lower bound is set safely below observed (> 8500) to allow minor store drift
  //    while still proving the migrator processed essentially all max-depth nodes.
  expect(r.eventsWritten).toBeGreaterThan(8500);
  expect(r.eventsWritten).toBeLessThanOrEqual(v1ONodes);

  // 4. INTEGRITY — these MUST be exact (do NOT weaken to make them pass):

  // 4a. Every event references a valid session
  expect(
    (v2.prepare(`SELECT COUNT(*) c FROM events e
      LEFT JOIN sessions s ON s.session_id=e.session_id WHERE s.session_id IS NULL`).get() as any).c,
  ).toBe(0);

  // 4b. Every session binding references a valid project entry
  expect(
    (v2.prepare(`SELECT COUNT(*) c FROM session_bindings b
      LEFT JOIN entries e ON e.uid=b.project_uid WHERE e.uid IS NULL`).get() as any).c,
  ).toBe(0);

  // 4c. Every o_redirect references a valid session
  expect(
    (v2.prepare(`SELECT COUNT(*) c FROM o_redirects o
      LEFT JOIN sessions s ON s.session_id=o.session_id WHERE s.session_id IS NULL`).get() as any).c,
  ).toBe(0);

  // 4d. Link resolution — non-O sub-node targets now resolve (lossless cross-refs, Goal #7)
  //     Observed post-fix: 597 resolved, 5 dangling (F-tombstone targets / genuinely-deleted refs).
  //     OLD (pre-fix): 583 resolved, 19 dangling — 14 valid sub-node refs were silently dropped.
  //     Bounds are intentionally slightly loose to avoid brittleness as the store grows.
  expect(r.linksResolved).toBeGreaterThan(590);
  expect(r.linksDangling.length).toBeLessThan(10);

  // 5. FTS populated by triggers on raw insert
  expect((v2.prepare(`SELECT COUNT(*) c FROM fts`).get() as any).c).toBeGreaterThan(0);
  expect((v2.prepare(`SELECT COUNT(*) c FROM events_fts`).get() as any).c).toBe(r.eventsWritten);

  // 6. a known entry survived with its label (label preserved 1:1 from v1 id)
  expect(v2.prepare(`SELECT uid FROM entries WHERE label='P0048'`).get()).toBeTruthy();

  v2.close();

  // 7. idempotent — re-running against an already-migrated out file returns skipped
  expect(migrate({ in: FIX, out: OUT, dryRun: false }).skipped).toBe(true);
});

/*
 * Historical-misrouting caveat (by design, not a bug):
 *
 * In the live v1 store, roughly 1,741 O-nodes were routed to the O0000 "unattributed"
 * bucket instead of a proper O-session-root. This happened because old harness code
 * lacked project attribution, so those nodes accrued no binding context.
 *
 * The migrator preserves this history exactly: those nodes become events under
 * unattributed sessions (sessions with no session_bindings row, counted in
 * r.unattributedSessions). No assertion attempts to re-attribute them — migration
 * faithfully carries forward v1's state, mistakes included. The `unattributedSessions`
 * field in the report surfaces the count for transparency, but correcting old
 * attribution is a future task, not a migration responsibility.
 */

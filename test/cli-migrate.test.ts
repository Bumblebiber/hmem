import { test, expect, beforeEach, vi } from 'vitest';
import {
  existsSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, copyFileSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { makeV1Fixture } from './migrate/fixture.js';
import { openDb } from '../src/store/db.js';
import { migratePlan, classify, type LockProbe } from '../src/cli-migrate.js';

const LIVE = '/tmp/cli-mig-live.hmem';
const OUTSIDE = '/tmp/cli-mig-out.hmem';

function clean(): void {
  const dir = dirname(LIVE);
  for (const f of readdirSync(dir)) {
    if (f.startsWith(basename(LIVE)) || f.startsWith(basename(OUTSIDE))) {
      try { rmSync(join(dir, f)); } catch { /* ignore */ }
    }
  }
}

function writeV1Live(path = LIVE): void {
  makeV1Fixture(path).close();
}

/** Default test injections: auto-confirm yes, no lock present, real validator. */
const yesConfirm = () => Promise.resolve(true);
const noConfirm = () => Promise.resolve(false);
const noLock: LockProbe = () => null;

/** Count files in /tmp that belong to the LIVE store family (live + sidecars + backups + tmp). */
function liveFamilyFiles(): string[] {
  const dir = dirname(LIVE);
  return readdirSync(dir).filter(f => f.startsWith(basename(LIVE)));
}

beforeEach(() => { clean(); });

// ---------------------------------------------------------------------------
// Test 8 (probe primitive) — listed first because classify drives everything.
// ---------------------------------------------------------------------------
test('classify: v1 fixture → v1, v2 file → v2, missing → missing, empty → ambiguous', () => {
  // missing
  expect(classify(LIVE)).toBe('missing');

  // v1 fixture (no schema_version table, has memories, no entries)
  writeV1Live();
  expect(classify(LIVE)).toBe('v1');
  rmSync(LIVE);

  // v2 store (openDb installs schema + schema_major=2)
  openDb(LIVE).close();
  expect(classify(LIVE)).toBe('v2');
  for (const f of [LIVE, LIVE + '-wal', LIVE + '-shm']) if (existsSync(f)) rmSync(f);

  // empty/ambiguous (neither memories nor entries)
  new Database(LIVE).close();
  expect(classify(LIVE)).toBe('ambiguous');
});

// ---------------------------------------------------------------------------
// Test 1 — Happy path (in-place swap).
// ---------------------------------------------------------------------------
test('happy path: in-place swap migrates LIVE to v2, keeps a backup', async () => {
  writeV1Live();
  const outcome = await migratePlan({
    in: LIVE, yes: true, confirm: yesConfirm, probeLock: noLock,
  });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.action).toBe('migrated');

  // stale v1 sidecars cleaned up: immediately after migrate (before any test-side
  // DB open re-creates them), no -wal/-shm linger next to LIVE.
  expect(existsSync(LIVE + '-wal')).toBe(false);
  expect(existsSync(LIVE + '-shm')).toBe(false);

  // backup exists and is a v1 store
  expect(outcome.backupPath).toBeTruthy();
  expect(existsSync(outcome.backupPath!)).toBe(true);
  const bk = new Database(outcome.backupPath!, { readonly: true });
  const bkTables = (bk.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as { name: string }[]).map(t => t.name);
  expect(bkTables).toContain('memories');
  expect(bkTables).not.toContain('entries');
  bk.close();

  // LIVE is now v2
  const v2 = new Database(LIVE, { readonly: true });
  const tables = (v2.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as { name: string }[]).map(t => t.name);
  expect(tables).toContain('entries');
  expect(tables).not.toContain('memories');
  const major = (v2.prepare(`SELECT value v FROM schema_version WHERE key='schema_major'`)
    .get() as { v: string }).v;
  expect(major).toBe('2');
  const mig = v2.prepare(`SELECT value v FROM schema_version WHERE key='v1_migration'`).get();
  expect(mig).toBeTruthy();
  expect((v2.pragma('integrity_check', { simple: true }))).toBe('ok');
  // migrator invariant: entries count === non-O/non-F roots (7 in the fixture)
  const entries = (v2.prepare(`SELECT COUNT(*) c FROM entries`).get() as { c: number }).c;
  expect(entries).toBe(7);
  v2.close();
});

// ---------------------------------------------------------------------------
// Test 2 — --dry-run touches nothing.
// ---------------------------------------------------------------------------
test('dry-run: prints report, touches nothing on disk', async () => {
  writeV1Live();
  const before = liveFamilyFiles().map(f => {
    const s = statSync(join(dirname(LIVE), f));
    return { f, size: s.size, mtime: s.mtimeMs };
  });
  const outcome = await migratePlan({
    in: LIVE, dryRun: true, yes: true, confirm: yesConfirm, probeLock: noLock,
  });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.action).toBe('dry-run');
  expect(outcome.report).toBeTruthy();

  // no new files (no backup, no temp)
  const after = liveFamilyFiles();
  expect(after.sort()).toEqual(before.map(b => b.f).sort());
  // byte-identical
  for (const b of before) {
    const s = statSync(join(dirname(LIVE), b.f));
    expect(s.size).toBe(b.size);
    expect(s.mtimeMs).toBe(b.mtime);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — Idempotent / already-v2.
// ---------------------------------------------------------------------------
test('idempotent: second run on a now-v2 store no-ops with exit 0 and no new backup', async () => {
  writeV1Live();
  const first = await migratePlan({ in: LIVE, yes: true, confirm: yesConfirm, probeLock: noLock });
  expect(first.action).toBe('migrated');
  const backupsAfterFirst = liveFamilyFiles().filter(f => f.includes('v1-backup'));
  expect(backupsAfterFirst.length).toBe(1);

  const second = await migratePlan({ in: LIVE, yes: true, confirm: yesConfirm, probeLock: noLock });
  expect(second.exitCode).toBe(0);
  expect(second.action).toBe('noop-already-v2');
  // no new backup created
  const backupsAfterSecond = liveFamilyFiles().filter(f => f.includes('v1-backup'));
  expect(backupsAfterSecond.length).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 4 — --in === --out refused (side-by-side mode, migrator same-path guard).
// ---------------------------------------------------------------------------
test('--in === --out refused; LIVE untouched', async () => {
  writeV1Live();
  const sizeBefore = statSync(LIVE).size;
  const outcome = await migratePlan({
    in: LIVE, out: LIVE, yes: true, confirm: yesConfirm, probeLock: noLock,
  });
  expect(outcome.exitCode).not.toBe(0);
  expect(outcome.action).toBe('failed');
  expect(outcome.message).toMatch(/same path/i);
  // LIVE still v1, unchanged size
  expect(classify(LIVE)).toBe('v1');
  expect(statSync(LIVE).size).toBe(sizeBefore);
});

// ---------------------------------------------------------------------------
// Test 5 — Mid-flight failure (validation rejects) → LIVE byte-identical, backup intact, TMP gone.
// ---------------------------------------------------------------------------
test('validation failure rolls back: LIVE byte-identical, TMP cleaned, backup kept, exit !=0', async () => {
  writeV1Live();
  const bytesBefore = readFileSync(LIVE);
  const outcome = await migratePlan({
    in: LIVE, yes: true, confirm: yesConfirm, probeLock: noLock,
    validate: () => { throw new Error('forced validation failure'); },
  });
  expect(outcome.exitCode).not.toBe(0);
  expect(outcome.action).toBe('failed');

  // LIVE byte-identical to the original v1 file
  expect(readFileSync(LIVE).equals(bytesBefore)).toBe(true);
  expect(classify(LIVE)).toBe('v1');

  // no leftover .tmp files
  expect(liveFamilyFiles().some(f => f.includes('.tmp'))).toBe(false);

  // backup was created and kept (the safety net survives)
  expect(outcome.backupPath).toBeTruthy();
  expect(existsSync(outcome.backupPath!)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 6 — --yes non-interactive: no confirm prompt is consulted.
// ---------------------------------------------------------------------------
test('--yes: completes without consulting the confirm prompt', async () => {
  writeV1Live();
  const confirm = vi.fn(() => Promise.resolve(true));
  const outcome = await migratePlan({ in: LIVE, yes: true, confirm, probeLock: noLock });
  expect(outcome.action).toBe('migrated');
  expect(confirm).not.toHaveBeenCalled();
});

test('interactive abort: confirm returns false → no migration, LIVE untouched, exit 0', async () => {
  writeV1Live();
  const bytesBefore = readFileSync(LIVE);
  const outcome = await migratePlan({ in: LIVE, yes: false, confirm: noConfirm, probeLock: noLock });
  expect(outcome.action).toBe('aborted');
  expect(outcome.exitCode).toBe(0);
  expect(readFileSync(LIVE).equals(bytesBefore)).toBe(true);
  expect(classify(LIVE)).toBe('v1');
  expect(liveFamilyFiles().some(f => f.includes('v1-backup'))).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 7 — Serve-lock refusal (fresh PID) / stale lock ignored.
// ---------------------------------------------------------------------------
test('fresh serve-lock → refuse with exit 2; LIVE untouched', async () => {
  writeV1Live();
  const bytesBefore = readFileSync(LIVE);
  const freshLock: LockProbe = () => ({ pid: process.pid, alive: true });
  const outcome = await migratePlan({ in: LIVE, yes: true, confirm: yesConfirm, probeLock: freshLock });
  expect(outcome.exitCode).toBe(2);
  expect(outcome.action).toBe('refused-locked');
  expect(readFileSync(LIVE).equals(bytesBefore)).toBe(true);
  expect(classify(LIVE)).toBe('v1');
  expect(liveFamilyFiles().some(f => f.includes('v1-backup'))).toBe(false);
});

test('stale serve-lock (dead PID) → proceeds with a warning', async () => {
  writeV1Live();
  const staleLock: LockProbe = () => ({ pid: 0x7fffffff, alive: false });
  const outcome = await migratePlan({ in: LIVE, yes: true, confirm: yesConfirm, probeLock: staleLock });
  expect(outcome.action).toBe('migrated');
  expect(outcome.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// Extra — side-by-side --out mode (the funnel db.ts advertises).
// ---------------------------------------------------------------------------
test('--out side-by-side: writes a separate v2 store, LIVE untouched, no backup/swap', async () => {
  writeV1Live();
  const bytesBefore = readFileSync(LIVE);
  const outcome = await migratePlan({
    in: LIVE, out: OUTSIDE, yes: true, confirm: yesConfirm, probeLock: noLock,
  });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.action).toBe('side-by-side');
  // LIVE untouched (still v1, byte-identical)
  expect(readFileSync(LIVE).equals(bytesBefore)).toBe(true);
  expect(classify(LIVE)).toBe('v1');
  // OUTSIDE is a v2 store
  expect(classify(OUTSIDE)).toBe('v2');
  // no backup created (side-by-side skips backup/swap)
  expect(liveFamilyFiles().some(f => f.includes('v1-backup'))).toBe(false);
});

// ---------------------------------------------------------------------------
// Classify-driven guards: missing & ambiguous.
// ---------------------------------------------------------------------------
test('missing store → exit 1 nothing-to-migrate', async () => {
  const outcome = await migratePlan({ in: LIVE, yes: true, confirm: yesConfirm, probeLock: noLock });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.action).toBe('noop-missing');
});

test('ambiguous store → refuse exit 1, untouched', async () => {
  new Database(LIVE).close();
  const bytesBefore = readFileSync(LIVE);
  const outcome = await migratePlan({ in: LIVE, yes: true, confirm: yesConfirm, probeLock: noLock });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.action).toBe('refused-ambiguous');
  expect(readFileSync(LIVE).equals(bytesBefore)).toBe(true);
});

/**
 * Script:    cli-migrate.ts
 * Purpose:   User-facing `hmem migrate` — safely upgrade a v1 (.hmem) store to v2.
 * Author:    DEVELOPER
 * Created:   2026-05-27
 *
 * Safety contract (see docs/.../2026-05-26-v2-hmem-migrate-command-plan.md §2):
 *   Until the single atomic rename in the swap step, LIVE is byte-for-byte the
 *   original. A timestamped backup (live + -wal/-shm sidecars, copied verbatim)
 *   is the safety net for the rename window and is ALWAYS kept.
 *
 * The migrator itself (./migrate/v1-to-v2.js) opens --in READ-ONLY and writes only
 * --out, so it never mutates the live file. This module orchestrates classify →
 * quiesce → confirm → backup → migrate-to-temp → validate → atomic-swap → verify.
 */

import {
  existsSync, copyFileSync, renameSync, readFileSync, rmSync,
} from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { migrate, type MigrationReport } from './migrate/v1-to-v2.js';
import { resolveHmemPath } from './hmem-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Classification = 'missing' | 'v1' | 'v2' | 'ambiguous';

export type MigrateAction =
  | 'migrated'            // in-place swap succeeded
  | 'side-by-side'        // --out mode: wrote a separate v2 store
  | 'dry-run'             // ran the migrator against :memory:, touched nothing
  | 'noop-already-v2'     // LIVE already schema_major=2
  | 'noop-missing'        // no store at the path
  | 'refused-locked'      // a live serve lockfile is present
  | 'refused-ambiguous'   // file is neither v1 nor v2
  | 'aborted'             // user declined the interactive confirm
  | 'failed';             // migrate/validate/swap error (LIVE intact, see message)

export interface MigrateOutcome {
  action: MigrateAction;
  exitCode: number;
  message: string;
  backupPath?: string;
  report?: MigrationReport;
}

/** Probe for a serve lockfile next to LIVE. Returns null if none, else {pid, alive}. */
export type LockProbe = (dir: string, livePath: string) => { pid: number; alive: boolean } | null;

/** Source counts captured before migration, passed to the validator for sanity checks. */
export interface SourceCounts { memories: number; memoryNodes: number; }

/** Validates the freshly-written TMP v2 store (read-only). Throws on any failure. */
export type Validator = (tmpPath: string, source: SourceCounts) => void;

export interface MigratePlanOpts {
  in: string;
  out?: string;
  dryRun?: boolean;
  yes?: boolean;
  keepBackup?: boolean;     // default-true no-op confirming flag (no --no-backup)
  confirm?: () => Promise<boolean>;
  probeLock?: LockProbe;
  validate?: Validator;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Read-only classification (NEVER openDb on a v1 file — that stamps it v2)
// ---------------------------------------------------------------------------

/**
 * Classify a store path WITHOUT mutating it. Opens read-only and inspects
 * sqlite_master + schema_version, mirroring openDb()'s precheck.
 */
export function classify(path: string): Classification {
  if (!existsSync(path)) return 'missing';
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as { name: string }[]).map(t => t.name);
    const hasEntries = tables.includes('entries');
    const hasMemories = tables.includes('memories');
    if (hasEntries) {
      const row = db.prepare(
        "SELECT value FROM schema_version WHERE key='schema_major'",
      ).get() as { value: string } | undefined;
      return row?.value === '2' ? 'v2' : 'ambiguous';
    }
    if (hasMemories) return 'v1';
    return 'ambiguous';
  } catch {
    return 'ambiguous';
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function sourceCounts(path: string): SourceCounts {
  const db = new Database(path, { readonly: true });
  try {
    const m = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
    const n = (db.prepare('SELECT COUNT(*) c FROM memory_nodes').get() as { c: number }).c;
    return { memories: m, memoryNodes: n };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Default validator (§2 step 6)
// ---------------------------------------------------------------------------

const defaultValidator: Validator = (tmpPath, source) => {
  const db = new Database(tmpPath, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity_check failed: ${integrity}`);

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as { name: string }[]).map(t => t.name);
    if (!tables.includes('entries')) throw new Error('migrated store is missing the `entries` table');
    if (tables.includes('memories')) throw new Error('migrated store still has the v1 `memories` table');

    const entries = (db.prepare('SELECT COUNT(*) c FROM entries').get() as { c: number }).c;
    if (entries <= 0) throw new Error('migrated store has 0 entries');

    const major = (db.prepare(
      "SELECT value v FROM schema_version WHERE key='schema_major'",
    ).get() as { v: string } | undefined)?.v;
    if (major !== '2') throw new Error(`migrated store schema_major=${major ?? 'null'} (expected 2)`);

    const mig = db.prepare(
      "SELECT value FROM schema_version WHERE key='v1_migration'",
    ).get();
    if (!mig) throw new Error('migrated store missing the v1_migration marker key');

    // Count sanity: entries should not exceed the v1 root count (memories rows).
    // The migrator's exact invariant (non-O/non-F roots) is asserted in
    // test/migrate/acceptance.test.ts; here we guard against gross loss/explosion.
    if (entries > source.memories) {
      throw new Error(`entries (${entries}) exceed source roots (${source.memories}) — unexpected`);
    }
  } finally {
    db.close();
  }
};

// ---------------------------------------------------------------------------
// Real serve-lockfile probe (Layer 1, §3)
// ---------------------------------------------------------------------------

const SERVE_LOCK_NAME = '.hmem.serve.lock';

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually signal
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but we can't signal it → still alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Default lock probe: read <dir>/.hmem.serve.lock and report PID liveness. */
export const defaultLockProbe: LockProbe = (dir) => {
  const lockPath = join(dir, SERVE_LOCK_NAME);
  if (!existsSync(lockPath)) return null;
  try {
    const data = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
    const pid = typeof data.pid === 'number' ? data.pid : -1;
    return { pid, alive: pidAlive(pid) };
  } catch {
    // Unparseable lockfile → treat as stale (don't block on garbage).
    return { pid: -1, alive: false };
  }
};

// ---------------------------------------------------------------------------
// Core (testable): migratePlan
// ---------------------------------------------------------------------------

function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export async function migratePlan(opts: MigratePlanOpts): Promise<MigrateOutcome> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const validate = opts.validate ?? defaultValidator;
  const probeLock = opts.probeLock ?? defaultLockProbe;
  const LIVE = resolve(opts.in);
  const dir = dirname(LIVE);

  // --- Step 1: resolve + classify (read-only) ---
  const klass = classify(LIVE);
  if (klass === 'missing') {
    return { action: 'noop-missing', exitCode: 1,
      message: `No hmem store at ${LIVE}. Nothing to migrate.` };
  }
  if (klass === 'v2') {
    return { action: 'noop-already-v2', exitCode: 0,
      message: `Already v2 (${LIVE}). Nothing to do.` };
  }
  if (klass === 'ambiguous') {
    return { action: 'refused-ambiguous', exitCode: 1,
      message: `Cannot classify ${LIVE} as a v1 or v2 hmem store (neither memories nor v2 entries table). Refusing to migrate.` };
  }
  // klass === 'v1' below.

  // --- --out side-by-side (advanced) mode: skip quiesce/backup/swap ---
  // We still run the confirm/dry-run gates? Per §4, --out just runs migrate({in,out}).
  // Dry-run is independent of --out: it always uses :memory:. Handle dry-run first.

  // --- Step: dry-run (touches nothing) ---
  if (opts.dryRun) {
    try {
      // same-path guard fires unconditionally in migrate(); pass a sentinel out so it
      // doesn't trip. dryRun routes the migrator to :memory:; `out` is otherwise unused.
      const sentinel = LIVE + '.dry-run-placeholder';
      const res = migrate({ in: LIVE, out: sentinel, dryRun: true });
      return { action: 'dry-run', exitCode: 0, report: res.report,
        message: 'Dry run complete — no files were changed.' };
    } catch (e) {
      return { action: 'failed', exitCode: 1, message: errMsg(e) };
    }
  }

  // --- Step 2: quiesce preflight (Layer 1 — serve lockfile) ---
  const lock = probeLock(dir, LIVE);
  if (lock && lock.alive) {
    return { action: 'refused-locked', exitCode: 2,
      message: `An hmem MCP server (PID ${lock.pid}) is using this store. ` +
        `Close Claude Code (or stop the server) and re-run \`hmem migrate\`.` };
  }
  if (lock && !lock.alive) {
    log(`[hmem migrate] Ignoring a stale serve lockfile (PID ${lock.pid} is not running).`);
  }

  // --- --out side-by-side mode: migrate({in,out}), no backup/swap ---
  if (opts.out) {
    const OUT = resolve(opts.out);
    // Layer 2 confirm (unless --yes) — still warn the user to quiesce.
    if (!opts.yes) {
      const ok = await runConfirm(opts.confirm, LIVE, OUT, /*sideBySide*/ true);
      if (!ok) return { action: 'aborted', exitCode: 0, message: 'Aborted by user.' };
    }
    try {
      const res = migrate({ in: LIVE, out: OUT, dryRun: false });
      if (res.skipped) {
        return { action: 'noop-already-v2', exitCode: 0,
          message: `${OUT} is already a migrated v2 store. Nothing to do.` };
      }
      // validate the side-by-side output too
      validate(OUT, sourceCounts(LIVE));
      return { action: 'side-by-side', exitCode: 0, report: res.report,
        message: `Wrote v2 store to ${OUT}. The original (${LIVE}) is unchanged.\n` +
          `Point HMEM_PATH at ${OUT} (or re-run \`hmem migrate\` in-place once ready).` };
    } catch (e) {
      return { action: 'failed', exitCode: 1, message: errMsg(e) };
    }
  }

  // --- In-place flow (§2 steps 2–9) ---

  // --- Step 3: confirm (unless --yes) ---
  if (!opts.yes) {
    const ok = await runConfirm(opts.confirm, LIVE, undefined, /*sideBySide*/ false);
    if (!ok) return { action: 'aborted', exitCode: 0, message: 'Aborted by user.' };
  }

  // --- Step 4: backup (copy LIVE + sidecars verbatim) ---
  const backupPath = `${LIVE}.v1-backup-${utcStamp()}`;
  try {
    copyFileSync(LIVE, backupPath);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(LIVE + ext)) copyFileSync(LIVE + ext, backupPath + ext);
    }
  } catch (e) {
    // backup failed → abort, LIVE untouched. Clean any partial backup.
    cleanup([backupPath, backupPath + '-wal', backupPath + '-shm']);
    return { action: 'failed', exitCode: 1,
      message: `Backup failed (${errMsg(e)}). LIVE is unchanged; nothing was migrated.` };
  }

  // --- Step 5: migrate to TMP ---
  const TMP = `${LIVE}.v2-migrating-${process.pid}-${Date.now()}.tmp`;
  let report: MigrationReport | undefined;
  try {
    const res = migrate({ in: LIVE, out: TMP, dryRun: false });
    if (res.skipped) {
      // Unexpected: classify said v1 but migrator found the marker. Treat as failure
      // (ROLLBACK A) — LIVE is untouched (migrate opens it read-only).
      cleanup([TMP, TMP + '-wal', TMP + '-shm']);
      return { action: 'failed', exitCode: 1, backupPath,
        message: 'Migrator unexpectedly reported the source as already-migrated. LIVE is unchanged; backup kept.' };
    }
    report = res.report;
  } catch (e) {
    cleanup([TMP, TMP + '-wal', TMP + '-shm']);
    return { action: 'failed', exitCode: 1, backupPath,
      message: `Migration failed (${errMsg(e)}). LIVE is unchanged (source was read-only); backup kept at ${backupPath}.` };
  }

  // --- Step 6: validate TMP (read-only) ---
  try {
    validate(TMP, sourceCounts(LIVE));
  } catch (e) {
    cleanup([TMP, TMP + '-wal', TMP + '-shm']);
    return { action: 'failed', exitCode: 1, backupPath,
      message: `Validation of the migrated store failed (${errMsg(e)}). ` +
        `LIVE is unchanged; backup kept at ${backupPath}.` };
  }

  // --- Step 7: atomic swap (renameSync) + delete stale v1 sidecars ---
  try {
    renameSync(TMP, LIVE);
  } catch (e) {
    // ROLLBACK B (Windows EBUSY etc.): TMP intact, LIVE intact.
    return { action: 'failed', exitCode: 2, backupPath,
      message: `Could not replace the live store (${errMsg(e)}). ` +
        `Close all tools using ${LIVE} and re-run. LIVE is unchanged; ` +
        `the migrated file is at ${TMP}; backup kept at ${backupPath}.` };
  }
  // Delete the now-stale -wal/-shm left over from the OLD v1 file (the new v2 file
  // creates its own on next open). Best-effort.
  cleanup([LIVE + '-wal', LIVE + '-shm']);

  // --- Step 8: post-swap verify ---
  // The v1 source is gone after the swap, so the count-sanity check has nothing to
  // compare against; pass a relaxed source so only the structural/integrity checks
  // run (these are what catch a corrupt swap). The exact count invariant was already
  // enforced against the real source in step 6.
  try {
    validate(LIVE, RELAXED_SOURCE_COUNTS);
  } catch (e) {
    // Should be impossible after step 6. Emergency restore from backup.
    try {
      copyFileSync(backupPath, LIVE);
      cleanup([LIVE + '-wal', LIVE + '-shm']);
      if (existsSync(backupPath + '-wal')) copyFileSync(backupPath + '-wal', LIVE + '-wal');
      if (existsSync(backupPath + '-shm')) copyFileSync(backupPath + '-shm', LIVE + '-shm');
    } catch { /* restore best-effort; backup still on disk for the user */ }
    return { action: 'failed', exitCode: 1, backupPath,
      message: `Post-swap verification failed (${errMsg(e)}). Restored from backup. ` +
        `Your backup is at ${backupPath}.` };
  }
  // The read-only verify above opens the WAL-mode db and leaves empty -wal/-shm
  // sidecars (a read-only connection can't delete them on close). They're freshly
  // created and contain no committed frames; remove them so a clean migrate leaves
  // exactly one file. The next real open recreates them as needed.
  cleanup([LIVE + '-wal', LIVE + '-shm']);

  // --- Step 9: report + keep backup ---
  return {
    action: 'migrated', exitCode: 0, backupPath, report,
    message: buildSuccessReport(LIVE, backupPath, report),
  };
}

/** Source counts that disable the count-sanity check (entries can never exceed this). */
const RELAXED_SOURCE_COUNTS: SourceCounts = {
  memories: Number.MAX_SAFE_INTEGER, memoryNodes: Number.MAX_SAFE_INTEGER,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function cleanup(paths: string[]): void {
  for (const p of paths) {
    try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ }
  }
}

async function runConfirm(
  confirm: (() => Promise<boolean>) | undefined,
  live: string,
  out: string | undefined,
  _sideBySide: boolean,
): Promise<boolean> {
  if (confirm) return confirm();
  return promptYesNo(live, out);
}

function buildSuccessReport(live: string, backupPath: string, report?: MigrationReport): string {
  const lines = [
    `✓ Migrated ${live} to the v2 schema.`,
    `  Backup (v1) kept at: ${backupPath}`,
  ];
  if (report) {
    const total = Object.values(report.entriesByPrefix).reduce((a, b) => a + b, 0);
    lines.push(`  Entries: ${total} | sessions: ${report.sessionsReconstructed} | events: ${report.eventsWritten}`);
    lines.push(`  Links resolved: ${report.linksResolved} | dangling: ${report.linksDangling.length}`);
  }
  lines.push('');
  lines.push('Your store is now v2. To sync it:');
  lines.push('  hmem sync push   # the first push uploads the full v2 store; later pushes are incremental.');
  lines.push('If you use multiple devices, run `hmem migrate` on each — until then, other devices cannot sync.');
  return lines.join('\n');
}

/** Default interactive double-confirm prompt (Layer 2, §3). Reads y/N from stdin. */
async function promptYesNo(live: string, out?: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(res => rl.question(q, ans => res(ans)));
  try {
    console.log('');
    console.log('Before migrating, fully QUIT Claude Code (and any other tool using this store).');
    console.log('Migration replaces the store file; a writer left open can lose data.');
    console.log(`  Source (v1):  ${live}`);
    if (out) console.log(`  Output (v2):  ${out} (the original stays unchanged)`);
    else console.log('  The live file will be replaced in place (a timestamped v1 backup is kept).');
    const a = (await ask(`Have you closed all tools using ${live}? [y/N] `)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry: runMigrate
// ---------------------------------------------------------------------------

export async function runMigrate(argv: string[]): Promise<void> {
  const getFlag = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const inPath = getFlag('--in') ?? resolveHmemPath();
  const outPath = getFlag('--out');
  const dryRun = argv.includes('--dry-run');
  const yes = argv.includes('--yes') || argv.includes('-y');
  const keepBackup = argv.includes('--keep-backup'); // default-true no-op confirming flag

  const outcome = await migratePlan({
    in: inPath, out: outPath, dryRun, yes, keepBackup,
  });

  if (outcome.exitCode === 0) {
    console.log(outcome.message);
  } else {
    console.error(outcome.message);
  }
  process.exit(outcome.exitCode);
}

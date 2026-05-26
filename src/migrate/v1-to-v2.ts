import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../store/db.js';
import { openV1 } from './v1-reader.js';
import { migrateTree, migrateLinks } from './tree.js';
import { decomposeORoots, Decomposition } from './o-decompose.js';

export interface MigrationReport {
  entriesByPrefix: Record<string, number>;
  sessionsReconstructed: number;
  unattributedSessions: number;
  eventsWritten: number;
  linksResolved: number;
  linksDangling: { src: string; dst: string }[];
  oRootsSkippedTwins: string[];
  emptyORoots: string[];
  oRedirectsWritten: number;
  unresolvedORefs: string[];
}
export interface MigrateOpts { in: string; out: string; dryRun: boolean }
export interface MigrateResult { skipped?: true; report?: MigrationReport }

function writeORedirects(
  v2: Database.Database, deco: Decomposition, linkORefs: string[],
): { written: number; unresolved: string[] } {
  // collect prose O-refs from migrated entries + nodes
  const refs = new Set<string>(linkORefs);
  const entryText = v2.prepare(`SELECT level_1 t FROM entries`).all() as { t: string }[];
  const nodeText = v2.prepare(`SELECT content t FROM nodes`).all() as { t: string }[];
  for (const { t } of [...entryText, ...nodeText]) {
    for (const m of (t || '').matchAll(/O\d{4}(?:\.\d+)*/g)) refs.add(m[0]);
  }
  const ins = v2.prepare(`INSERT OR IGNORE INTO o_redirects (old_id,session_id,from_seq,to_seq)
    VALUES (?,?,?,?)`);
  let written = 0; const unresolved: string[] = [];
  for (const id of refs) {
    const loc = deco.oNodeToLoc[id];
    if (!loc) { unresolved.push(id); continue; }
    ins.run(id, loc.session_id, loc.seq, loc.seq);
    written++;
  }
  return { written, unresolved };
}

export function migrate(opts: MigrateOpts): MigrateResult {
  // SPEC CONTRACT: never mutate v1. Refuse same path, and refuse an --out that
  // exists but is not already a v2 store (e.g. the live v1 file). openDb() would
  // otherwise inject v2 tables into a v1 file and corrupt it.
  if (resolve(opts.in) === resolve(opts.out))
    throw new Error('refuse: --in and --out resolve to the same path');
  if (!opts.dryRun && existsSync(opts.out)) {
    const probe = new Database(opts.out, { readonly: true });
    const tables = (probe.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[]).map(t => t.name);
    let isV2 = false;
    if (tables.includes('schema_version')) {
      const row = probe.prepare(`SELECT value FROM schema_version WHERE key='schema_major'`)
        .get() as { value: string } | undefined;
      isV2 = row?.value === '2';
    }
    probe.close();
    if (tables.length > 0 && !isV2)
      throw new Error(`refuse: ${opts.out} exists and is not a v2 store (refusing to overwrite)`);
  }

  const v1 = openV1(opts.in);
  try {
    // idempotency guard (only meaningful for a real out file)
    if (!opts.dryRun) {
      const probe = openDb(opts.out);                    // creates schema if new
      const marked = probe.prepare(`SELECT value FROM schema_version WHERE key='v1_migration'`).get();
      if (marked) { probe.close(); return { skipped: true }; }
      probe.close();
    }
    const v2 = openDb(opts.dryRun ? ':memory:' : opts.out);

    const report = v2.transaction((): MigrationReport => {
      const maps = migrateTree(v1, v2);
      const links = migrateLinks(v1, v2, maps);
      const deco = decomposeORoots(v1, v2, maps);
      const red = writeORedirects(v2, deco, links.oRefTargets);

      v2.prepare(`INSERT OR REPLACE INTO schema_version (key,value) VALUES ('v1_migration',?)`)
        .run(new Date().toISOString());

      const byPrefix: Record<string, number> = {};
      for (const row of v2.prepare(`SELECT prefix, COUNT(*) c FROM entries GROUP BY prefix`).all() as any[])
        byPrefix[row.prefix] = row.c;

      return {
        entriesByPrefix: byPrefix,
        sessionsReconstructed: deco.sessionsReconstructed,
        unattributedSessions: deco.unattributedSessions,
        eventsWritten: deco.eventsWritten,
        linksResolved: links.resolved,
        linksDangling: links.dangling,
        oRootsSkippedTwins: deco.skippedTwins,
        emptyORoots: deco.emptyORoots,
        oRedirectsWritten: red.written,
        unresolvedORefs: red.unresolved,
      };
    })();

    if (opts.dryRun) { v2.close(); printReport(report); }
    else v2.close();
    return { report };
  } finally { v1.close(); }
}

function printReport(r: MigrationReport): void {
  const lines = [
    '=== hmem v1 -> v2 migration (DRY RUN) ===',
    `entries by prefix: ${JSON.stringify(r.entriesByPrefix)}`,
    `sessions reconstructed: ${r.sessionsReconstructed} (unattributed: ${r.unattributedSessions})`,
    `events written: ${r.eventsWritten}`,
    `links resolved: ${r.linksResolved} | dangling: ${r.linksDangling.length}`,
    `O twins skipped: ${r.oRootsSkippedTwins.join(', ') || '—'}`,
    `empty O-roots: ${r.emptyORoots.join(', ') || '—'}`,
    `o_redirects written: ${r.oRedirectsWritten} | unresolved O-refs: ${r.unresolvedORefs.length}`,
  ];
  console.log(lines.join('\n'));
}

// Runnable entry: `npx tsx src/migrate/v1-to-v2.ts --in <v1> --out <v2> [--dry-run]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const inPath = get('--in'); const outPath = get('--out');
  if (!inPath || !outPath) { console.error('usage: --in <v1.hmem> --out <v2.hmem> [--dry-run]'); process.exit(1); }
  const res = migrate({ in: inPath, out: outPath, dryRun: args.includes('--dry-run') });
  if (res.skipped) console.log('already migrated — no-op.');
}

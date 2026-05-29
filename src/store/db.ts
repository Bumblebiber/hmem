/**
 * hmem v2 — database connection, schema bootstrap, and migrations runner.
 *
 * Opens a better-sqlite3 handle in WAL mode, instantiates the locked v2 schema
 * (`schema-v2.sql`) on first open, stamps `schema_version.schema_major = '2'`
 * (Phase 6 sync gates push/pull on this value), and runs an append-only list of
 * forward migrations idempotently (mirrors v1's `schema_version`-keyed pattern).
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema-v2.sql');

/**
 * Append-only forward migrations applied after the base schema. NEVER reorder or
 * delete an entry — each is keyed `v2_alter_<index>` in schema_version and only
 * runs once. Idempotent: duplicate-column / already-exists errors are tolerated.
 */
const MIGRATIONS: string[] = [
  // Phase 2 (v2_alter_1): cadence + node-pointer state for the live summarizer.
  // One row per binding segment keyed (session_id, from_seq); `node_uid` points at
  // the rolling-summary node under the segment's project, `last_summarized_seq`
  // tracks how far that summary has consumed the segment.
  `CREATE TABLE IF NOT EXISTS segment_summaries (
     session_id          TEXT NOT NULL,
     from_seq            INTEGER NOT NULL,
     node_uid            TEXT,
     last_summarized_seq INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_id, from_seq)
   )`,
  // Phase 2 (v2_alter_2): a SEPARATE contentless FTS index for raw events. Events
  // are ~75% of the store, so keeping them out of the curated `fts` keeps entry/node
  // search lean — event search is opt-in. Events are immutable, so unlike the
  // curated index this needs only an AFTER-INSERT trigger (no update/delete sync).
  `CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(content, content='', contentless_delete=1, tokenize='unicode61');
   CREATE TABLE IF NOT EXISTS events_fts_map (fts_rowid INTEGER PRIMARY KEY, event_uid TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
     INSERT INTO events_fts(content) VALUES (coalesce(new.content, ''));
     INSERT INTO events_fts_map(fts_rowid, event_uid) VALUES (last_insert_rowid(), new.event_uid);
   END`,
  // Phase 3 (v2_alter_3): entries.tags for lossless v1->v2 tag migration. On fresh
  // files the column is already in schema-v2.sql, so this ALTER throws
  // "duplicate column" — which runMigrations() already tolerates.
  `ALTER TABLE entries ADD COLUMN tags TEXT`,
  // Phase 5 (v2_alter_4): sessions.cwd is the workspace key for last-active-for-workspace
  // binding resolution. On fresh files the column is already in schema-v2.sql, so this
  // ALTER throws "duplicate column" — which runMigrations() tolerates.
  `ALTER TABLE sessions ADD COLUMN cwd TEXT`,
  // Phase 5 (v2_alter_5): index sessions(cwd) for the hot-path workspace-binding query
  // (lastProjectForWorkspace). On fresh files the index is already in schema-v2.sql, so
  // IF NOT EXISTS makes this a no-op — belt-and-suspenders over the runner's /already exists/ guard.
  `CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd)`,
  // Chunk 2 (v2_alter_6): sessions.irrelevant — boolean (0=visible, 1=hidden from "Recent
  // Sessions"). Set by the extractor, read by the display filter. On fresh files the column
  // is already in schema-v2.sql, so this ALTER throws "duplicate column" — which
  // runMigrations() already tolerates.
  `ALTER TABLE sessions ADD COLUMN irrelevant INTEGER NOT NULL DEFAULT 0`,
  // Chunk 2 (v2_alter_7): segment_extractions — per-segment extraction-cadence marker, kept
  // SEPARATE from segment_summaries (which the always-on summarizer owns). One row per binding
  // segment keyed (session_id, from_seq); `last_extracted_seq` tracks how far the extractor
  // has consumed the segment.
  `CREATE TABLE IF NOT EXISTS segment_extractions (
     session_id          TEXT NOT NULL,
     from_seq            INTEGER NOT NULL,
     last_extracted_seq  INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_id, from_seq)
   )`,
  // (v2_alter_8): nodes.irrelevant — boolean (0=visible, 1=hidden from broad reads:
  // load_project + read_memory on a parent entry). The render filter (read-render
  // childrenOf) honours it; show_all bypasses. Mirrors entries.irrelevant /
  // sessions.irrelevant. On fresh files the column is already in schema-v2.sql, so this
  // ALTER throws "duplicate column" — which runMigrations() already tolerates.
  // SYNC NOTE: emitting this new column to a device that predates it would wedge its
  // import — guarded by the column-tolerant upsert() shipped first (sync/v2/import.ts).
  `ALTER TABLE nodes ADD COLUMN irrelevant INTEGER NOT NULL DEFAULT 0`,
];

/**
 * Thrown by openDb() when asked to open an existing **v1** store
 * (`memories`/`memory_nodes`). The v2 open path must never v2-stamp such a file —
 * doing so injects empty v2 tables next to the real v1 data and corrupts it into
 * an unreadable hybrid (v2 reads query `entries`, see 0 rows; real data sits unread
 * in `memories`). Symmetric corruption-prevention dual of HmemStore's v2-file guard
 * (commit 44fd3dc). Callers that can tolerate a v1 file (hooks, the MCP tool boundary)
 * catch this and no-op / surface a "run `hmem migrate`" hint; others let it propagate
 * as a clear fatal.
 */
export class V1FileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V1FileError';
  }
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('busy_timeout = 5000');

  // Table-presence probes BEFORE any CREATE/INSERT (and before enabling WAL) drive
  // a three-way branch. Probing in the default journal mode means the refuse branch
  // below leaves NO `-wal`/`-shm` sidecars on a rejected v1 file.
  const hasEntries = db // v2 marker (the table v2 reads key on; part of base schema)
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
    .get();
  // `memories` is the canonical v1 root table — only v1 stores ever create it.
  // Do NOT reuse this name in future schema work; the guard keys on its presence.
  const hasMemories = db // v1 marker
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
    .get();

  // (b) Existing v1 file — REFUSE. Close the handle BEFORE throwing (and before WAL
  // was ever enabled) so no `-wal`/`-shm` sidecars land on the user's file (mirror 44fd3dc).
  if (!hasEntries && hasMemories) {
    db.close();
    throw new V1FileError(
      `openDb refusing to v2-init an existing v1 store at ${path}. ` +
        `This is a v1 (memories/memory_nodes) file; run: ` +
        `hmem migrate --in ${path} --out <new-v2-path>`,
    );
  }

  db.pragma('journal_mode = WAL');

  // (a) Fresh / empty file — install the locked v2 schema.
  if (!hasEntries) {
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  }

  // (a) + (c) idempotent stamp + forward migrations (heals a half-initialized v2 file).
  db.prepare(
    "INSERT OR IGNORE INTO schema_version(key, value) VALUES('schema_major', '2')",
  ).run();

  runMigrations(db);
  return db;
}

export function getSchemaMajor(db: Database.Database): string | null {
  // Tolerate a missing `schema_version` table (e.g. a brand-new/empty file, or a
  // v1 store before its schema is installed) — same sqlite_master precheck pattern
  // openDb() uses for the `entries` table. Without this the SELECT below throws
  // "no such table: schema_version".
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (!hasTable) return null;
  const row = db
    .prepare("SELECT value FROM schema_version WHERE key='schema_major'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function runMigrations(db: Database.Database): void {
  const applied = (key: string) =>
    db.prepare('SELECT 1 FROM schema_version WHERE key=?').get(key) !== undefined;
  const mark = db.prepare('INSERT OR IGNORE INTO schema_version(key, value) VALUES(?, ?)');

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const key = `v2_alter_${i + 1}`;
    if (applied(key)) continue;
    try {
      db.exec(MIGRATIONS[i]);
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      // Tolerate idempotent re-runs (column/index already present).
      if (!/duplicate column|already exists/i.test(msg)) throw err;
    }
    mark.run(key, new Date().toISOString());
  }
}

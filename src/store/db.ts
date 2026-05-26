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
];

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const hasSchema = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
    .get();
  if (!hasSchema) {
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  }

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

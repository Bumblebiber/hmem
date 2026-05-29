import { describe, it, test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, getSchemaMajor, runMigrations } from '../../src/store/db.js';

describe('db', () => {
  it('creates all v2 tables + fts shadow + rowid map', () => {
    const db = openDb(':memory:');
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      'entries', 'nodes', 'links', 'sessions', 'session_bindings',
      'events', 'o_redirects', 'schema_version', 'fts_rowid_map',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('sets schema_major=2', () => {
    const db = openDb(':memory:');
    expect(getSchemaMajor(db)).toBe('2');
  });

  it('is idempotent on reopen of a real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmem-db-'));
    const path = join(dir, 'test.hmem');
    const db1 = openDb(path);
    db1.prepare(
      "INSERT INTO entries(uid,label,prefix,seq,level_1,created_at,updated_at) VALUES('u1','P0001','P',1,'x','t','t')",
    ).run();
    db1.close();
    const db2 = openDb(path); // must not throw on existing schema
    expect(
      (db2.prepare("SELECT label FROM entries WHERE uid='u1'").get() as { label: string }).label,
    ).toBe('P0001');
    expect(getSchemaMajor(db2)).toBe('2');
  });

  it('runs Phase-2 migrations: segment_summaries exists, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmem-mig-'));
    const path = join(dir, 'test.hmem');
    const db1 = openDb(path);
    const tables = () =>
      (db1.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]).map((r) => r.name);
    expect(tables()).toContain('segment_summaries');
    db1.close();
    const db2 = openDb(path); // re-running MIGRATIONS must not throw
    expect(
      (db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='segment_summaries'").get() as
        | { name: string }
        | undefined)?.name,
    ).toBe('segment_summaries');
  });

  it('FTS triggers index inserted content', () => {
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO entries(uid,label,prefix,seq,level_1,created_at,updated_at) VALUES('u2','P0001','P',1,'narwhal title','t','t')",
    ).run();
    const hit = db
      .prepare("SELECT m.root_uid FROM fts JOIN fts_rowid_map m ON m.fts_rowid=fts.rowid WHERE fts MATCH 'narwhal'")
      .get() as { root_uid: string } | undefined;
    expect(hit?.root_uid).toBe('u2');
  });
});

test('entries table has a tags column (v2_alter_3)', () => {
  const db = openDb(':memory:');
  const cols = db.prepare(`PRAGMA table_info(entries)`).all() as { name: string }[];
  expect(cols.map(c => c.name)).toContain('tags');
});

test('v2_alter_3 ALTER path: tags column added to a pre-Phase-3 entries table', () => {
  // Build a synthetic pre-Phase-3 database: entries table WITHOUT tags, and
  // schema_version marking only v2_alter_1 and v2_alter_2 as applied.
  const dir = mkdtempSync(join(tmpdir(), 'hmem-alter3-'));
  const path = join(dir, 'test.hmem');
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE entries (uid TEXT PRIMARY KEY, label TEXT);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_uid TEXT);
    CREATE TABLE nodes (uid TEXT PRIMARY KEY);
    CREATE TABLE schema_version (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO schema_version(key, value) VALUES ('schema_major', '2');
    INSERT INTO schema_version(key, value) VALUES ('v2_alter_1', 'applied');
    INSERT INTO schema_version(key, value) VALUES ('v2_alter_2', 'applied');
  `);
  // Confirm tags is absent before migration runs.
  const colsBefore = raw.prepare('PRAGMA table_info(entries)').all() as { name: string }[];
  expect(colsBefore.map(c => c.name)).not.toContain('tags');
  // Run the migration runner — v2_alter_3 must execute the ALTER.
  runMigrations(raw);
  // Confirm tags is present after migration.
  const colsAfter = raw.prepare('PRAGMA table_info(entries)').all() as { name: string }[];
  expect(colsAfter.map(c => c.name)).toContain('tags');
  raw.close();
});

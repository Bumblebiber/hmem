import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getSchemaMajor } from '../../src/store/db.js';

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

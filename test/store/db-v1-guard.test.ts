/**
 * v1-file guard for the v2 open path. Mirror of test/hmem-store-v2-guard.test.ts
 * (the v1-side guard, commit 44fd3dc): there HmemStore refuses a v2 file; here
 * openDb() refuses a v1 file. openDb() must NEVER v2-stamp an existing v1
 * (memories/memory_nodes) store — doing so injects empty v2 tables next to the
 * real v1 data, so v2 reads see 0 rows and the user's memory "vanishes".
 *
 * Uses mkdtemp dirs (never ~/.hmem) and asserts no -wal/-shm sidecars leak onto
 * a refused v1 file.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, getSchemaMajor, V1FileError } from '../../src/store/db.js';
import { makeV1Fixture } from '../migrate/fixture.js';

function tmpPath(name = 'test.hmem'): string {
  return join(mkdtempSync(join(tmpdir(), 'hmem-v1guard-')), name);
}

describe('openDb v1-file guard', () => {
  it('(b) refuses an existing v1 file with a V1FileError pointing at hmem migrate', () => {
    const path = tmpPath();
    makeV1Fixture(path).close();

    expect(() => openDb(path)).toThrow(V1FileError);
    expect(() => openDb(path)).toThrow(/v1/);
    expect(() => openDb(path)).toThrow(/hmem migrate/);
    // Path is named in the message.
    expect(() => openDb(path)).toThrow(path);
  });

  it('(b) leaves the refused v1 file uncorrupted — no entries table, no stamp, no sidecars', () => {
    const path = tmpPath();
    makeV1Fixture(path).close();

    expect(() => openDb(path)).toThrow(V1FileError);

    // No v2 schema was injected, no schema_major stamped, v1 data intact.
    const probe = new Database(path, { readonly: true });
    try {
      const entries = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
        .get();
      expect(entries).toBeUndefined();
      expect(getSchemaMajor(probe)).toBeNull();
      const mem = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
        .get();
      expect(mem).toBeDefined();
      const root = probe
        .prepare("SELECT prefix FROM memories WHERE id='P0001'")
        .get() as { prefix: string } | undefined;
      expect(root?.prefix).toBe('P');
    } finally {
      probe.close();
    }

    // No WAL/SHM sidecars materialized on the rejected file (db.close() before throw).
    expect(existsSync(path + '-wal')).toBe(false);
    expect(existsSync(path + '-shm')).toBe(false);
  });

  it('(a) still creates a fresh v2 store on a non-existent path', () => {
    const path = tmpPath();
    const db = openDb(path);
    try {
      expect(getSchemaMajor(db)).toBe('2');
      const entries = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
        .get();
      expect(entries).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('(a) still works on :memory:', () => {
    const db = openDb(':memory:');
    try {
      expect(getSchemaMajor(db)).toBe('2');
    } finally {
      db.close();
    }
  });

  it('(c) reopens an existing v2 file idempotently, data survives', () => {
    const path = tmpPath();
    const db1 = openDb(path);
    db1
      .prepare(
        "INSERT INTO entries(uid,label,prefix,seq,level_1,created_at,updated_at) VALUES('u1','P0001','P',1,'x','t','t')",
      )
      .run();
    db1.close();

    const db2 = openDb(path);
    try {
      expect(getSchemaMajor(db2)).toBe('2');
      const row = db2.prepare("SELECT label FROM entries WHERE uid='u1'").get() as
        | { label: string }
        | undefined;
      expect(row?.label).toBe('P0001');
    } finally {
      db2.close();
    }
  });

  it('(d) heals a v2 file that has entries but a missing schema_major stamp', () => {
    const path = tmpPath();
    // Full v2 schema, then drop the stamp to simulate a half-initialized v2 file.
    const seed = openDb(path);
    seed.prepare("DELETE FROM schema_version WHERE key='schema_major'").run();
    seed.close();

    const db = openDb(path);
    try {
      expect(getSchemaMajor(db)).toBe('2'); // re-stamped, not refused
    } finally {
      db.close();
    }
  });
});

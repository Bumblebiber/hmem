// test/store/sessions-cwd.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, runMigrations } from '../../src/store/db.js';

describe('sessions.cwd column', () => {
  it('exists on a fresh db', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('cwd');
    db.close();
  });

  it('runMigrations is idempotent on re-run (no throw, cwd still present)', () => {
    const db = openDb(':memory:');
    expect(() => runMigrations(db)).not.toThrow(); // second pass
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('cwd');
    db.close();
  });

  it('v2_alter_4 ALTER path: cwd column added to a pre-Phase-5 sessions table', () => {
    // Build a synthetic pre-Phase-5 database: sessions table WITHOUT cwd, and
    // schema_version marking v2_alter_1 through v2_alter_3 (and schema_major) as
    // applied — so runMigrations skips them and runs ONLY v2_alter_4 (the ALTER).
    const dir = mkdtempSync(join(tmpdir(), 'hmem-alter4-'));
    const path = join(dir, 'test.hmem');
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_uid TEXT);
      CREATE TABLE schema_version (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO schema_version(key, value) VALUES ('schema_major', '2');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_1', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_2', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_3', 'applied');
    `);
    // Confirm cwd is absent before migration runs.
    const colsBefore = raw.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    expect(colsBefore.map(c => c.name)).not.toContain('cwd');
    // Run the migration runner — v2_alter_4 must execute the ALTER.
    runMigrations(raw);
    // Confirm cwd is present after migration.
    const colsAfter = raw.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    expect(colsAfter.map(c => c.name)).toContain('cwd');
    raw.close();
  });
});

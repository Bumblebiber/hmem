/**
 * Chunk 2 schema additions:
 *   - `segment_extractions` table (per-segment extraction-cadence marker)
 *   - `sessions.irrelevant` column (boolean: 0=visible, 1=hidden from "Recent Sessions")
 *
 * Covers both fresh (openDb on a new path) and migrated (synthetic pre-Chunk-2 db)
 * paths, plus idempotency (reopen without throw).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, runMigrations } from '../../src/store/db.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function tempPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return join(dir, 'test.hmem');
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name);
}

function tableExists(db: Database.Database, name: string): boolean {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) !== undefined;
}

// ── Fresh-install path ────────────────────────────────────────────────────────

describe('Chunk 2 — fresh install (openDb on a new file)', () => {
  it('segment_extractions table exists', () => {
    const db = openDb(tempPath('hmem-c2-fresh-'));
    try {
      expect(tableExists(db, 'segment_extractions')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('segment_extractions has exactly the expected columns', () => {
    const db = openDb(tempPath('hmem-c2-cols-'));
    try {
      const cols = columnNames(db, 'segment_extractions');
      expect(cols).toContain('session_id');
      expect(cols).toContain('from_seq');
      expect(cols).toContain('last_extracted_seq');
    } finally {
      db.close();
    }
  });

  it('sessions table has an irrelevant column', () => {
    const db = openDb(tempPath('hmem-c2-irrel-'));
    try {
      expect(columnNames(db, 'sessions')).toContain('irrelevant');
    } finally {
      db.close();
    }
  });
});

// ── Idempotency (reopen same file) ────────────────────────────────────────────

describe('Chunk 2 — idempotency (reopen same file twice)', () => {
  it('second openDb does not throw and both additions survive', () => {
    const path = tempPath('hmem-c2-idem-');
    const db1 = openDb(path);
    db1.close();

    // Must not throw on second open.
    const db2 = openDb(path);
    try {
      expect(tableExists(db2, 'segment_extractions')).toBe(true);
      expect(columnNames(db2, 'sessions')).toContain('irrelevant');
    } finally {
      db2.close();
    }
  });
});

// ── nodes.irrelevant (v2_alter_8) ─────────────────────────────────────────────

describe('nodes.irrelevant — fresh install', () => {
  it('nodes table has an irrelevant column with default 0', () => {
    const db = openDb(tempPath('hmem-nodeirr-fresh-'));
    try {
      expect(columnNames(db, 'nodes')).toContain('irrelevant');
    } finally {
      db.close();
    }
  });
});

describe('nodes.irrelevant — v2_alter_8 ALTER path on a pre-existing store', () => {
  it('runMigrations adds nodes.irrelevant to a store missing it', () => {
    const path = tempPath('hmem-alter8-');
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE nodes (uid TEXT PRIMARY KEY, root_uid TEXT, content TEXT, updated_at TEXT);
      CREATE TABLE schema_version (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO schema_version(key, value) VALUES ('schema_major', '2');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_1', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_2', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_3', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_4', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_5', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_6', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_7', 'applied');
    `);
    expect(columnNames(raw, 'nodes')).not.toContain('irrelevant');
    runMigrations(raw);
    expect(columnNames(raw, 'nodes')).toContain('irrelevant');
    expect(raw.prepare("SELECT 1 FROM schema_version WHERE key='v2_alter_8'").get()).toBeTruthy();
    raw.close();
  });
});

// ── Migrated-existing-store path (ALTER path for irrelevant) ─────────────────

describe('Chunk 2 — v2_alter_6 ALTER path: irrelevant added to pre-Chunk-2 sessions', () => {
  it('runMigrations adds sessions.irrelevant to a store missing it', () => {
    // Synthetic pre-Chunk-2 database: sessions WITHOUT irrelevant, and
    // schema_version marking v2_alter_1 through v2_alter_5 as applied —
    // so runMigrations skips them and runs only v2_alter_6 and v2_alter_7.
    const path = tempPath('hmem-alter6-');
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_uid TEXT, cwd TEXT);
      CREATE TABLE nodes (uid TEXT PRIMARY KEY);
      CREATE TABLE schema_version (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO schema_version(key, value) VALUES ('schema_major', '2');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_1', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_2', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_3', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_4', 'applied');
      INSERT INTO schema_version(key, value) VALUES ('v2_alter_5', 'applied');
    `);
    // Confirm irrelevant is absent before migrations.
    const colsBefore = columnNames(raw, 'sessions');
    expect(colsBefore).not.toContain('irrelevant');

    runMigrations(raw);

    // Confirm irrelevant and segment_extractions are present after migrations.
    expect(columnNames(raw, 'sessions')).toContain('irrelevant');
    expect(tableExists(raw, 'segment_extractions')).toBe(true);
    raw.close();
  });
});

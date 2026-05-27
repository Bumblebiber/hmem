/**
 * Test #5 — v2-checkpoint corruption-safety invariant.
 *
 * The v2 checkpoint path must NEVER instantiate HmemStore (the v1 store) on
 * any file. Specifically:
 *
 *  - On a v2 file: handler runs, file keeps NO `memories` / `memory_nodes`
 *    tables, schema_major stays '2'.
 *  - On a v1 file: handler is a no-op, does NOT add v2 tables (`entries`), and
 *    does NOT stamp schema_major (getSchemaMajor stays null on the v1 file).
 *  - Missing / empty HMEM_PATH → must not throw.
 *  - Repeated invocations → must not throw.
 *
 * Uses /tmp only — never touches ~/.hmem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDb, getSchemaMajor } from '../src/store/db.js';
import { createV2Store } from '../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../src/hmem-config.js';
import { runCliV2Checkpoint } from '../src/cli-v2-checkpoint.js';

// ── Fixture paths ─────────────────────────────────────────────────────────────

const V2_DB = '/tmp/v2-checkpoint-test-v2.hmem';
const V1_DB = '/tmp/v2-checkpoint-test-v1.hmem';

const SIDECARS = (base: string) => [base, base + '-wal', base + '-shm'];
function cleanup(base: string) {
  for (const f of SIDECARS(base)) if (existsSync(f)) rmSync(f);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if the named table exists in the SQLite file at `path`. */
function tableExists(filePath: string, name: string): boolean {
  const db = new Database(filePath, { readonly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined;
  } finally {
    db.close();
  }
}

/** Build a minimal v1-shaped file (memories + memory_nodes tables only). */
function buildV1File(filePath: string): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, content TEXT);
    CREATE TABLE IF NOT EXISTS memory_nodes (id INTEGER PRIMARY KEY, parent_id INTEGER);
  `);
  db.close();
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('cli v2-checkpoint (Test #5 — corruption-safety)', () => {
  beforeEach(() => {
    cleanup(V2_DB);
    cleanup(V1_DB);
    delete process.env.HMEM_PROJECT_DIR;
    delete process.env.HMEM_PATH;
    // No ambient session: with a bound-free fixture, the v2 core no-ops at
    // currentProject() regardless — but pin the env for determinism.
    delete process.env.HMEM_SESSION_ID;
  });

  afterEach(() => {
    cleanup(V2_DB);
    cleanup(V1_DB);
    delete process.env.HMEM_PROJECT_DIR;
    delete process.env.HMEM_PATH;
    // No ambient session: with a bound-free fixture, the v2 core no-ops at
    // currentProject() regardless — but pin the env for determinism.
    delete process.env.HMEM_SESSION_ID;
  });

  // ── v2 fixture ─────────────────────────────────────────────────────────────

  it('v2 fixture: no memories/memory_nodes tables, schema_major stays 2 after handler run', async () => {
    // Materialise a v2 store with a couple of events so the guard isn't short-
    // circuiting on an empty file — we want the v2 path to actually execute.
    const store = createV2Store(V2_DB, DEFAULT_CONFIG);
    store.events.appendEvent({ session_id: 'S1', role: 'user', content: 'hello' });
    store.events.appendEvent({ session_id: 'S1', role: 'assistant', content: 'hi' });
    store.close();

    process.env.HMEM_PROJECT_DIR = '/tmp';
    process.env.HMEM_PATH = V2_DB;

    await runCliV2Checkpoint();

    // Core invariant: v1 tables were NEVER injected.
    expect(tableExists(V2_DB, 'memories')).toBe(false);
    expect(tableExists(V2_DB, 'memory_nodes')).toBe(false);

    // schema_major must remain '2'.
    const db = openDb(V2_DB);
    try {
      expect(getSchemaMajor(db)).toBe('2');
      // v2 events must still be intact (handler didn't truncate anything).
      const row = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      expect(row.n).toBe(2);
    } finally {
      db.close();
    }
  });

  // ── v1 fixture ─────────────────────────────────────────────────────────────

  it('v1 fixture: handler is a no-op — does NOT add v2 tables and does NOT throw', async () => {
    buildV1File(V1_DB);

    process.env.HMEM_PROJECT_DIR = '/tmp';
    process.env.HMEM_PATH = V1_DB;

    // Must not throw.
    await expect(runCliV2Checkpoint()).resolves.toBeUndefined();

    // v2 tables must NOT have been created on the v1 file.
    expect(tableExists(V1_DB, 'entries')).toBe(false);

    // schema_major must still be null (handler did NOT v2-stamp the file).
    const db = new Database(V1_DB, { readonly: true });
    try {
      expect(getSchemaMajor(db)).toBeNull();
    } finally {
      db.close();
    }

    // The original v1 tables must still be there (handler didn't corrupt anything).
    expect(tableExists(V1_DB, 'memories')).toBe(true);
    expect(tableExists(V1_DB, 'memory_nodes')).toBe(true);
  });

  // ── Idempotency / missing context ──────────────────────────────────────────

  it('no-op when HMEM_PATH is unset', async () => {
    delete process.env.HMEM_PATH;
    delete process.env.HMEM_PROJECT_DIR;
    await expect(runCliV2Checkpoint()).resolves.toBeUndefined();
  });

  it('no-op when HMEM_PROJECT_DIR is unset', async () => {
    delete process.env.HMEM_PROJECT_DIR;
    process.env.HMEM_PATH = V2_DB;
    await expect(runCliV2Checkpoint()).resolves.toBeUndefined();
  });

  it('no-op when HMEM_PATH points to a non-existent file', async () => {
    process.env.HMEM_PROJECT_DIR = '/tmp';
    process.env.HMEM_PATH = '/tmp/does-not-exist-v2-checkpoint.hmem';
    await expect(runCliV2Checkpoint()).resolves.toBeUndefined();
  });

  it('idempotency: running twice on a v2 store does not throw and keeps schema intact', async () => {
    const store = createV2Store(V2_DB, DEFAULT_CONFIG);
    store.events.appendEvent({ session_id: 'S2', role: 'user', content: 'ping' });
    store.close();

    process.env.HMEM_PROJECT_DIR = '/tmp';
    process.env.HMEM_PATH = V2_DB;

    await runCliV2Checkpoint();
    await runCliV2Checkpoint(); // second run — must not throw or corrupt

    expect(tableExists(V2_DB, 'memories')).toBe(false);
    expect(tableExists(V2_DB, 'memory_nodes')).toBe(false);

    const db = openDb(V2_DB);
    try {
      expect(getSchemaMajor(db)).toBe('2');
    } finally {
      db.close();
    }
  });
});

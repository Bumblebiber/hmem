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
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, getSchemaMajor } from '../src/store/db.js';
import { createV2Store } from '../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../src/hmem-config.js';
import { runCliV2CheckpointCore } from '../src/cli-v2-checkpoint.js';

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

    await runCliV2CheckpointCore();

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
    await expect(runCliV2CheckpointCore()).resolves.toBeUndefined();

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
    await expect(runCliV2CheckpointCore()).resolves.toBeUndefined();
  });

  it('threads the explicit session id through to runV2Checkpoint (writes a marker)', async () => {
    // Stop-hook regression: the session id arrives via stdin, not env/ppid. The
    // core must forward it so runV2Checkpoint resolves the project + extracts.
    const store = createV2Store(V2_DB, DEFAULT_CONFIG);
    const p = store.entries.createEntry({ prefix: 'P', level_1: 'Threaded Project' });
    store.sessions.createSession({ session_id: 'S-thread' });
    store.sessions.bind('S-thread', p.uid);            // opens [1, NULL]
    for (let i = 0; i < 4; i++) {
      store.events.appendEvent({ session_id: 'S-thread', role: 'user', content: `m-${i}` });
    }
    store.sessions.bind('S-thread', p.uid, 5);          // closes [1,4], opens [5, NULL]
    store.close();

    process.env.HMEM_PROJECT_DIR = '/tmp';
    process.env.HMEM_PATH = V2_DB;

    await runCliV2CheckpointCore('S-thread', {
      // No real subprocess: force the gate open + stub the extraction agent.
      gateProbes: { detectHarness: () => 'claude-code', hasClaudeBinary: () => true },
      invoke: async () => { /* no-op agent */ },
    });

    // A marker for the closed [1,4] segment proves the session id was threaded.
    const db = new Database(V2_DB, { readonly: true });
    try {
      const row = db
        .prepare('SELECT last_extracted_seq FROM segment_extractions WHERE session_id = ? AND from_seq = ?')
        .get('S-thread', 1) as { last_extracted_seq: number } | undefined;
      expect(row?.last_extracted_seq).toBe(4);
    } finally {
      db.close();
    }
  });

  it('derives HMEM_PROJECT_DIR from HMEM_PATH when only HMEM_PATH is set (Stop-hook regression)', async () => {
    // The Stop hook command sets only HMEM_PATH. The handler must derive
    // HMEM_PROJECT_DIR (via resolveEnvDefaults) so downstream config/agent wiring
    // works — instead of early-returning into a silent no-op (the original bug).
    const store = createV2Store(V2_DB, DEFAULT_CONFIG);
    store.close();
    delete process.env.HMEM_PROJECT_DIR;
    process.env.HMEM_PATH = V2_DB;

    await runCliV2CheckpointCore();

    expect(process.env.HMEM_PROJECT_DIR).toBe(path.dirname(V2_DB));
  });

  it('no-op when HMEM_PATH points to a non-existent file', async () => {
    process.env.HMEM_PROJECT_DIR = '/tmp';
    process.env.HMEM_PATH = '/tmp/does-not-exist-v2-checkpoint.hmem';
    await expect(runCliV2CheckpointCore()).resolves.toBeUndefined();
  });

  it('idempotency: running twice on a v2 store does not throw and keeps schema intact', async () => {
    const store = createV2Store(V2_DB, DEFAULT_CONFIG);
    store.events.appendEvent({ session_id: 'S2', role: 'user', content: 'ping' });
    store.close();

    process.env.HMEM_PROJECT_DIR = '/tmp';
    process.env.HMEM_PATH = V2_DB;

    await runCliV2CheckpointCore();
    await runCliV2CheckpointCore(); // second run — must not throw or corrupt

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

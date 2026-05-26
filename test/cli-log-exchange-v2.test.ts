/**
 * Regression test for the v1→v2 cutover bug: the Stop hook (`hmem log-exchange`)
 * must write exchanges into the v2 `events` table of a schema_major=2 file and
 * must NOT re-inject the v1 schema (`memories`/`memory_nodes`).
 *
 * Exercises the testable core `appendExchangeV2Path` against a freshly-created
 * on-disk schema_major=2 store. Uses /tmp — never touches ~/.hmem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { openDb, getSchemaMajor } from '../src/store/db.js';
import { DEFAULT_CONFIG } from '../src/hmem-config.js';
import { appendExchangeV2Path } from '../src/cli-log-exchange.js';

const DB = '/tmp/log-exchange-v2.hmem';
const SIDECARS = [DB, DB + '-wal', DB + '-shm'];

function cleanup() { for (const f of SIDECARS) if (existsSync(f)) rmSync(f); }

function tableExists(path: string, name: string): boolean {
  const db = openDb(path);
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined;
  } finally {
    db.close();
  }
}

describe('cli log-exchange (v2 events)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('creates a schema_major=2 store on first open', () => {
    const db = openDb(DB);
    try {
      expect(getSchemaMajor(db)).toBe('2');
    } finally {
      db.close();
    }
  });

  it('appends the exchange as user+assistant events under the session_id', async () => {
    // Materialise the v2 file first (mirrors a hook running against an existing store).
    openDb(DB).close();

    const res = await appendExchangeV2Path(DB, DEFAULT_CONFIG, 'S1', 'do X', 'done X');
    expect(res).toEqual({ wrote: true, schemaMajor: '2' });

    const db = openDb(DB);
    try {
      const rows = db
        .prepare('SELECT seq, role, content FROM events WHERE session_id=? ORDER BY seq')
        .all('S1') as { seq: number; role: string; content: string }[];
      expect(rows).toEqual([
        { seq: 1, role: 'user', content: 'do X' },
        { seq: 2, role: 'assistant', content: 'done X' },
      ]);
    } finally {
      db.close();
    }
  });

  it('does NOT create or write the v1 memories / memory_nodes tables', async () => {
    openDb(DB).close();
    await appendExchangeV2Path(DB, DEFAULT_CONFIG, 'S1', 'hello', 'hi');

    expect(tableExists(DB, 'memories')).toBe(false);
    expect(tableExists(DB, 'memory_nodes')).toBe(false);
    // schema_major must remain 2 (a v1 store would stamp/leave it unset).
    const db = openDb(DB);
    try { expect(getSchemaMajor(db)).toBe('2'); } finally { db.close(); }
  });

  it('appends unconditionally even with no project binding (attribution derived later)', async () => {
    openDb(DB).close();
    // No session_bindings row exists — the v1 code would have fallen back to O0000
    // and silently dropped this. v2 appends regardless.
    const res = await appendExchangeV2Path(DB, DEFAULT_CONFIG, 'S-unbound', 'a', 'b');
    expect(res.wrote).toBe(true);

    const db = openDb(DB);
    try {
      const n = db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id=?')
        .get('S-unbound') as { n: number };
      expect(n.n).toBe(2);
    } finally {
      db.close();
    }
  });
});

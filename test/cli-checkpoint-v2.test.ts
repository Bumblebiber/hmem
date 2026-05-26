/**
 * Regression test for the v1→v2 cutover bug: the checkpoint Stop hook
 * (`hmem checkpoint`) must NOT open a schema_major=2 file with the v1 `HmemStore`
 * class (which would re-inject the v1 `memories`/`memory_nodes` schema and corrupt
 * the file). On a v2 store it must bail out as a no-op — the v2 logStop summarizer
 * handles rolling summaries.
 *
 * Uses /tmp — never touches ~/.hmem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { openDb, getSchemaMajor } from '../src/store/db.js';
import { createV2Store } from '../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../src/hmem-config.js';
import { checkpoint } from '../src/cli-checkpoint.js';

const DB = '/tmp/checkpoint-v2.hmem';
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

describe('cli checkpoint (v2 cutover guard)', () => {
  beforeEach(cleanup);
  afterEach(() => {
    cleanup();
    delete process.env.HMEM_PROJECT_DIR;
    delete process.env.HMEM_PATH;
  });

  it('is a no-op on a schema_major=2 store and creates NO v1 tables', async () => {
    // Materialise a v2 file with some real v2 content (a session + events) so the
    // guard, not an "empty file" early-return, is what stops the v1 path.
    const store = createV2Store(DB, DEFAULT_CONFIG);
    store.events.appendEvent({ session_id: 'S1', role: 'user', content: 'hi' });
    store.events.appendEvent({ session_id: 'S1', role: 'assistant', content: 'hello' });
    store.close();

    process.env.HMEM_PROJECT_DIR = '/tmp';
    process.env.HMEM_PATH = DB;

    await checkpoint();

    // The guard must have fired: no v1 schema injected.
    expect(tableExists(DB, 'memories')).toBe(false);
    expect(tableExists(DB, 'memory_nodes')).toBe(false);

    // schema_major unchanged, v2 events intact.
    const db = openDb(DB);
    try {
      expect(getSchemaMajor(db)).toBe('2');
      const n = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      expect(n.n).toBe(2);
    } finally {
      db.close();
    }
  });
});

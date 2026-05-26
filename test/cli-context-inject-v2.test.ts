/**
 * Regression test for the v1→v2 cutover bug: the SessionStart hook
 * (`hmem context-inject`) must read the v2 `entries` table of a schema_major=2
 * file and must NOT re-inject the v1 schema (`memories`/`memory_nodes`).
 *
 * Exercises the testable core `buildContextInjectV2` against a freshly-created
 * on-disk schema_major=2 store. Uses /tmp — never touches ~/.hmem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { openDb, getSchemaMajor } from '../src/store/db.js';
import { createV2Store } from '../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../src/hmem-config.js';
import { buildContextInjectV2 } from '../src/cli-context-inject.js';

const DB = '/tmp/context-inject-v2.hmem';
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

/** Seed a couple of P-entries and one pinned R-entry into a v2 store. */
function seed(path: string): void {
  const store = createV2Store(path, DEFAULT_CONFIG);
  try {
    store.entries.createEntry({ prefix: 'P', level_1: 'hmem | memory store' });
    const r = store.entries.createEntry({ prefix: 'R', level_1: 'Max 1 npm publish per day\nenforced by release checklist' });
    // No `pinned` setter on the entries API — set it directly (test-only).
    store.db.prepare('UPDATE entries SET pinned=1 WHERE uid=?').run(r.uid);
    // A non-pinned R-entry must NOT appear in the rules block.
    store.entries.createEntry({ prefix: 'R', level_1: 'Some quiet rule' });
  } finally {
    store.close();
  }
}

describe('cli context-inject (v2 SessionStart)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('builds context against a schema_major=2 store and emits project + pinned-rule output', () => {
    openDb(DB).close();
    seed(DB);

    const res = buildContextInjectV2(DB, DEFAULT_CONFIG);
    expect(res.wrote).toBe(true);
    expect(res.schemaMajor).toBe('2');
    // (a) produces context output
    expect(res.text).toContain('## Projects (5 most recent):');
    expect(res.text).toContain('P0001');
    expect(res.text).toContain('hmem | memory store');
    expect(res.text).toContain('## Rules (pinned/favorited):');
    expect(res.text).toContain('Max 1 npm publish per day');
    // non-pinned rule excluded
    expect(res.text).not.toContain('Some quiet rule');
    // load_project guidance present
    expect(res.text).toContain('load_project');
  });

  it('does NOT create or write the v1 memories / memory_nodes tables', () => {
    openDb(DB).close();
    seed(DB);

    buildContextInjectV2(DB, DEFAULT_CONFIG);

    // (b) creates NO v1 tables
    expect(tableExists(DB, 'memories')).toBe(false);
    expect(tableExists(DB, 'memory_nodes')).toBe(false);
    // schema_major must remain 2
    const db = openDb(DB);
    try { expect(getSchemaMajor(db)).toBe('2'); } finally { db.close(); }
  });

  it('emits output even with no entries (still v1-clean)', () => {
    openDb(DB).close();
    const res = buildContextInjectV2(DB, DEFAULT_CONFIG);
    expect(res.wrote).toBe(true);
    expect(res.text).toContain('load_project');
    expect(tableExists(DB, 'memories')).toBe(false);
    expect(tableExists(DB, 'memory_nodes')).toBe(false);
  });
});

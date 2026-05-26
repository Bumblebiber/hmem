/**
 * Companion to cli-checkpoint-v2.test.ts. The checkpoint hook's `isV2Store` probe
 * must work on a v1 user's file WITHOUT crashing: now that openDb() refuses a v1
 * file (V1FileError), a probe built on openDb would throw inside the auto-firing
 * Stop hook on EVERY existing v1 user. `isV2Store` must be a read-only probe that
 * returns false for a v1 file, never throws, and never corrupts/sidecars it.
 *
 * Uses mkdtemp dirs — never touches ~/.hmem.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/store/db.js';
import { isV2Store } from '../src/cli-checkpoint.js';
import { makeV1Fixture } from './migrate/fixture.js';

function tmpPath(name = 'probe.hmem'): string {
  return join(mkdtempSync(join(tmpdir(), 'hmem-ckpt-probe-')), name);
}

describe('isV2Store readonly probe', () => {
  it('returns false on a v1 file without throwing or corrupting it', () => {
    const path = tmpPath();
    makeV1Fixture(path).close();

    expect(() => isV2Store(path)).not.toThrow();
    expect(isV2Store(path)).toBe(false);

    // The probe must be read-only: no v2 schema injected, no sidecars, v1 data intact.
    const probe = new Database(path, { readonly: true });
    try {
      const entries = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
        .get();
      expect(entries).toBeUndefined();
      const root = probe
        .prepare("SELECT prefix FROM memories WHERE id='P0001'")
        .get() as { prefix: string } | undefined;
      expect(root?.prefix).toBe('P');
    } finally {
      probe.close();
    }
    expect(existsSync(path + '-wal')).toBe(false);
    expect(existsSync(path + '-shm')).toBe(false);
  });

  it('returns true on a v2 file', () => {
    const path = tmpPath();
    openDb(path).close();
    expect(isV2Store(path)).toBe(true);
  });

  it('returns false on a missing file without throwing', () => {
    const path = tmpPath('does-not-exist.hmem');
    expect(() => isV2Store(path)).not.toThrow();
    expect(isV2Store(path)).toBe(false);
  });
});

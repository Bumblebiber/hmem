/**
 * The two hook-shim store openers must return null (not throw) on a v1 file, so a
 * v1 user's hooks silently skip instead of crashing the harness. `openStore`
 * (claude-code) is the every-session SessionStart/Stop path for every Claude Code
 * user — highest blast radius — and `openV2` is the Hermes/Pi equivalent.
 * Characterization tests locking the V1FileError→null contract against regression.
 *
 * Uses mkdtemp dirs and a pinned HMEM_PATH — never touches ~/.hmem.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore as ccOpenStore } from '../src/hooks/harness/claude-code.js';
import { openV2 as genericOpenV2 } from '../src/hooks/dispatch.js';
import { makeV1Fixture } from './migrate/fixture.js';

function v1Tmp(): string {
  const p = join(mkdtempSync(join(tmpdir(), 'hmem-shim-v1-')), 's.hmem');
  makeV1Fixture(p).close();
  return p;
}

describe('hook shim openers on a v1 file (never crash the harness)', () => {
  afterEach(() => {
    delete process.env.HMEM_PATH;
    delete process.env.HMEM_PROJECT_DIR;
  });

  it('claude-code openStore() returns null, no throw, no corruption', () => {
    const p = v1Tmp();
    process.env.HMEM_PATH = p;

    let res: unknown;
    expect(() => {
      res = ccOpenStore();
    }).not.toThrow();
    expect(res).toBeNull();

    const probe = new Database(p, { readonly: true });
    try {
      expect(
        probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").get(),
      ).toBeUndefined();
    } finally {
      probe.close();
    }
    expect(existsSync(p + '-wal')).toBe(false);
    expect(existsSync(p + '-shm')).toBe(false);
  });

  it('generic openV2() returns null, no throw', () => {
    const p = v1Tmp();
    process.env.HMEM_PATH = p;

    let res: unknown;
    expect(() => {
      res = genericOpenV2();
    }).not.toThrow();
    expect(res).toBeNull();
  });
});

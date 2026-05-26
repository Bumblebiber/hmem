/**
 * Hook callers must NO-OP on an existing v1 user's file, never crash the harness.
 * Each testable hook core opens the store via createV2Store → openDb, which now
 * throws V1FileError on a v1 file. Without a guard, a v1 user's SessionStart /
 * PromptSubmit / Stop hooks would crash on every fire. Each core must instead
 * return its empty "not v2" contract (wrote:false, schemaMajor:'1') and leave the
 * v1 file uncorrupted.
 *
 * Uses mkdtemp dirs — never touches ~/.hmem.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../src/hmem-config.js';
import { buildHookStartupContextV2 } from '../src/cli-hook-startup.js';
import { buildContextInjectV2 } from '../src/cli-context-inject.js';
import { appendExchangeV2Path } from '../src/cli-log-exchange.js';
import { makeV1Fixture } from './migrate/fixture.js';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'hmem-hook-v1-')), 'h.hmem');
}

function assertUncorrupted(p: string): void {
  const probe = new Database(p, { readonly: true });
  try {
    expect(
      probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").get(),
    ).toBeUndefined();
    expect(
      (probe.prepare("SELECT prefix FROM memories WHERE id='P0001'").get() as { prefix: string } | undefined)
        ?.prefix,
    ).toBe('P');
  } finally {
    probe.close();
  }
  expect(existsSync(p + '-wal')).toBe(false);
  expect(existsSync(p + '-shm')).toBe(false);
}

describe('hook callers no-op on a v1 file (never crash the harness)', () => {
  it('buildHookStartupContextV2 returns empty contract, no throw, no corruption', () => {
    const p = tmpPath();
    makeV1Fixture(p).close();

    let res: unknown;
    expect(() => {
      res = buildHookStartupContextV2(p, DEFAULT_CONFIG);
    }).not.toThrow();
    expect(res).toEqual({ wrote: false, schemaMajor: '1', humanContext: '', recentProjects: '' });
    assertUncorrupted(p);
  });

  it('buildContextInjectV2 returns empty contract, no throw', () => {
    const p = tmpPath();
    makeV1Fixture(p).close();

    let res: unknown;
    expect(() => {
      res = buildContextInjectV2(p, DEFAULT_CONFIG);
    }).not.toThrow();
    expect(res).toEqual({ wrote: false, schemaMajor: '1', text: '' });
    assertUncorrupted(p);
  });

  it('appendExchangeV2Path returns wrote:false, no throw', async () => {
    const p = tmpPath();
    makeV1Fixture(p).close();

    const res = await appendExchangeV2Path(p, DEFAULT_CONFIG, 'S1', 'user', 'assistant');
    expect(res).toEqual({ wrote: false, schemaMajor: '1' });
    assertUncorrupted(p);
  });
});

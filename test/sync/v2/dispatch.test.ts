import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getSchemaMajor } from '../../../src/store/db.js';
import { syncLaneFor, syncLaneForPath } from '../../../src/sync/v2/dispatch.js';

describe('syncLaneFor', () => {
  it('routes a v2 file to the v2 lane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmem-disp-'));
    const db = openDb(join(dir, 'v2.hmem')); // stamps schema_major=2
    expect(getSchemaMajor(db)).toBe('2');
    expect(syncLaneFor(db)).toBe('v2');
    db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('routes a non-v2 (schema_major != 2) file to the v1 lane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmem-disp-'));
    const db = openDb(join(dir, 'x.hmem'));
    db.prepare("UPDATE schema_version SET value='1' WHERE key='schema_major'").run();
    expect(syncLaneFor(db)).toBe('v1');
    db.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe('syncLaneForPath', () => {
  it('returns v2 for a v2 file on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmem-disp-'));
    const p = join(dir, 'v2.hmem');
    openDb(p).close(); // creates + stamps schema_major=2, then closes
    expect(syncLaneForPath(p)).toBe('v2');
    rmSync(dir, { recursive: true, force: true });
  });
  it('returns v1 for a missing file (no corruption, safe default)', () => {
    expect(syncLaneForPath(join(tmpdir(), 'does-not-exist-xyz.hmem'))).toBe('v1');
  });
  it('does NOT create or mutate a v1 file when peeking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmem-disp-'));
    const p = join(dir, 'v1.hmem');
    const db = openDb(p);
    db.prepare("UPDATE schema_version SET value='1' WHERE key='schema_major'").run();
    db.close();
    expect(syncLaneForPath(p)).toBe('v1');
    // confirm the peek did not flip it back to '2'
    const db2 = openDb(p); // NOTE: openDb on an existing file does INSERT OR IGNORE, so it won't overwrite an existing '1'
    expect(db2.prepare("SELECT value FROM schema_version WHERE key='schema_major'").get()).toMatchObject({ value: '1' });
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

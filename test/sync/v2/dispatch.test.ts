import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getSchemaMajor } from '../../../src/store/db.js';
import { syncLaneFor } from '../../../src/sync/v2/dispatch.js';

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

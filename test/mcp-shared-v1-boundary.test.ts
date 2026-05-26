/**
 * MCP tool boundary on a v1 file (Decision #1: per-call refusal + migration hint).
 * resolveStore() → createV2Store → openDb now throws V1FileError on an existing v1
 * file. The MCP boundary must turn that into a clean, agent-facing "needs migration"
 * message — NOT openDb's internal "refusing to v2-init" phrasing — so the server
 * stays alive and the agent can be guided to `hmem migrate`.
 *
 * Uses mkdtemp dirs — never touches ~/.hmem.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStore } from '../src/mcp-shared.js';
import { openDb } from '../src/store/db.js';
import { makeV1Fixture } from './migrate/fixture.js';

function tmpPath(name = 'boundary.hmem'): string {
  return join(mkdtempSync(join(tmpdir(), 'hmem-mcp-bnd-')), name);
}

describe('MCP boundary on a v1 file (per-call refusal)', () => {
  it('surfaces a clean migration hint, not openDb internals', () => {
    const p = tmpPath();
    makeV1Fixture(p).close();

    expect(() => resolveStore('personal', p)).toThrow(/still v1/i);
    expect(() => resolveStore('personal', p)).toThrow(/hmem migrate/);
    // The internal openDb phrasing must NOT leak to the agent.
    expect(() => resolveStore('personal', p)).not.toThrow(/refusing to v2-init/);
  });

  it('still opens a real v2 external file', () => {
    const p = tmpPath('v2.hmem');
    openDb(p).close();
    const r = resolveStore('personal', p);
    try {
      expect(r.isExternal).toBe(true);
      expect(r.store.db).toBeDefined();
    } finally {
      r.store.close();
    }
  });
});

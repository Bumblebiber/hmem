import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../../src/hmem-config.js';
import { exportV2 } from '../../../src/sync/v2/export.js';
import { markAcked, type V2Staging } from '../../../src/sync/v2/staging.js';

const emptyStaging = (): V2Staging => ({ file_id: 'f', cursor: null, acked: {} });

describe('exportV2', () => {
  it('exports newly created entries/nodes/sessions/bindings/events', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { uid } = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    s.entries.addNode({ root_uid: uid, content: 'Overview' });
    const { session_id } = s.sessions.createSession({});
    s.sessions.bind(session_id, uid);
    s.events.appendEvent({ session_id, role: 'user', content: 'hello' });

    const staging = emptyStaging();
    const tables = exportV2(s, staging).map((b) => b.table);
    expect(tables).toContain('entries');
    expect(tables).toContain('nodes');
    expect(tables).toContain('sessions');
    expect(tables).toContain('session_bindings');
    expect(tables).toContain('events');
    s.close();
  });

  it('does not re-export rows already acked at their current version', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const staging = emptyStaging();
    for (const b of exportV2(s, staging)) markAcked(staging, b);
    expect(exportV2(s, staging)).toHaveLength(0);
    s.close();
  });

  it('re-exports a row whose local version is newer than the acked version', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { uid } = s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const n = s.entries.addNode({ root_uid: uid, content: 'A' });
    const staging = emptyStaging();
    for (const b of exportV2(s, staging)) markAcked(staging, b);
    // Force the node's acked version to an ancient timestamp (deterministic — avoids
    // relying on the wall clock advancing between create and update within the test).
    staging.acked[`nodes:${n.uid}`].lww = '2000-01-01T00:00:00.000Z';
    const again = exportV2(s, staging);
    expect(again.some((b) => b.table === 'nodes' && b.row.uid === n.uid)).toBe(true);
    s.close();
  });

  it('excludes in-flight keys (already queued) from the diff', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    s.entries.createEntry({ prefix: 'P', level_1: 'Proj' });
    const staging = emptyStaging();
    const all = exportV2(s, staging);
    const inFlight = new Set(all.map((b) => `${b.table}:${b.key}`));
    expect(exportV2(s, staging, inFlight)).toHaveLength(0);
    s.close();
  });
});

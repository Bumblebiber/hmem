import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../../src/hmem-config.js';
import { importV2 } from '../../../src/sync/v2/import.js';
import { rowToEnvelope } from '../../../src/sync/v2/envelope.js';

const fresh = () => createV2Store(':memory:', DEFAULT_CONFIG);
const ts = (n: number) => `2026-05-25T1${n}:00:00.000Z`;

describe('importV2', () => {
  it('inserts a remote entry that does not exist locally', () => {
    const s = fresh();
    const env = rowToEnvelope('entries', {
      uid: '01REMOTE', label: 'P9999', prefix: 'P', seq: 9999, level_1: 'Remote',
      created_at: ts(0), updated_at: ts(0), access_count: 0, last_accessed: null,
      obsolete: 0, favorite: 0, irrelevant: 0, pinned: 0, tags: null, deleted_at: null,
    });
    const staging = { file_id: 'f', cursor: null, acked: {} };
    importV2(s, staging, [env]);
    expect(s.entries.getEntry('01REMOTE')?.level_1).toBe('Remote');
    s.close();
  });

  it('applies LWW: newer remote update overwrites older local row', () => {
    const s = fresh();
    const { uid } = s.entries.createEntry({ prefix: 'P', level_1: 'Local' });
    const local = s.entries.getEntry(uid)!;
    const remote = rowToEnvelope('entries', { ...local, level_1: 'RemoteWins', updated_at: ts(9) });
    const staging = { file_id: 'f', cursor: null, acked: {} };
    importV2(s, staging, [remote]);
    expect(s.entries.getEntry(uid)?.level_1).toBe('RemoteWins');
    s.close();
  });

  it('ignores an older remote update (local newer wins)', () => {
    const s = fresh();
    const { uid } = s.entries.createEntry({ prefix: 'P', level_1: 'LocalNew' });
    const local = s.entries.getEntry(uid)!;
    const stale = rowToEnvelope('entries', { ...local, level_1: 'StaleRemote', updated_at: ts(0) });
    const staging = { file_id: 'f', cursor: null, acked: {} };
    importV2(s, staging, [stale]);
    expect(s.entries.getEntry(uid)?.level_1).toBe('LocalNew');
    s.close();
  });

  it('applies a remote tombstone via deleted_at (LWW delete)', () => {
    const s = fresh();
    const { uid } = s.entries.createEntry({ prefix: 'P', level_1: 'ToDelete' });
    const local = s.entries.getEntry(uid)!;
    const tomb = rowToEnvelope('entries', { ...local, updated_at: ts(9), deleted_at: ts(9) });
    const staging = { file_id: 'f', cursor: null, acked: {} };
    importV2(s, staging, [tomb]);
    expect(s.entries.getEntry(uid)).toBeNull(); // getEntry filters deleted_at IS NULL
    const raw = s.db.prepare('SELECT deleted_at FROM entries WHERE uid=?').get(uid) as { deleted_at: string | null };
    expect(raw.deleted_at).toBe(ts(9));
    s.close();
  });

  it('unions events: inserts new event_uids, never duplicates', () => {
    const s = fresh();
    const ev = rowToEnvelope('events', { event_uid: 'EV1', session_id: 'S1', seq: 1, ts: ts(0), role: 'user', content: 'remote' });
    const staging = { file_id: 'f', cursor: null, acked: {} };
    importV2(s, staging, [ev]);
    importV2(s, staging, [ev]); // idempotent
    const rows = s.db.prepare('SELECT * FROM events WHERE event_uid=?').all('EV1');
    expect(rows).toHaveLength(1);
    s.close();
  });

  it('marks winners as acked so they will not be re-pushed', () => {
    const s = fresh();
    const env = rowToEnvelope('entries', {
      uid: '01R', label: 'P1', prefix: 'P', seq: 1, level_1: 'R',
      created_at: ts(0), updated_at: ts(0), access_count: 0, last_accessed: null,
      obsolete: 0, favorite: 0, irrelevant: 0, pinned: 0, tags: null, deleted_at: null,
    });
    const staging = { file_id: 'f', cursor: null, acked: {} };
    importV2(s, staging, [env]);
    expect(staging.acked['entries:01R']).toBeTruthy();
    s.close();
  });
});

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
    s.db.prepare('UPDATE entries SET updated_at=? WHERE uid=?').run(ts(0), uid); // pin local early (clock-independent)
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
    s.db.prepare('UPDATE entries SET updated_at=? WHERE uid=?').run(ts(9), uid); // pin local late (clock-independent)
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
    s.db.prepare('UPDATE entries SET updated_at=? WHERE uid=?').run(ts(0), uid); // pin local early
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

  it('does NOT ack when the local copy wins (skip), so the newer local will still be pushed', () => {
    const s = fresh();
    const { uid } = s.entries.createEntry({ prefix: 'P', level_1: 'LocalNew' });
    s.db.prepare('UPDATE entries SET updated_at=? WHERE uid=?').run(ts(9), uid); // pin local late
    const local = s.entries.getEntry(uid)!;
    const stale = rowToEnvelope('entries', { ...local, level_1: 'StaleRemote', updated_at: ts(0) });
    const staging = { file_id: 'f', cursor: null, acked: {} as Record<string, unknown> };
    importV2(s, staging, [stale]);
    expect(staging.acked[`entries:${uid}`]).toBeUndefined(); // local won → not acked
    s.close();
  });

  it('reduces multiple envelopes for the same key to the single LWW winner', () => {
    const s = fresh();
    const base = { uid: '01K', label: 'P5', prefix: 'P', seq: 5, created_at: ts(0), access_count: 0, last_accessed: null, obsolete: 0, favorite: 0, irrelevant: 0, pinned: 0, tags: null, deleted_at: null };
    const older = rowToEnvelope('entries', { ...base, level_1: 'older', updated_at: ts(1) });
    const newer = rowToEnvelope('entries', { ...base, level_1: 'newer', updated_at: ts(8) });
    const staging = { file_id: 'f', cursor: null, acked: {} };
    importV2(s, staging, [older, newer, older]); // order-independent
    expect(s.entries.getEntry('01K')?.level_1).toBe('newer');
    s.close();
  });

  it('reconciles a non-entries mutable table (nodes) by LWW', () => {
    const s = fresh();
    const { uid } = s.entries.createEntry({ prefix: 'P', level_1: 'Root' });
    const n = s.entries.addNode({ root_uid: uid, content: 'A' });
    s.db.prepare('UPDATE nodes SET updated_at=? WHERE uid=?').run(ts(0), n.uid); // pin local node early
    const localNode = s.db.prepare('SELECT * FROM nodes WHERE uid=?').get(n.uid) as Record<string, unknown>;
    const remote = rowToEnvelope('nodes', { ...localNode, content: 'B-wins', updated_at: ts(9) });
    const staging = { file_id: 'f', cursor: null, acked: {} };
    importV2(s, staging, [remote]);
    expect((s.db.prepare('SELECT content FROM nodes WHERE uid=?').get(n.uid) as { content: string }).content).toBe('B-wins');
    s.close();
  });

  it('a newer local delete is not clobbered by a stale remote edit', () => {
    const s = fresh();
    const { uid } = s.entries.createEntry({ prefix: 'P', level_1: 'X' });
    const local = s.entries.getEntry(uid)!;
    // local soft-deletes at a late timestamp
    s.db.prepare('UPDATE entries SET deleted_at=?, updated_at=? WHERE uid=?').run(ts(9), ts(9), uid);
    const staleEdit = rowToEnvelope('entries', { ...local, level_1: 'StaleEdit', updated_at: ts(2), deleted_at: null });
    const staging = { file_id: 'f', cursor: null, acked: {} };
    importV2(s, staging, [staleEdit]);
    const raw = s.db.prepare('SELECT deleted_at, level_1 FROM entries WHERE uid=?').get(uid) as { deleted_at: string | null; level_1: string };
    expect(raw.deleted_at).toBe(ts(9)); // delete preserved
    s.close();
  });

  it('relabels a same-seq label collision instead of throwing (smaller uid keeps the label)', () => {
    const s = fresh();
    // local store already holds a live P0001 with a LARGER uid than the incoming one
    const big = 'Z'.repeat(26);
    s.db.prepare(
      `INSERT INTO entries (uid,label,prefix,seq,level_1,created_at,updated_at)
       VALUES (?, 'P0001','P',1,'local', ?, ?)`,
    ).run(big, ts(0), ts(0));

    const small = '0'.repeat(26); // smaller uid → should keep P0001
    const incoming = rowToEnvelope('entries', {
      uid: small, label: 'P0001', prefix: 'P', seq: 1, level_1: 'remote',
      created_at: ts(1), updated_at: ts(1), access_count: 0, last_accessed: null,
      obsolete: 0, favorite: 0, irrelevant: 0, pinned: 0, tags: null, deleted_at: null,
    });
    const staging = { file_id: 'f', cursor: null, acked: {} };

    expect(() => importV2(s, staging, [incoming])).not.toThrow();
    expect(s.entries.getEntry(small)!.label).toBe('P0001'); // smaller uid keeps it
    expect(s.entries.getEntry(big)!.label).toBe('P0002');   // local loser bumped
    expect(s.entries.getEntry(big)!.seq).toBe(2);
    s.close();
  });
});

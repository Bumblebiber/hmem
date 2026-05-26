import { describe, it, expect } from 'vitest';
import { rowToEnvelope, canonicalJson } from '../../../src/sync/v2/envelope.js';

describe('rowToEnvelope', () => {
  it('keys an entry by uid and uses updated_at as lww', () => {
    const row = { uid: '01ABC', label: 'P0001', updated_at: '2026-05-25T10:00:00.000Z', deleted_at: null };
    const e = rowToEnvelope('entries', row);
    expect(e).toMatchObject({ v: 2, table: 'entries', key: '01ABC', lww: '2026-05-25T10:00:00.000Z', deleted: false });
    expect(e.row).toEqual(row);
  });
  it('marks a soft-deleted row as deleted', () => {
    const row = { uid: '01ABC', updated_at: '2026-05-25T11:00:00.000Z', deleted_at: '2026-05-25T11:00:00.000Z' };
    expect(rowToEnvelope('entries', row).deleted).toBe(true);
  });
  it('keys a link by composite src|dst with null lww', () => {
    const row = { src_uid: 'A', dst_uid: 'B', kind: 'rel' };
    const e = rowToEnvelope('links', row);
    expect(e.key).toBe('A|B');
    expect(e.lww).toBeNull();
    expect(e.deleted).toBe(false);
  });
  it('keys a binding by session|from_seq using created_at as lww', () => {
    const row = { session_id: 'S1', project_uid: 'P', from_seq: 3, to_seq: null, created_at: '2026-05-25T09:00:00.000Z' };
    const e = rowToEnvelope('session_bindings', row);
    expect(e.key).toBe('S1|3');
    expect(e.lww).toBe('2026-05-25T09:00:00.000Z');
  });
  it('keys a node by uid with updated_at as lww', () => {
    const row = { uid: '01NODE', root_uid: '01ROOT', content: 'x', updated_at: '2026-05-25T10:00:00.000Z', deleted_at: null };
    const e = rowToEnvelope('nodes', row);
    expect(e).toMatchObject({ table: 'nodes', key: '01NODE', lww: '2026-05-25T10:00:00.000Z', deleted: false });
  });
  it('keys an event by event_uid', () => {
    const row = { event_uid: 'EV1', session_id: 'S1', seq: 1, ts: 't', role: 'user', content: 'hi' };
    expect(rowToEnvelope('events', row).key).toBe('EV1');
    expect(rowToEnvelope('events', { event_uid: 'EV1', session_id: 'S1', seq: 1, ts: 't', role: 'user', content: 'hi' }).deleted).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys so byte-equality is order-independent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

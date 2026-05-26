import { describe, it, expect } from 'vitest';
import { pickWinner } from '../../../src/sync/v2/reconcile.js';
import { rowToEnvelope } from '../../../src/sync/v2/envelope.js';

const entry = (uid: string, updated_at: string, label: string, deleted = false) =>
  rowToEnvelope('entries', { uid, label, updated_at, deleted_at: deleted ? updated_at : null });

describe('pickWinner (mutable LWW total order)', () => {
  it('later updated_at wins', () => {
    const a = entry('U', '2026-05-25T10:00:00.000Z', 'old');
    const b = entry('U', '2026-05-25T11:00:00.000Z', 'new');
    expect(pickWinner(a, b).row.label).toBe('new');
    expect(pickWinner(b, a).row.label).toBe('new'); // symmetric
  });
  it('a later delete beats an earlier edit', () => {
    const edit = entry('U', '2026-05-25T10:00:00.000Z', 'edited');
    const del = entry('U', '2026-05-25T12:00:00.000Z', 'edited', true);
    expect(pickWinner(edit, del).deleted).toBe(true);
  });
  it('an equal-timestamp tie is broken deterministically by canonical row', () => {
    const a = entry('U', '2026-05-25T10:00:00.000Z', 'aaa');
    const b = entry('U', '2026-05-25T10:00:00.000Z', 'bbb');
    expect(pickWinner(a, b)).toEqual(pickWinner(b, a)); // same winner regardless of order
  });
  it('binding: closed (to_seq set) beats open (to_seq null) regardless of timestamp', () => {
    const open = rowToEnvelope('session_bindings', { session_id: 'S', from_seq: 1, to_seq: null, created_at: '2026-05-25T12:00:00.000Z' });
    const closed = rowToEnvelope('session_bindings', { session_id: 'S', from_seq: 1, to_seq: 9, created_at: '2026-05-25T10:00:00.000Z' });
    expect(pickWinner(open, closed).row.to_seq).toBe(9);
    expect(pickWinner(closed, open).row.to_seq).toBe(9); // symmetric: closed wins in either arg order
  });
});

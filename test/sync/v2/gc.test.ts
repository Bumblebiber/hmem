import { describe, it, expect } from 'vitest';
import { gcStaging, type V2Staging } from '../../../src/sync/v2/staging.js';

describe('gcStaging', () => {
  it('drops ack records that are tombstoned AND absent from the live key set', () => {
    const s: V2Staging = { file_id: 'f', cursor: null, acked: {
      'entries:LIVE': { table: 'entries', key: 'LIVE', lww: 't', deleted: false },
      'entries:GONE': { table: 'entries', key: 'GONE', lww: 't', deleted: true },
      'events:EV1':   { table: 'events', key: 'EV1', lww: null, deleted: false },
    } };
    gcStaging(s, new Set(['entries:LIVE', 'events:EV1'])); // GONE not in live set
    expect(s.acked['entries:GONE']).toBeUndefined();
    expect(s.acked['entries:LIVE']).toBeTruthy();
    expect(s.acked['events:EV1']).toBeTruthy(); // events never GC'd
  });

  it('keeps a tombstoned record that is still present (soft-deleted, not hard-deleted)', () => {
    const s: V2Staging = { file_id: 'f', cursor: null, acked: {
      'entries:SOFT': { table: 'entries', key: 'SOFT', lww: 't', deleted: true },
    } };
    gcStaging(s, new Set(['entries:SOFT'])); // still in the live set (row physically present)
    expect(s.acked['entries:SOFT']).toBeTruthy();
  });

  it('keeps a non-tombstoned absent record (defensive: only prune confirmed tombstones)', () => {
    const s: V2Staging = { file_id: 'f', cursor: null, acked: {
      'entries:X': { table: 'entries', key: 'X', lww: 't', deleted: false },
    } };
    gcStaging(s, new Set()); // absent but NOT tombstoned → keep
    expect(s.acked['entries:X']).toBeTruthy();
  });
});

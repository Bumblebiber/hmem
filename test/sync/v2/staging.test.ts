import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStaging, saveStaging, shouldPush, markAcked, type V2Staging } from '../../../src/sync/v2/staging.js';
import { rowToEnvelope } from '../../../src/sync/v2/envelope.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hmem-stg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const path = () => join(dir, 'file1.v2.json');

describe('staging ledger', () => {
  it('initializes empty when file is absent', () => {
    const s = loadStaging(path(), 'file1');
    expect(s).toEqual({ file_id: 'file1', cursor: null, acked: {} });
  });

  it('round-trips through save/load', () => {
    const s: V2Staging = { file_id: 'file1', cursor: '2026-05-25T10:00:00.000Z', acked: {} };
    saveStaging(path(), s);
    expect(loadStaging(path(), 'file1')).toEqual(s);
  });

  it('shouldPush is true for an unknown key', () => {
    const s = loadStaging(path(), 'file1');
    const e = rowToEnvelope('entries', { uid: 'U', updated_at: '2026-05-25T10:00:00.000Z', deleted_at: null });
    expect(shouldPush(s, e)).toBe(true);
  });

  it('shouldPush is false once a key is acked at the same version', () => {
    const s = loadStaging(path(), 'file1');
    const e = rowToEnvelope('entries', { uid: 'U', updated_at: '2026-05-25T10:00:00.000Z', deleted_at: null });
    markAcked(s, e);
    expect(shouldPush(s, e)).toBe(false);
  });

  it('shouldPush is true again when the local version advances', () => {
    const s = loadStaging(path(), 'file1');
    const old = rowToEnvelope('entries', { uid: 'U', updated_at: '2026-05-25T10:00:00.000Z', deleted_at: null });
    markAcked(s, old);
    const next = rowToEnvelope('entries', { uid: 'U', updated_at: '2026-05-25T11:00:00.000Z', deleted_at: null });
    expect(shouldPush(s, next)).toBe(true);
  });

  it('events are never re-pushed once acked (union, no version)', () => {
    const s = loadStaging(path(), 'file1');
    const ev = rowToEnvelope('events', { event_uid: 'EV', session_id: 'S', seq: 1, ts: 't', role: 'user', content: 'x' });
    markAcked(s, ev);
    expect(shouldPush(s, ev)).toBe(false);
  });
});

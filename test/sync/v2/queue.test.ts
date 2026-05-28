import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQueue, enqueue, flushQueue } from '../../../src/sync/v2/queue.js';
import { rowToEnvelope } from '../../../src/sync/v2/envelope.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hmem-q-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const qpath = () => join(dir, 'f.queue.json');

const env = () => rowToEnvelope('entries', { uid: 'U', updated_at: '2026-05-25T10:00:00.000Z', deleted_at: null });
const blob = () => ({ proposed_id: 'U', data: 'enc', device_id: 'dev1', updated_at: '2026-05-25T10:00:00.000Z' });

describe('retry queue', () => {
  it('persists enqueued items (with their envelopes) across reload', () => {
    const q = loadQueue(qpath());
    enqueue(qpath(), q, [env()], [blob()]);
    const reloaded = loadQueue(qpath());
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].envelopes[0].key).toBe('U');
  });

  it('flush drains items on success, returns them in `sent`, and removes the file', async () => {
    const q = loadQueue(qpath());
    enqueue(qpath(), q, [env()], [blob()]);
    const { ok, sent } = await flushQueue(qpath(), loadQueue(qpath()), async () => { /* success */ });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(loadQueue(qpath())).toHaveLength(0);
    expect(existsSync(qpath())).toBe(false); // compacted away when empty
  });

  it('flush keeps items and bumps attempts when the sender throws (offline)', async () => {
    const q = loadQueue(qpath());
    enqueue(qpath(), q, [env()], [blob()]);
    const { ok, sent } = await flushQueue(qpath(), loadQueue(qpath()), async () => { throw new Error('network down'); });
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
    const after = loadQueue(qpath());
    expect(after).toHaveLength(1);
    expect(after[0].attempts).toBe(1);
  });

  it('re-uses the same idempotency_key on retry', async () => {
    const q = loadQueue(qpath());
    enqueue(qpath(), q, [env()], [blob()]);
    const key1 = loadQueue(qpath())[0].idempotency_key;
    await flushQueue(qpath(), loadQueue(qpath()), async () => { throw new Error('down'); });
    const key2 = loadQueue(qpath())[0].idempotency_key;
    expect(key2).toBe(key1);
  });

  it('splits a large batch into chunks of at most 500 blobs (server push cap)', () => {
    const N = 1200;
    const envs = Array.from({ length: N }, (_, i) => rowToEnvelope('entries', { uid: 'U' + i, updated_at: '2026-05-25T10:00:00.000Z', deleted_at: null }));
    const blobs = Array.from({ length: N }, (_, i) => ({ proposed_id: 'U' + i, data: 'enc', device_id: 'dev1', updated_at: '2026-05-25T10:00:00.000Z' }));
    const q = loadQueue(qpath());
    enqueue(qpath(), q, envs, blobs);
    const items = loadQueue(qpath());
    expect(items.map((i) => i.blobs.length)).toEqual([500, 500, 200]);          // 500 + 500 + 200
    expect(new Set(items.map((i) => i.idempotency_key)).size).toBe(3);          // distinct key per chunk
    expect(items[2].envelopes).toHaveLength(200);                               // envelopes chunked in lockstep
    expect(items[2].envelopes[199].key).toBe('U1199');                          // index pairing preserved
    expect(items[2].blobs[199].proposed_id).toBe('U1199');
  });

  it('drains older items before stopping at the first failure', async () => {
    const q = loadQueue(qpath());
    enqueue(qpath(), q, [env()], [blob()]); // item 1
    enqueue(qpath(), q, [env()], [blob()]); // item 2
    let calls = 0;
    const { ok, sent } = await flushQueue(qpath(), loadQueue(qpath()), async () => {
      calls += 1;
      if (calls === 2) throw new Error('down on 2nd');
    });
    expect(ok).toBe(false);
    expect(sent).toHaveLength(1);              // first item drained
    expect(loadQueue(qpath())).toHaveLength(1); // second remains
  });
});

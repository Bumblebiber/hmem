import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2Store } from '../../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../../src/hmem-config.js';
import { pushV2, pullV2 } from '../../../src/sync/v2/sync.js';
import type { SyncTransport, PulledBlob } from '../../../src/sync/v2/transport.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hmem-sync-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const passphrase = 'test-passphrase-1234';
// 32-byte salt → 44-char base64 (satisfies the server CreateFileSchema min(44))
const SALT = Buffer.alloc(32, 1).toString('base64');

// minimal in-test transport: append-only log, monotonic per-push clock, idempotency dedup
function fakeTransport(): SyncTransport {
  let clock = 0;
  const log: PulledBlob[] = [];
  const seen = new Set<string>();
  return {
    async push({ idempotency_key, blobs }) {
      if (seen.has(idempotency_key)) return { mappings: [] };
      seen.add(idempotency_key);
      clock += 1;
      const srt = new Date(clock * 1000).toISOString();
      const base = log.length;
      blobs.forEach((b, i) => log.push({ id: base + i + 1, client_proposed_id: b.proposed_id, data: b.data, device_id: b.device_id, created_at: srt, updated_at: b.updated_at, deleted_at: null, server_received_at: srt }));
      return { mappings: blobs.map((b, i) => ({ proposed_id: b.proposed_id, final_id: base + i + 1 })) };
    },
    async pull({ since }) {
      const blobs = log.filter((b) => !since || b.server_received_at > since);
      return { blobs, server_time: new Date((clock + 1) * 1000).toISOString(), salt: null };
    },
  };
}

describe('pushV2 / pullV2 round-trip', () => {
  it('pushes local entries and pulls them into a second store', async () => {
    const transport = fakeTransport();
    const A = createV2Store(join(dir, 'A.hmem'), DEFAULT_CONFIG);
    A.entries.createEntry({ prefix: 'P', level_1: 'FromA' });
    await pushV2({ store: A, transport, dir, fileId: 'f', deviceId: 'A', passphrase, salt: SALT });

    const B = createV2Store(join(dir, 'B.hmem'), DEFAULT_CONFIG);
    await pullV2({ store: B, transport, dir, fileId: 'f', deviceId: 'B', passphrase, salt: SALT });
    expect(B.entries.getEntryByLabel('P0001')?.level_1).toBe('FromA');
    A.close(); B.close();
  });

  it('a second push with no new local writes pushes nothing (no echo)', async () => {
    const transport = fakeTransport();
    const A = createV2Store(join(dir, 'A.hmem'), DEFAULT_CONFIG);
    A.entries.createEntry({ prefix: 'P', level_1: 'FromA' });
    const args = { store: A, transport, dir, fileId: 'f', deviceId: 'A', passphrase, salt: SALT };
    const first = await pushV2(args);
    expect(first.pushed).toBeGreaterThan(0);
    const second = await pushV2(args);
    expect(second.pushed).toBe(0);
    A.close();
  });

  it('retry hole: a row queued offline is acked on reconnect, then a third push sends nothing', async () => {
    const real = fakeTransport();
    let online = false;
    const toggle: SyncTransport = {
      push: async (req) => { if (!online) throw new Error('offline'); return real.push(req); },
      pull: real.pull,
    };
    const A = createV2Store(join(dir, 'A.hmem'), DEFAULT_CONFIG);
    A.entries.createEntry({ prefix: 'P', level_1: 'FromA' });
    const args = { store: A, transport: toggle, dir, fileId: 'f', deviceId: 'A', passphrase, salt: SALT };

    const r1 = await pushV2(args);
    expect(r1.queued).toBe(true);
    expect(r1.pushed).toBe(0);

    online = true;
    const r2 = await pushV2(args);
    expect(r2.queued).toBe(false);
    expect(r2.pushed).toBeGreaterThan(0);

    const r3 = await pushV2(args);
    expect(r3.pushed).toBe(0);
    A.close();
  });
});

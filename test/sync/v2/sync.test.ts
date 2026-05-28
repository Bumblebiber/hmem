import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2Store } from '../../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../../src/hmem-config.js';
import { pushV2, pullV2 } from '../../../src/sync/v2/sync.js';
import type { SyncTransport, PulledBlob, PushBlob } from '../../../src/sync/v2/transport.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hmem-sync-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const passphrase = 'test-passphrase-1234';
// 32-byte salt → 44-char base64 (satisfies the server CreateFileSchema min(44))
const SALT = Buffer.alloc(32, 1).toString('base64');

// In-test transport modelling the real server: upsert by client_proposed_id, monotonic change_seq,
// idempotency dedup, base64url change_seq cursor, lenient decode, and pagination by `pageSize`.
function fakeTransport(pageSize = 1000): SyncTransport {
  let seq = 0;
  const rows: { blob: PulledBlob; change_seq: number }[] = [];
  const seen = new Set<string>();
  const enc = (s: number) => Buffer.from(JSON.stringify({ s: String(s) })).toString('base64url');
  const dec = (c: string | null): number => {
    if (!c) return 0;
    try {
      const o = JSON.parse(Buffer.from(c, 'base64url').toString()) as { s?: unknown };
      return typeof o.s === 'string' && /^\d+$/.test(o.s) ? Number(o.s) : 0;
    } catch { return 0; }
  };
  return {
    async push({ idempotency_key, blobs }) {
      if (seen.has(idempotency_key)) return { mappings: [] };
      seen.add(idempotency_key);
      const mappings: { proposed_id: string; final_id: number }[] = [];
      for (const b of blobs) {
        seq += 1;
        const srt = new Date(seq * 1000).toISOString();
        const existing = rows.find((x) => x.blob.client_proposed_id === b.proposed_id);
        if (existing) {
          existing.blob.data = b.data; existing.blob.updated_at = b.updated_at;
          existing.blob.server_received_at = srt; existing.change_seq = seq;
          mappings.push({ proposed_id: b.proposed_id, final_id: existing.blob.id });
        } else {
          const id = rows.length + 1;
          rows.push({ change_seq: seq, blob: { id, client_proposed_id: b.proposed_id, data: b.data, device_id: b.device_id, created_at: srt, updated_at: b.updated_at, deleted_at: null, server_received_at: srt } });
          mappings.push({ proposed_id: b.proposed_id, final_id: id });
        }
      }
      return { mappings };
    },
    async pull({ cursor }) {
      const after = dec(cursor);
      const matching = rows.filter((r) => r.change_seq > after).sort((a, b) => a.change_seq - b.change_seq);
      const pageRows = matching.slice(0, pageSize);
      const has_more = matching.length > pageSize;
      const last = pageRows.length ? pageRows[pageRows.length - 1].change_seq : after;
      return { blobs: pageRows.map((r) => ({ ...r.blob })), server_time: new Date((seq + 1) * 1000).toISOString(), salt: null, has_more, next_cursor: enc(last) };
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

  it('pullV2 pages until has_more is false and applies every page', async () => {
    const transport = fakeTransport(2);  // tiny pages → forces the loop
    const A = createV2Store(join(dir, 'A.hmem'), DEFAULT_CONFIG);
    for (let i = 0; i < 5; i++) A.entries.createEntry({ prefix: 'P', level_1: `E${i}` });
    await pushV2({ store: A, transport, dir, fileId: 'f', deviceId: 'A', passphrase, salt: SALT });
    const B = createV2Store(join(dir, 'B.hmem'), DEFAULT_CONFIG);
    await pullV2({ store: B, transport, dir, fileId: 'f', deviceId: 'B', passphrase, salt: SALT });
    for (let i = 1; i <= 5; i++) expect(B.entries.getEntryByLabel(`P000${i}`)?.level_1).toBeDefined();
    A.close(); B.close();
  });

  it('pullV2 is incremental across sessions: a persisted cursor pulls only new rows', async () => {
    const transport = fakeTransport();
    let lastPullCount = -1;
    const spy: SyncTransport = { push: transport.push, pull: async (req) => { const r = await transport.pull(req); lastPullCount = r.blobs.length; return r; } };
    const A = createV2Store(join(dir, 'A.hmem'), DEFAULT_CONFIG);
    A.entries.createEntry({ prefix: 'P', level_1: 'first' });
    A.entries.createEntry({ prefix: 'P', level_1: 'extra-1' });
    A.entries.createEntry({ prefix: 'P', level_1: 'extra-2' });
    await pushV2({ store: A, transport: spy, dir, fileId: 'f', deviceId: 'A', passphrase, salt: SALT });
    const B = createV2Store(join(dir, 'B.hmem'), DEFAULT_CONFIG);
    await pullV2({ store: B, transport: spy, dir, fileId: 'f', deviceId: 'B', passphrase, salt: SALT });
    const firstPull = lastPullCount;  // full pull (≥3 rows)
    expect(firstPull).toBeGreaterThanOrEqual(3);
    // A writes one more; push it; B pulls again with the persisted cursor.
    A.entries.createEntry({ prefix: 'P', level_1: 'second' });
    await pushV2({ store: A, transport: spy, dir, fileId: 'f', deviceId: 'A', passphrase, salt: SALT });
    await pullV2({ store: B, transport: spy, dir, fileId: 'f', deviceId: 'B', passphrase, salt: SALT });
    expect(B.entries.getEntryByLabel('P0004')?.level_1).toBe('second');
    // Incremental: only the 1 new row, not a full re-pull (which would be ≥ firstPull again).
    expect(lastPullCount).toBe(1);
    expect(lastPullCount).toBeLessThan(firstPull);
    A.close(); B.close();
  });

  it('pushV2 sends the full envelope key and ISO-normalized updated_at on the wire', async () => {
    const captured: PushBlob[] = [];
    const transport: SyncTransport = {
      async push({ blobs }) { captured.push(...blobs); return { mappings: blobs.map((b, i) => ({ proposed_id: b.proposed_id, final_id: i + 1 })) }; },
      async pull() { return { blobs: [], server_time: '', salt: null, has_more: false, next_cursor: '' }; },
    };
    const A = createV2Store(join(dir, 'A.hmem'), DEFAULT_CONFIG);
    A.entries.createEntry({ prefix: 'P', level_1: 'X' });
    // Simulate the v1-migrated non-ISO updated_at the live store still carries (space format).
    A.db.prepare("UPDATE entries SET updated_at = '2026-05-01 12:00:00' WHERE label = 'P0001'").run();
    await pushV2({ store: A, transport, dir, fileId: 'f', deviceId: 'A', passphrase, salt: SALT });
    expect(captured.length).toBeGreaterThan(0);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
    for (const b of captured) expect(b.updated_at).toMatch(iso);     // every blob ISO (events/links → epoch)
    expect(captured.some((b) => b.updated_at === '2026-05-01T12:00:00Z')).toBe(true);  // the normalized one
    // No slice() crippling — full key preserved (compound 53-char keys covered server-side).
    expect(captured.every((b) => b.proposed_id.length <= 120)).toBe(true);
    A.close();
  });
});

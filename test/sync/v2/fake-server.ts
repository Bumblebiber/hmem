import type { SyncTransport, PushBlob, PulledBlob } from '../../../src/sync/v2/transport.js';

/** Faithful to packages/server/src/routes/sync.ts: an encrypted blob store keyed by
 *  client_proposed_id with an idempotent UPSERT, a monotonic change_seq bumped on every insert
 *  AND update, idempotency-key dedup, a base64url {s:"<change_seq>"} pagination cursor (lenient
 *  decode → s=0), has_more/next_cursor paging, and the schema_major gate.
 *  One instance == one server file shared by all devices. */
export class FakeSyncServer {
  private rows = new Map<string, { blob: PulledBlob; change_seq: number }>();
  private seen = new Set<string>();
  private seq = 0;
  constructor(public schemaMajor = 2, public salt: string | null = null, private pageSize = 2000) {}
  private iso(n: number): string { return new Date(n * 1000).toISOString(); }
  blobCount(): number { return this.rows.size; }

  private static enc(s: number): string { return Buffer.from(JSON.stringify({ s: String(s) })).toString('base64url'); }
  private static dec(c: string | null): number {
    if (!c) return 0;
    try {
      const o = JSON.parse(Buffer.from(c, 'base64url').toString()) as { s?: unknown };
      return typeof o.s === 'string' && /^\d+$/.test(o.s) ? Number(o.s) : 0;
    } catch { return 0; }
  }

  transport(): SyncTransport {
    return {
      push: async ({ idempotency_key, client_schema_major, blobs }) => {
        if (client_schema_major !== this.schemaMajor) {
          const e = new Error('SCHEMA_MISMATCH') as Error & { status?: number }; e.status = 409; throw e;
        }
        if (this.seen.has(idempotency_key)) return { mappings: [] };
        this.seen.add(idempotency_key);
        const mappings = blobs.map((b: PushBlob) => {
          this.seq += 1;
          const srt = this.iso(this.seq);
          const existing = this.rows.get(b.proposed_id);
          if (existing) {                                 // UPSERT: overwrite + bump change_seq
            existing.blob.data = b.data; existing.blob.device_id = b.device_id;
            existing.blob.updated_at = b.updated_at; existing.blob.server_received_at = srt;
            existing.change_seq = this.seq;
            return { proposed_id: b.proposed_id, final_id: existing.blob.id };
          }
          const id = this.rows.size + 1;
          this.rows.set(b.proposed_id, { change_seq: this.seq, blob: { id, client_proposed_id: b.proposed_id, data: b.data, device_id: b.device_id, created_at: srt, updated_at: b.updated_at, deleted_at: null, server_received_at: srt } });
          return { proposed_id: b.proposed_id, final_id: id };
        });
        return { mappings };
      },
      pull: async ({ cursor, client_schema_major }) => {
        if (client_schema_major !== this.schemaMajor) {
          const e = new Error('SCHEMA_MISMATCH') as Error & { status?: number }; e.status = 409; throw e;
        }
        const after = FakeSyncServer.dec(cursor);
        const ordered = [...this.rows.values()].filter((r) => r.change_seq > after).sort((a, b) => a.change_seq - b.change_seq);
        const page = ordered.slice(0, this.pageSize);
        const has_more = ordered.length > this.pageSize;
        const last = page.length ? page[page.length - 1].change_seq : after;
        return { blobs: page.map((r) => ({ ...r.blob })), server_time: this.iso(this.seq), salt: this.salt, has_more, next_cursor: FakeSyncServer.enc(last) };
      },
    };
  }
}

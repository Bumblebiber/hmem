import type { SyncTransport, PushBlob, PulledBlob } from '../../../src/sync/v2/transport.js';

/** Faithful to packages/server/src/routes/sync.ts: append-only encrypted blob log, monotonic
 *  per-PUSH server_received_at, idempotency-key dedup, strict-`>` since cursor, schema_major gate.
 *  One instance == one server file shared by all devices. */
export class FakeSyncServer {
  private log: PulledBlob[] = [];
  private seen = new Set<string>();
  private clock = 0;
  constructor(public schemaMajor = 2, public salt: string | null = null) {}
  private iso(n: number): string { return new Date(n * 1000).toISOString(); }
  blobCount(): number { return this.log.length; }

  transport(): SyncTransport {
    return {
      push: async ({ idempotency_key, client_schema_major, blobs }) => {
        if (client_schema_major !== this.schemaMajor) {
          const e = new Error('SCHEMA_MISMATCH') as Error & { status?: number }; e.status = 409; throw e;
        }
        if (this.seen.has(idempotency_key)) return { mappings: [] };
        this.seen.add(idempotency_key);
        this.clock += 1;
        const srt = this.iso(this.clock);
        const mappings = blobs.map((b: PushBlob) => {
          const id = this.log.length + 1;
          this.log.push({ id, client_proposed_id: b.proposed_id, data: b.data, device_id: b.device_id, created_at: srt, updated_at: b.updated_at, deleted_at: null, server_received_at: srt });
          return { proposed_id: b.proposed_id, final_id: id };
        });
        return { mappings };
      },
      pull: async ({ since, client_schema_major }) => {
        if (client_schema_major !== this.schemaMajor) {
          const e = new Error('SCHEMA_MISMATCH') as Error & { status?: number }; e.status = 409; throw e;
        }
        const blobs = this.log.filter((b) => !since || b.server_received_at > since);
        return { blobs, server_time: this.iso(this.clock), salt: this.salt }; // CURRENT clock — no fencepost
      },
    };
  }
}

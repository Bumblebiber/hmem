import type { HmemSyncClient } from '../api.js';

export interface PushBlob { proposed_id: string; data: string; device_id: string; updated_at: string }
export interface PulledBlob {
  id: number; client_proposed_id: string | null; data: string; device_id: string | null;
  created_at: string; updated_at: string; deleted_at: string | null; server_received_at: string;
}
export interface SyncTransport {
  push(req: { file_id: string; idempotency_key: string; client_schema_major: number; blobs: PushBlob[] }):
    Promise<{ mappings: { proposed_id: string; final_id: number }[] }>;
  pull(req: { file_id: string; since: string | null; client_schema_major: number }):
    Promise<{ blobs: PulledBlob[]; server_time: string; salt: string | null }>;
}

/** Adapt the HTTP client to the SyncTransport seam; always tags requests client_schema_major=2. */
export function makeHttpTransport(client: HmemSyncClient): SyncTransport {
  return {
    async push(req) {
      return client.push({ file_id: req.file_id, idempotency_key: req.idempotency_key, client_schema_major: req.client_schema_major, blobs: req.blobs });
    },
    async pull(req) {
      const r = await client.pull(req.file_id, req.since ?? undefined, req.client_schema_major);
      return {
        blobs: r.blobs.map((b) => ({
          id: b.id, client_proposed_id: b.client_proposed_id ?? null, data: b.data,
          device_id: null, created_at: '', updated_at: b.updated_at,
          deleted_at: b.deleted_at ?? null, server_received_at: (b as { server_received_at?: string }).server_received_at ?? r.server_time,
        })),
        server_time: r.server_time, salt: r.salt ?? null,
      };
    },
  };
}

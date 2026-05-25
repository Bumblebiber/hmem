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

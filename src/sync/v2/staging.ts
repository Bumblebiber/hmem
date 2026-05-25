import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { BlobEnvelope, V2Table } from './envelope.js';
import { stagingKey } from './envelope.js';

export interface AckRecord { table: V2Table; key: string; lww: string | null; deleted: boolean }
export interface V2Staging { file_id: string; cursor: string | null; acked: Record<string, AckRecord> }

export function loadStaging(path: string, fileId: string): V2Staging {
  if (!existsSync(path)) return { file_id: fileId, cursor: null, acked: {} };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as V2Staging;
  return { file_id: raw.file_id ?? fileId, cursor: raw.cursor ?? null, acked: raw.acked ?? {} };
}

export function saveStaging(path: string, s: V2Staging): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, path); // atomic replace
}

/** True iff this local version is newer than what the server is known to have.
 *  Strict `>` on the LWW value: exact-timestamp ties with divergent content are a
 *  known pre-existing caveat (same class as the server cursor edge), out of scope here.
 *  Pull-side reconciliation still uses the full pickWinner total order; this push gate
 *  only needs "is my local copy strictly ahead of the version the server already has?". */
export function shouldPush(s: V2Staging, e: BlobEnvelope): boolean {
  const k = stagingKey(e.table, e.key);
  const ack = s.acked[k];
  if (!ack) return true;
  if (e.table === 'events') return false; // write-once: presence ⇒ done
  return (e.lww ?? '') > (ack.lww ?? '');  // mutable: push only if strictly newer
}

export function markAcked(s: V2Staging, e: BlobEnvelope): void {
  s.acked[stagingKey(e.table, e.key)] = { table: e.table, key: e.key, lww: e.lww, deleted: e.deleted };
}

export function setCursor(s: V2Staging, serverTime: string): void {
  s.cursor = serverTime;
}

/** Prune ack records that are tombstoned AND no longer present in the live store key set
 *  (i.e. hard-deleted, not merely soft-deleted). Events (write-once union) are never pruned.
 *  `liveKeys` = `${table}:${key}` for every row currently in the store. The v2 ledger is already
 *  bounded (one record per entity); this only reclaims records for entities that physically vanished. */
export function gcStaging(s: V2Staging, liveKeys: Set<string>): void {
  for (const [k, ack] of Object.entries(s.acked)) {
    if (ack.table === 'events') continue;
    if (ack.deleted && !liveKeys.has(k)) delete s.acked[k];
  }
}

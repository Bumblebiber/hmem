import { join } from 'node:path';
import type { V2Store } from '../../v2/store-facade.js';
import type { SyncTransport, PushBlob } from './transport.js';
import { exportV2, collectLiveKeys } from './export.js';
import { importV2 } from './import.js';
import { loadStaging, saveStaging, markAcked, setCursor, gcStaging } from './staging.js';
import { loadQueue, enqueue, flushQueue } from './queue.js';
import { stagingKey } from './envelope.js';
import type { BlobEnvelope } from './envelope.js';
import { encrypt, decrypt, deriveKey } from '../crypto.js';
import { toIso } from '../../util/iso.js';

export interface SyncArgs {
  store: V2Store; transport: SyncTransport; dir: string; fileId: string;
  deviceId: string; passphrase: string; salt: string;
}

const stagingPath = (dir: string, fileId: string) => join(dir, `${fileId}.v2.json`);
const queuePath = (dir: string, fileId: string) => join(dir, `${fileId}.queue.json`);

export async function pushV2(a: SyncArgs): Promise<{ pushed: number; queued: boolean }> {
  const stgPath = stagingPath(a.dir, a.fileId);
  const qPath = queuePath(a.dir, a.fileId);
  const staging = loadStaging(stgPath, a.fileId);
  const key = deriveKey(a.passphrase, a.salt);

  const queue = loadQueue(qPath);
  const inFlight = new Set<string>();
  for (const item of queue) for (const e of item.envelopes) inFlight.add(stagingKey(e.table, e.key));

  const envelopes = exportV2(a.store, staging, inFlight);
  if (envelopes.length > 0) {
    const blobs: PushBlob[] = envelopes.map((e) => ({
      proposed_id: e.key,                                       // full key — never sliced (compound keys are 53 chars)
      data: encrypt(JSON.stringify(e), key),
      device_id: a.deviceId,
      updated_at: e.lww ? toIso(e.lww) : new Date(0).toISOString(),  // ISO-normalize; null lww (events/links) → epoch
    }));
    enqueue(qPath, queue, envelopes, blobs);
  }

  const { ok, sent } = await flushQueue(qPath, loadQueue(qPath), async (item) => {
    await a.transport.push({ file_id: a.fileId, idempotency_key: item.idempotency_key, client_schema_major: 2, blobs: item.blobs });
  });

  let pushed = 0;
  for (const item of sent) for (const e of item.envelopes) { markAcked(staging, e); pushed++; }
  saveStaging(stgPath, staging);
  return { pushed, queued: !ok };
}

export async function pullV2(a: SyncArgs): Promise<{ applied: number }> {
  const stgPath = stagingPath(a.dir, a.fileId);
  const staging = loadStaging(stgPath, a.fileId);
  const key = deriveKey(a.passphrase, a.salt);

  let cursor = staging.cursor;            // opaque change_seq cursor; a stale legacy ISO on first
                                          // upgrade is tolerated by the server (treated as s=0).
  let applied = 0;
  let res: Awaited<ReturnType<typeof a.transport.pull>>;
  do {
    res = await a.transport.pull({ file_id: a.fileId, cursor, client_schema_major: 2 });
    const envelopes: BlobEnvelope[] = res.blobs.map((b) => JSON.parse(decrypt(b.data, key)) as BlobEnvelope);
    const stats = importV2(a.store, staging, envelopes);
    applied += stats.inserted + stats.updated + stats.unioned;
    cursor = res.next_cursor ?? cursor;   // defensive vs. a momentarily-old server (field absent)
  } while (res.has_more === true);

  setCursor(staging, cursor);             // persist only after the full paged pull completes
  gcStaging(staging, collectLiveKeys(a.store));
  saveStaging(stgPath, staging);
  return { applied };
}

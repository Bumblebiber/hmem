import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { PushBlob } from './transport.js';
import type { BlobEnvelope } from './envelope.js';

export interface QueueItem {
  idempotency_key: string;
  envelopes: BlobEnvelope[];   // paired by index with blobs; lets a successful send ack exactly these rows
  blobs: PushBlob[];
  created_at: string;
  attempts: number;
}

export function loadQueue(path: string): QueueItem[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as QueueItem[];
}

function save(path: string, q: QueueItem[]): void {
  if (q.length === 0) { if (existsSync(path)) rmSync(path); return; } // compact: no empty-array file left behind
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(q));
  renameSync(tmp, path);
}

export function enqueue(path: string, q: QueueItem[], envelopes: BlobEnvelope[], blobs: PushBlob[]): QueueItem {
  const item: QueueItem = { idempotency_key: randomUUID(), envelopes, blobs, created_at: new Date().toISOString(), attempts: 0 };
  q.push(item);
  save(path, q);
  return item;
}

/** Send queued items oldest-first. On the first send error: bump that item's attempts, persist,
 *  return { ok:false, sent:<items accepted so far> }. On full drain: persist (file removed when
 *  empty), return { ok:true, sent:<all items> }. The caller acks every envelope in `sent`. */
export async function flushQueue(
  path: string,
  q: QueueItem[],
  send: (item: QueueItem) => Promise<void>,
): Promise<{ ok: boolean; sent: QueueItem[] }> {
  const sent: QueueItem[] = [];
  while (q.length > 0) {
    const item = q[0];
    try {
      await send(item);
      q.shift();
      sent.push(item);
      save(path, q);
    } catch {
      item.attempts += 1;
      save(path, q);
      return { ok: false, sent };
    }
  }
  return { ok: true, sent };
}

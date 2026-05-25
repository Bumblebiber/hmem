import type { BlobEnvelope } from './envelope.js';
import { canonicalJson } from './envelope.js';

/** Deterministic total order for two envelopes with the SAME key. Returns the winner. */
export function pickWinner(a: BlobEnvelope, b: BlobEnvelope): BlobEnvelope {
  // events are write-once: identical key ⇒ identical payload; either is fine.
  if (a.table === 'events') return a;

  // session_bindings: closed (to_seq set) beats open (to_seq null).
  if (a.table === 'session_bindings') {
    const aClosed = a.row.to_seq != null;
    const bClosed = b.row.to_seq != null;
    if (aClosed !== bClosed) return aClosed ? a : b;
  }

  const ax = `${a.lww ?? ''} ${canonicalJson(a.row)}`;
  const bx = `${b.lww ?? ''} ${canonicalJson(b.row)}`;
  return ax >= bx ? a : b;
}

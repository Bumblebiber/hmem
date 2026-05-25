import type { EventRow } from '../store/types.js';

/**
 * Phase 4 summarizer: deterministic, key-free fallback. The real Haiku adapter
 * (src/summarize/anthropic.ts) is key-gated and wired in Phase 5. Until then,
 * segment flushes produce a cheap, deterministic one-liner so binding boundaries
 * never block on a network call.
 */
export function fallbackSummarize(events: EventRow[]): string {
  if (!events.length) return '';
  const first = events[0]?.content?.split('\n')[0]?.slice(0, 120) ?? '';
  const last = events[events.length - 1]?.content?.split('\n')[0]?.slice(0, 120) ?? '';
  return events.length === 1 ? first : `${first} … ${last}`;
}

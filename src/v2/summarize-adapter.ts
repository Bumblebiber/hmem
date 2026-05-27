import type { EventRow } from '../store/types.js';

/**
 * Phase 4 summarizer: deterministic, key-free fallback. The real Haiku adapter
 * (src/summarize/anthropic.ts) is key-gated and wired in Phase 5. Until then,
 * segment flushes produce a cheap, deterministic one-liner so binding boundaries
 * never block on a network call.
 *
 * Output shape: "<first user line, ≤60 chars> — <n> exchange[s]"
 * Degrades to the first available line when no user-role event is present.
 */
export function fallbackSummarize(events: EventRow[]): string {
  if (!events.length) return '';
  const titleEvent = events.find((e) => e.role === 'user') ?? events[0]!;
  const title = titleEvent.content.split('\n')[0]!.slice(0, 60);
  const n = events.length;
  const label = n === 1 ? 'exchange' : 'exchanges';
  return `${title} — ${n} ${label}`;
}

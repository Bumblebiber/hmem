/**
 * Single process-wide monotonic ULID factory.
 *
 * `monotonicFactory()` guarantees that ULIDs generated within the same
 * millisecond are still strictly lexicographically increasing — Phase 2's
 * per-session `events.seq` ordering relies on this under burst writes.
 */
import { monotonicFactory } from 'ulid';

export const newUlid = monotonicFactory();

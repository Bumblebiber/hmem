/**
 * Session Cache — tracks which memory entries were delivered to an agent
 * within the current MCP session.
 *
 * Three-phase lifecycle per entry:
 *   1. Hidden (< 5 min):    completely excluded from output
 *   2. Title-only (5–30 min): shown as compact one-liner, no expansion
 *   3. Expired (> 30 min):   removed from cache, can be expanded again
 *
 * Promoted entries (favorites/most-accessed) have a shorter main TTL (15 min).
 *
 * Slot reduction: each successive bulk read halves the expansion percentage
 * (20% → 10% → 5% → ...). The min caps in config prevent it from hitting zero.
 */

interface CacheEntry {
  deliveredAt: number;
  promoted: boolean;
}

export class SessionCache {
  private cache = new Map<string, CacheEntry>();
  private bulkReads = 0;
  private ttlHidden = 5 * 60 * 1000;      // 5 min — completely hidden
  private ttlNormal = 30 * 60 * 1000;     // 30 min — title-only → expired
  private ttlPromoted = 15 * 60 * 1000;   // 15 min — promoted title-only → expired

  /** Entries past hidden phase but within main TTL — shown as title-only. */
  getCachedIds(): Set<string> {
    this.prune();
    const now = Date.now();
    const result = new Set<string>();
    for (const [id, entry] of this.cache) {
      if (now - entry.deliveredAt >= this.ttlHidden) {
        result.add(id);
      }
    }
    return result;
  }

  /** Entries within hidden phase (< 5 min) — completely excluded from output. */
  getHiddenIds(): Set<string> {
    this.prune();
    const now = Date.now();
    const result = new Set<string>();
    for (const [id, entry] of this.cache) {
      if (now - entry.deliveredAt < this.ttlHidden) {
        result.add(id);
      }
    }
    return result;
  }

  /** Slot reduction factor: 1.0 → 0.5 → 0.25 → ... (halves each read). */
  getSlotFraction(): number {
    return Math.pow(0.5, this.bulkReads);
  }

  /**
   * Register entry IDs that were delivered in this bulk read.
   * Call after formatting the output.
   *
   * @param entryIds - All entry IDs included in the bulk read output
   * @param promotedIds - Subset that are favorites or most-accessed (shorter TTL)
   */
  registerDelivered(entryIds: string[], promotedIds?: Set<string>): void {
    const now = Date.now();
    for (const id of entryIds) {
      if (!this.cache.has(id)) {
        this.cache.set(id, {
          deliveredAt: now,
          promoted: promotedIds?.has(id) ?? false,
        });
      }
    }
    this.bulkReads++;
  }

  /** Current bulk read number (0-based). */
  get readCount(): number {
    return this.bulkReads;
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all tracked entries and reset bulk read counter.
   * After reset, the next bulk read behaves like the first read of a new session.
   */
  reset(): void {
    this.cache.clear();
    this.bulkReads = 0;
  }

  /** Remove expired entries (past main TTL). */
  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      const ttl = entry.promoted ? this.ttlPromoted : this.ttlNormal;
      if (now - entry.deliveredAt > ttl) {
        this.cache.delete(id);
      }
    }
  }
}

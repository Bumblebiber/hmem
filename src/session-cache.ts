/**
 * Session Cache — tracks which memory entries were delivered to an agent
 * within the current MCP session. Prevents showing the same entries twice.
 *
 * Two lists with different TTLs:
 *   List A (normal entries): long TTL (default 30 min)
 *   List B (favorites + most-accessed): shorter TTL — more important, resurface sooner
 *
 * Fibonacci-like decay for successive bulk reads:
 *   Read 1: 5 newest + 3 most-accessed per prefix
 *   Read 2: 3 newest + 2 most-accessed
 *   Read 3: 2 newest + 1 most-accessed
 *   Read 4: 1 newest + 1 most-accessed
 *   Read 5+: 0 → nothing new until TTL expires
 *
 * Already-delivered entries are completely hidden (not shown as [cached]).
 */

export interface SessionCacheConfig {
  /** TTL for normal entries in ms (default: 30 min). */
  ttlNormal: number;
  /** TTL for promoted entries (favorites + most-accessed) in ms (default: 15 min). */
  ttlPromoted: number;
  /** Fibonacci-like sequence for newest entries per prefix per bulk read. */
  fibNewest: number[];
  /** Fibonacci-like sequence for most-accessed entries per prefix per bulk read. */
  fibAccess: number[];
}

const DEFAULT_SESSION_CACHE_CONFIG: SessionCacheConfig = {
  ttlNormal: 30 * 60 * 1000,     // 30 min
  ttlPromoted: 15 * 60 * 1000,   // 15 min
  fibNewest: [5, 3, 2, 1, 0],
  fibAccess: [3, 2, 1, 1, 0],
};

interface CacheEntry {
  deliveredAt: number;  // Date.now() when first delivered
  promoted: boolean;    // true = favorite/most-accessed → shorter TTL
}

export class SessionCache {
  private cache = new Map<string, CacheEntry>();
  private bulkReadCount = 0;
  private cfg: SessionCacheConfig;

  constructor(config?: Partial<SessionCacheConfig>) {
    this.cfg = { ...DEFAULT_SESSION_CACHE_CONFIG, ...config };
  }

  /**
   * Get the set of entry IDs that should be hidden
   * because they were already delivered in a previous bulk read.
   * Expired entries are pruned first.
   */
  getSuppressedIds(): Set<string> {
    this.prune();
    return new Set(this.cache.keys());
  }

  /**
   * How many newest entries per prefix to show in the current bulk read.
   */
  getNewestSlotCount(): number {
    const seq = this.cfg.fibNewest;
    return seq[Math.min(this.bulkReadCount, seq.length - 1)];
  }

  /**
   * How many most-accessed entries per prefix to show in the current bulk read.
   */
  getAccessSlotCount(): number {
    const seq = this.cfg.fibAccess;
    return seq[Math.min(this.bulkReadCount, seq.length - 1)];
  }

  /**
   * Register entry IDs that were delivered in this bulk read.
   * Call after formatting the output.
   *
   * @param entryIds - All entry IDs included in the bulk read output
   * @param promotedIds - Subset that are favorites or most-accessed (shorter TTL)
   */
  registerDelivered(entryIds: string[], promotedIds: Set<string>): void {
    const now = Date.now();
    for (const id of entryIds) {
      if (!this.cache.has(id)) {
        this.cache.set(id, {
          deliveredAt: now,
          promoted: promotedIds.has(id),
        });
      }
    }
    this.bulkReadCount++;
  }

  /** Current bulk read number (0-based). */
  get readCount(): number {
    return this.bulkReadCount;
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
    this.bulkReadCount = 0;
  }

  /** Remove expired entries. */
  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      const ttl = entry.promoted ? this.cfg.ttlPromoted : this.cfg.ttlNormal;
      if (now - entry.deliveredAt > ttl) {
        this.cache.delete(id);
      }
    }
  }
}

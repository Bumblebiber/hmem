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
export declare class SessionCache {
    private cache;
    private bulkReads;
    private _totalTokensDelivered;
    private _thresholdReached;
    private ttlHidden;
    private ttlNormal;
    private ttlPromoted;
    /** Entries past hidden phase but within main TTL — shown as title-only. */
    getCachedIds(): Set<string>;
    /** Entries within hidden phase (< 5 min) — completely excluded from output. */
    getHiddenIds(): Set<string>;
    /** Slot reduction factor: 1.0 → 0.5 → 0.25 → ... (halves each read). */
    getSlotFraction(): number;
    /**
     * Register entry IDs that were delivered in this bulk read.
     * Call after formatting the output.
     *
     * @param entryIds - All entry IDs included in the bulk read output
     * @param promotedIds - Subset that are favorites or most-accessed (shorter TTL)
     */
    registerDelivered(entryIds: string[], promotedIds?: Set<string>): void;
    /** Current bulk read number (0-based). */
    get readCount(): number;
    /** Number of entries currently in the cache. */
    get size(): number;
    /** Add estimated tokens from a tool response output. */
    addTokens(chars: number): void;
    /** Cumulative tokens delivered this session. */
    get totalTokensDelivered(): number;
    /**
     * Check if threshold is crossed. Returns true only ONCE per threshold crossing
     * (resets after clear/reset). This prevents spamming the warning.
     */
    checkThreshold(threshold: number): boolean;
    /**
     * Clear all tracked entries and reset bulk read counter.
     * After reset, the next bulk read behaves like the first read of a new session.
     */
    reset(): void;
    /** Remove expired entries (past main TTL). */
    private prune;
}

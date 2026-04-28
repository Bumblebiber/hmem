/**
 * cli-delete.ts
 *
 * Permanently delete an entry by ID (curator use only).
 * Deletion is pushed to sync servers after local delete.
 * Note: sync servers must support tombstones for full propagation; otherwise
 * other devices may re-add the entry on next pull. Use `irrelevant` flag via
 * update_memory as a safer alternative for multi-device setups.
 *
 * Usage: hmem delete <ID> [--force]
 */
export declare function deleteEntry(args: string[]): Promise<void>;

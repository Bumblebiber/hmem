/**
 * cli-delete.ts
 *
 * Permanently delete an entry by ID (curator use only).
 * WARNING: Not synced — run on each device if multi-device sync is active.
 *
 * Usage: hmem delete <ID> [--force]
 */
export declare function deleteEntry(args: string[]): Promise<void>;

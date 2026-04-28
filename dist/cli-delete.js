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
import path from "node:path";
import { HmemStore } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";
import { syncPushSync } from "./mcp-shared.js";
export async function deleteEntry(args) {
    const id = args.find(a => !a.startsWith("--"))?.toUpperCase();
    const force = args.includes("--force");
    if (!id) {
        console.error("Usage: hmem delete <ID> [--force]");
        console.error("Example: hmem delete O0171");
        process.exit(1);
    }
    resolveEnvDefaults();
    const hmemPath = process.env.HMEM_PATH || "";
    if (!hmemPath) {
        console.error("HMEM_PATH not set — run hmem init or set the env variable.");
        process.exit(1);
    }
    const config = loadHmemConfig(path.dirname(hmemPath));
    const store = new HmemStore(hmemPath, config);
    // Check entry exists and show preview
    const entry = store.readEntry(id);
    if (!entry) {
        console.error(`Entry ${id} not found.`);
        process.exit(1);
    }
    console.log(`Entry to delete: ${entry.id}  ${entry.level_1}`);
    if (!force) {
        console.log(`\nRun with --force to confirm: hmem delete ${id} --force`);
        process.exit(0);
    }
    const ok = store.delete(id);
    if (ok) {
        console.log(`Deleted: ${id}`);
        const synced = syncPushSync(hmemPath);
        if (synced) {
            console.log("Synced to remote servers.");
        }
        else {
            console.log("WARNING: Sync failed or not configured. Delete on other devices manually if needed.");
        }
    }
    else {
        console.error(`Delete failed for ${id}.`);
        process.exit(1);
    }
}
//# sourceMappingURL=cli-delete.js.map
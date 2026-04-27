#!/usr/bin/env node
/**
 * hmem — Curate MCP Server (maintenance tools).
 *
 * Contains tools for memory curation, migration, and analysis.
 * Activate via /mcp when you need to curate, reorganize, or audit memory.
 * For daily read/write operations, use the hmem server instead.
 *
 * Environment variables: same as hmem server (HMEM_PATH, HMEM_PROJECT_DIR, etc.)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { openCompanyMemory, HmemStore } from "./hmem-store.js";
import { createRequire } from "node:module";
import {
  HMEM_PATH, PROJECT_DIR, hmemConfig, log,
  safeError, validateFilePath,
  syncPullThenPush, syncPush, syncPushWithRetry, resolveStore,
} from "./mcp-shared.js";

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = _require("../package.json").version;

// ---- Server ----
const server = new McpServer({
  name: "hmem-curate",
  version: PKG_VERSION,
});

// ---- Tool: update_many ----
server.tool(
  "update_many",
  "Batch-update multiple memory entries at once. Applies the same flag(s) to all listed IDs. " +
    "Use this instead of calling update_memory multiple times during curation.\n\n" +
    "Example: update_many(ids=['T0005', 'T0012', 'L0044'], irrelevant=true)",
  {
    ids: z.array(z.string()).min(1).describe("List of entry/node IDs to update, e.g. ['T0005', 'T0012', 'L0044']"),
    irrelevant: z.coerce.boolean().optional().describe("Mark all as irrelevant [-]"),
    favorite: z.coerce.boolean().optional().describe("Set or clear [♥] favorite on all"),
    active: z.coerce.boolean().optional().describe("Set or clear [*] active on all"),
    pinned: z.coerce.boolean().optional().describe("Set or clear [P] pinned on all"),
    store: z.enum(["personal", "company"]).default("personal"),
  },
  async ({ ids, irrelevant, favorite, active, pinned, store: storeName }) => {
    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : new HmemStore(HMEM_PATH, hmemConfig);
      try {
        if (storeName === "personal") syncPullThenPush(HMEM_PATH);

        let updated = 0;
        let notFound = 0;
        for (const id of ids) {
          const ok = hmemStore.updateNode(id, undefined as any, undefined, undefined, favorite, undefined, irrelevant, undefined, pinned, active);
          if (ok) updated++;
          else notFound++;
        }

        const storeLabel = storeName === "company" ? "company" : path.basename(HMEM_PATH, ".hmem");
        const flags = [
          irrelevant !== undefined ? `irrelevant=${irrelevant}` : "",
          favorite !== undefined ? `favorite=${favorite}` : "",
          active !== undefined ? `active=${active}` : "",
          pinned !== undefined ? `pinned=${pinned}` : "",
        ].filter(Boolean).join(", ");
        log(`update_many [${storeLabel}]: ${updated}/${ids.length} updated (${flags})`);

        if (storeName === "personal") syncPush(HMEM_PATH);
        const result = `Updated ${updated} of ${ids.length} entries (${flags})`;
        return {
          content: [{ type: "text" as const, text: notFound > 0 ? `${result}\n${notFound} not found` : result }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }],
        isError: true,
      };
    }
  }
);

// ---- Tool: reset_memory_cache ----
server.tool(
  "reset_memory_cache",
  "Clear the session cache of the hmem server so all entries are treated as unseen again. " +
    "The next bulk read will behave like the first read of a fresh session " +
    "(full Fibonacci slots, no suppressed entries).\n\n" +
    "Use when you need a clean slate — e.g., after a major topic change " +
    "or when you suspect important entries were suppressed.",
  {},
  async () => {
    const CACHE_RESET_SIGNAL = "/tmp/hmem-cache-reset-signal";
    try {
      fs.writeFileSync(CACHE_RESET_SIGNAL, "", "utf8");
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR writing cache reset signal: ${safeError(e)}` }],
        isError: true,
      };
    }
    return {
      content: [{
        type: "text" as const,
        text: `Cache reset signal written. The hmem server will clear its session cache on the next tool call.\n` +
          `Next read_memory() will return the full first-read selection.`,
      }],
    };
  }
);

// ---- Tool: export_memory ----
server.tool(
  "export_memory",
  "Export your memory, excluding secret entries and secret sub-nodes. " +
    "Use for sharing, backup, or publishing a sanitized version of your memory.",
  {
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Source store: 'personal' (your own memory) or 'company' (shared company store)"
    ),
    format: z.enum(["text", "hmem"]).default("text").describe(
      "Export format: 'text' = Markdown (returned inline), " +
      "'hmem' = SQLite .hmem file (written to disk)"
    ),
    output_path: z.string().optional().describe(
      "Output path for 'hmem' format. Default: export.hmem next to the source file. " +
      "Ignored for 'text' format."
    ),
  },
  async ({ store: storeName, format, output_path }) => {
    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : new HmemStore(HMEM_PATH, hmemConfig);
      try {
        if (format === "hmem") {
          const defaultPath = path.join(
            path.dirname(hmemStore.getDbPath()),
            "export.hmem"
          );
          const outPath = validateFilePath(output_path || defaultPath, path.dirname(hmemStore.getDbPath()));
          const result = hmemStore.exportPublicToHmem(outPath);
          return { content: [{ type: "text" as const, text: `Exported to ${outPath}\n${result.entries} entries, ${result.nodes} nodes, ${result.tags} tags` }] };
        } else {
          const output = hmemStore.exportMarkdown();
          return { content: [{ type: "text" as const, text: output }] };
        }
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }],
        isError: true,
      };
    }
  }
);

// ---- Tool: import_memory ----
server.tool(
  "import_memory",
  "Import entries from a .hmem file into your memory. " +
    "Deduplicates by L1 content (merges sub-nodes), remaps IDs on conflict.",
  {
    source_path: z.string().describe("Path to .hmem file to import"),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' (your own memory) or 'company' (shared company store)"
    ),
    dry_run: z.coerce.boolean().default(false).describe(
      "Preview only — report what would happen without modifying the database"
    ),
  },
  async ({ source_path, store: storeName, dry_run }) => {
    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : new HmemStore(HMEM_PATH, hmemConfig);
      try {
        const safePath = validateFilePath(source_path, path.dirname(hmemStore.getDbPath()));
        if (storeName === "personal" && !dry_run) syncPullThenPush(HMEM_PATH);
        const result = hmemStore.importFromHmem(safePath, dry_run);
        const mode = dry_run ? "preview" : "imported";
        log(`import_memory: ${mode} from ${safePath} (${result.inserted} new, ${result.merged} merged)`);

        const lines: string[] = [];
        lines.push(dry_run
          ? `Import preview from ${source_path}:`
          : `Imported from ${source_path}:`);
        lines.push(`  ${result.inserted} entries ${dry_run ? "to insert" : "inserted"}`);
        lines.push(`  ${result.merged} entries ${dry_run ? "to merge" : "merged"} (L1 match)`);
        lines.push(`  ${result.nodesInserted} nodes ${dry_run ? "to insert" : "inserted"}`);
        lines.push(`  ${result.nodesSkipped} nodes skipped (duplicate L2)`);
        lines.push(`  ${result.tagsImported} tags ${dry_run ? "to import" : "imported"}`);
        if (result.remapped) {
          lines.push(`  ID remapping ${dry_run ? "required" : "applied"} (${result.conflicts} conflicts)`);
        }
        if (storeName === "personal" && !dry_run && (result.inserted > 0 || result.merged > 0)) {
          const retry = syncPushWithRetry(HMEM_PATH);
          if (!retry.resolved) lines.push(`  ⚠ unresolved push conflicts after ${retry.attempts} attempts`);
          else if (retry.attempts > 1) lines.push(`  (resolved push conflict after ${retry.attempts} attempts)`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }],
        isError: true,
      };
    }
  }
);

// ---- Tool: memory_stats ----
server.tool(
  "memory_stats",
  "Shows budget status of your memory: total entries by prefix, nodes, favorites, pinned, most-accessed, oldest entry, stale count (not accessed in 30 days), unique hashtags, and avg nodes per entry.",
  {
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' (your own memory) or 'company' (shared company store)"
    ),
  },
  async ({ store: storeName }) => {
    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : new HmemStore(HMEM_PATH, hmemConfig);
      try {
        const s = hmemStore.getStats();
        const hmemPath = storeName === "company"
          ? path.join(PROJECT_DIR, "company.hmem")
          : HMEM_PATH;
        const lines: string[] = [];
        lines.push(`Memory stats (${storeName}):`);
        lines.push(`  DB: ${hmemPath}`);
        lines.push(`  Total entries: ${s.totalEntries}`);
        const prefixLine = Object.entries(s.byPrefix).map(([p, c]) => `${p}:${c}`).join(", ");
        if (prefixLine) lines.push(`  By prefix: ${prefixLine}`);
        lines.push(`  Total nodes: ${s.totalNodes}  (avg ${s.avgDepth} nodes/entry)`);
        lines.push(`  Favorites [♥]: ${s.favorites}  Pinned [P]: ${s.pinned}`);
        lines.push(`  Unique hashtags: ${s.uniqueTags}`);
        lines.push(`  Stale (>30d not accessed): ${s.staleCount}`);
        if (s.oldestEntry) {
          lines.push(`  Oldest entry: ${s.oldestEntry.id} (${s.oldestEntry.created_at}) — ${s.oldestEntry.title}`);
        }
        if (s.mostAccessed.length > 0) {
          lines.push(`  Most accessed:`);
          for (const e of s.mostAccessed) {
            lines.push(`    ${e.id} (${e.access_count}×) — ${e.title}`);
          }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Tool: memory_health ----
server.tool(
  "memory_health",
  "Audit report for your memory: broken links (links pointing to deleted entries), " +
    "orphaned entries (no sub-nodes), stale favorites/pinned (not accessed in 60 days), " +
    "broken obsolete chains ([✓ID] pointing to non-existent entries), " +
    "and tag orphans (tags with no matching entry). " +
    "Run before/after a curation session.",
  {
    store: z.enum(["personal", "company"]).default("personal"),
    hmem_path: z.string().optional().describe(
      "Curator mode: absolute path to an external .hmem file. Overrides `store`."
    ),
  },
  async ({ store: storeName, hmem_path }) => {
    try {
      const { store: hmemStore, label: storeLabelResolved } = resolveStore(storeName, hmem_path);
      try {
        const h = hmemStore.healthCheck();
        const lines: string[] = [`Memory health report (${storeLabelResolved}):`];
        const ok = (label: string) => lines.push(`  ✓ ${label}`);
        const warn = (label: string) => lines.push(`  ⚠ ${label}`);

        if (h.brokenLinks.length === 0) {
          ok("No broken links");
        } else {
          warn(`${h.brokenLinks.length} entries with broken links:`);
          for (const e of h.brokenLinks) {
            lines.push(`    ${e.id} — ${e.title} → broken: ${e.brokenIds.join(", ")}`);
          }
        }

        if (h.orphanedEntries.length === 0) {
          ok("No orphaned entries (all have sub-nodes)");
        } else {
          warn(`${h.orphanedEntries.length} entries with no sub-nodes:`);
          for (const e of h.orphanedEntries) {
            lines.push(`    ${e.id} (${e.created_at}) — ${e.title}`);
          }
        }

        if (h.staleFavorites.length === 0) {
          ok("No stale favorites/pinned");
        } else {
          warn(`${h.staleFavorites.length} stale favorites/pinned (>60d not accessed):`);
          for (const e of h.staleFavorites) {
            lines.push(`    ${e.id} — ${e.title} [last: ${e.lastAccessed ?? "never"}]`);
          }
        }

        if (h.brokenObsoleteChains.length === 0) {
          ok("No broken obsolete chains");
        } else {
          warn(`${h.brokenObsoleteChains.length} broken [✓ID] references:`);
          for (const e of h.brokenObsoleteChains) {
            lines.push(`    ${e.id} — ${e.title} → [✓${e.badRef}] not found`);
          }
        }

        if (h.tagOrphans === 0) {
          ok("No tag orphans");
        } else {
          warn(`${h.tagOrphans} tag rows pointing to deleted entries`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Tool: tag_bulk ----
server.tool(
  "tag_bulk",
  "Apply tag changes (add and/or remove) to all entries matching a filter. " +
    "Filter by prefix, full-text search, or existing tag. " +
    "Returns the number of entries modified. " +
    "Also use tag_rename to rename a tag across all entries.",
  {
    filter: z.object({
      prefix: z.string().optional().describe("Only entries with this prefix, e.g. 'L'"),
      search: z.string().optional().describe("FTS5 search term — only matching entries"),
      tag: z.string().optional().describe("Only entries that already have this tag"),
    }).describe("At least one filter field required"),
    add_tags: z.array(z.string()).optional().describe("Tags to add, e.g. ['#hmem', '#bugfix']"),
    remove_tags: z.array(z.string()).optional().describe("Tags to remove"),
    store: z.enum(["personal", "company"]).default("personal"),
  },
  async ({ filter, add_tags, remove_tags, store: storeName }) => {
    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : new HmemStore(HMEM_PATH, hmemConfig);
      try {
        const count = hmemStore.tagBulk(filter, add_tags, remove_tags);
        const added = add_tags?.length ? `+[${add_tags.join(", ")}]` : "";
        const removed = remove_tags?.length ? `-[${remove_tags.join(", ")}]` : "";
        return {
          content: [{
            type: "text" as const,
            text: `tag_bulk: modified ${count} entries. ${added} ${removed}`.trim(),
          }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Tool: tag_rename ----
server.tool(
  "tag_rename",
  "Rename a hashtag across all entries and nodes. " +
    "Example: tag_rename(old_tag='#sqlite', new_tag='#db') renames every occurrence.",
  {
    old_tag: z.string().describe("Existing tag to rename, e.g. '#old-tag'"),
    new_tag: z.string().describe("New tag name, e.g. '#new-tag'"),
    store: z.enum(["personal", "company"]).default("personal"),
  },
  async ({ old_tag, new_tag, store: storeName }) => {
    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : new HmemStore(HMEM_PATH, hmemConfig);
      try {
        const count = hmemStore.tagRename(old_tag, new_tag);
        return {
          content: [{
            type: "text" as const,
            text: count > 0
              ? `Renamed ${old_tag} → ${new_tag} on ${count} entries/nodes.`
              : `Tag ${old_tag} not found — nothing renamed.`,
          }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Tool: move_memory ----
server.tool(
  "move_memory",
  "Move a sub-node (and its entire subtree) to a different parent, updating all ID references. " +
    "source_id must be a sub-node (e.g. 'P0029.15'), not a root entry. " +
    "target_parent_id is the new parent: a root entry (e.g. 'L0074') or a sub-node (e.g. 'P0029.20'). " +
    "Use during curation to reorganize entries into the correct hierarchy.",
  {
    source_id: z.string().describe("Sub-node to move, e.g. 'P0029.15' (must not be a root entry ID)"),
    target_parent_id: z.string().describe("New parent: root 'L0074' or sub-node 'P0029.20'"),
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
  },
  async ({ source_id, target_parent_id, store }) => {
    try {
      const hmemStore = store === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : new HmemStore(HMEM_PATH, hmemConfig);
      try {
        const result = hmemStore.moveNode(source_id, target_parent_id);
        const idLines = Object.entries(result.idMap)
          .map(([old, nw]) => `  ${old} → ${nw}`)
          .join("\n");
        return {
          content: [{
            type: "text" as const,
            text: `Moved ${result.moved} node(s) to ${target_parent_id}.\nNew ID: ${result.newId}\n\nID mapping:\n${idLines}`,
          }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Tool: rename_id ----
server.tool(
  "rename_id",
  "Atomically rename an entry ID and update ALL references across the database. " +
    "Renames: root entry, all child nodes, tags, FTS index, links in other entries, obsolete markers. " +
    "Use to resolve ID conflicts after sync-push detects a collision. " +
    "Example: rename_id({ old_id: 'P0048', new_id: 'P0052' })",
  {
    old_id: z.string().describe("Current entry ID to rename, e.g. 'P0048'"),
    new_id: z.string().describe("New entry ID, e.g. 'P0052' — must have same prefix and not exist yet"),
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
  },
  async ({ old_id, new_id, store }) => {
    try {
      const hmemStore = store === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : new HmemStore(HMEM_PATH, hmemConfig);
      try {
        const result = hmemStore.renameId(old_id, new_id);
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `ERROR: ${result.error}` }], isError: true };
        }
        log(`rename_id: ${old_id} → ${new_id} (${result.affected} rows affected)`);
        return {
          content: [{
            type: "text" as const,
            text: `Renamed ${old_id} → ${new_id} (${result.affected} rows affected).\nAll child nodes, tags, links, and FTS index updated.`,
          }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Tool: move_nodes ----
server.tool(
  "move_nodes",
  "Move session (L2), batch (L3), or exchange (L4) nodes between O-entries. Handles ID rewriting, tag migration, and cleanup of empty parents.",
  {
    node_ids: z.array(z.string()).describe("IDs of nodes to move (L2, L3, or L4)"),
    target_o_id: z.string().describe("Target O-entry ID (e.g. O0048)"),
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
  },
  async ({ node_ids, target_o_id, store }) => {
    try {
      const hmemStore = store === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : new HmemStore(HMEM_PATH, hmemConfig);
      try {
        if (store === "personal") syncPullThenPush(HMEM_PATH);
        const result = hmemStore.moveNodes(node_ids, target_o_id);
        let text = `Moved ${result.moved} node(s) to ${target_o_id}.`;
        if (result.errors.length > 0) {
          text += `\nErrors:\n${result.errors.join("\n")}`;
        }
        if (store === "personal") {
          const retry = syncPushWithRetry(HMEM_PATH);
          if (!retry.resolved) text += `\n⚠ unresolved push conflicts after ${retry.attempts} attempts`;
          else if (retry.attempts > 1) text += `\n(resolved push conflict after ${retry.attempts} attempts)`;
        }
        return { content: [{ type: "text" as const, text }] };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Start ----
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`Curate MCP Server running on stdio | DB: ${HMEM_PATH}`);
}

main().catch((error) => {
  console.error("Fatal error in Curate MCP Server:", error);
  process.exit(1);
});

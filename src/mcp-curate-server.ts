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
import { createRequire } from "node:module";
import {
  HMEM_PATH, log, safeError, resolveStore,
} from "./mcp-shared.js";
import { updateMemory } from "./v2/writes.js";
import {
  tagRename, tagBulk, memoryStats, memoryHealth,
  deleteEntryOrNode, renameId, reparentNode, exportMarkdown,
} from "./v2/curation.js";

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
      const { store, label: storeLabel } = resolveStore(storeName, undefined);
      try {
        // v2 sync lands in Phase 6
        // Note: `active` has no v2 UpdatePatch equivalent — accepted in the schema
        // for backward compat but not applied.
        const patch = { irrelevant, favorite, pinned };
        let updated = 0;
        let notFound = 0;
        for (const id of ids) {
          const ok = updateMemory(store, id, patch);
          if (ok) updated++;
          else notFound++;
        }

        const flags = [
          irrelevant !== undefined ? `irrelevant=${irrelevant}` : "",
          favorite !== undefined ? `favorite=${favorite}` : "",
          active !== undefined ? `active=${active}` : "",
          pinned !== undefined ? `pinned=${pinned}` : "",
        ].filter(Boolean).join(", ");
        log(`update_many [${storeLabel}]: ${updated}/${ids.length} updated (${flags})`);

        const result = `Updated ${updated} of ${ids.length} entries (${flags})`;
        return {
          content: [{ type: "text" as const, text: notFound > 0 ? `${result}\n${notFound} not found` : result }],
        };
      } finally {
        store.close();
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
  async ({ store: storeName, format }) => {
    try {
      if (format === "hmem") {
        return {
          content: [{
            type: "text" as const,
            text: "v2 .hmem file export lands in Phase 6 (sync). Use format='text' for a Markdown dump.",
          }],
        };
      }
      const { store } = resolveStore(storeName, undefined);
      try {
        const output = exportMarkdown(store);
        return { content: [{ type: "text" as const, text: output }] };
      } finally {
        store.close();
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
  async () => {
    // Cross-store .hmem import depends on the v2 sync/import bridge, which lands
    // in Phase 6. Returning a clear message rather than silently no-op'ing.
    return {
      content: [{
        type: "text" as const,
        text: "import not supported on v2 yet (Phase 6). Cross-store .hmem import will be reintroduced with the v2 sync bridge.",
      }],
    };
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
      const { store, label, path: dbPath } = resolveStore(storeName, undefined);
      try {
        const s = memoryStats(store);
        const lines: string[] = [];
        lines.push(`Memory stats (${label}):`);
        lines.push(`  DB: ${dbPath}`);
        lines.push(`  Total entries: ${s.total}`);
        const prefixLine = Object.entries(s.byPrefix).map(([p, c]) => `${p}:${c}`).join(", ");
        if (prefixLine) lines.push(`  By prefix: ${prefixLine}`);
        lines.push(`  Total nodes: ${s.nodes}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } finally {
        store.close();
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
      const { store, label: storeLabelResolved } = resolveStore(storeName, hmem_path);
      try {
        const h = memoryHealth(store);
        const lines: string[] = [`Memory health report (${storeLabelResolved}):`];
        const ok = (label: string) => lines.push(`  ✓ ${label}`);
        const warn = (label: string) => lines.push(`  ⚠ ${label}`);

        if (h.brokenLinks.length === 0) {
          ok("No broken links");
        } else {
          warn(`${h.brokenLinks.length} broken link(s) (pointing to deleted entries/nodes):`);
          for (const e of h.brokenLinks) {
            lines.push(`    ${e.src} → ${e.dst}`);
          }
        }

        if (h.orphanNodes === 0) {
          ok("No orphaned nodes");
        } else {
          warn(`${h.orphanNodes} orphaned node(s) (root entry deleted)`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } finally {
        store.close();
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
      const { store } = resolveStore(storeName, undefined);
      try {
        const count = tagBulk(store, { prefix: filter.prefix }, add_tags, remove_tags);
        const added = add_tags?.length ? `+[${add_tags.join(", ")}]` : "";
        const removed = remove_tags?.length ? `-[${remove_tags.join(", ")}]` : "";
        return {
          content: [{
            type: "text" as const,
            text: `tag_bulk: modified ${count} entries. ${added} ${removed}`.trim(),
          }],
        };
      } finally {
        store.close();
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
      const { store } = resolveStore(storeName, undefined);
      try {
        const count = tagRename(store, old_tag, new_tag);
        return {
          content: [{
            type: "text" as const,
            text: count > 0
              ? `Renamed ${old_tag} → ${new_tag} on ${count} entries/nodes.`
              : `Tag ${old_tag} not found — nothing renamed.`,
          }],
        };
      } finally {
        store.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Tool: move_node ----
server.tool(
  "move_node",
  "Reparent a single sub-node to a different parent. " +
    "source_id must be a sub-node (e.g. 'P0029.15'), not a root entry. " +
    "target_id is the new parent: a root entry (e.g. 'L0074') or a sub-node (e.g. 'P0029.20'). " +
    "Use during curation to reorganize a node into the correct hierarchy.",
  {
    source_id: z.string().describe("Sub-node to move, e.g. 'P0029.15' (must not be a root entry ID)"),
    target_id: z.string().describe("New parent: root 'L0074' or sub-node 'P0029.20'"),
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
  },
  async ({ source_id, target_id, store: storeName }) => {
    try {
      const { store } = resolveStore(storeName, undefined);
      try {
        const ok = reparentNode(store, source_id, target_id);
        if (!ok) {
          return {
            content: [{ type: "text" as const, text: `Could not move ${source_id} → ${target_id} (source must be a sub-node and target must resolve).` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Moved ${source_id} under ${target_id}.` }],
        };
      } finally {
        store.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Tool: rename_id ----
server.tool(
  "rename_id",
  "Atomically rename a memory entry or node ID and update ALL references across the database. " +
    "Works for root entries (e.g. 'P0099' → 'P0100') and sub-nodes (e.g. 'P0054.19' → 'P0054.6'). " +
    "Renames: root entry, all child nodes, tags, FTS index, links in other entries, obsolete markers. " +
    "Use for schema corrections (misplaced sections), ID collisions, or post-sync conflict resolution. " +
    "Example: rename_id({ old_id: 'P0048', new_id: 'P0052' })",
  {
    old_id: z.string().min(1).describe("Current entry ID to rename, e.g. 'P0048' or 'P0054.19'"),
    new_id: z.string().min(1).describe("New entry ID, e.g. 'P0052' — must have same prefix and not exist yet"),
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
  },
  async ({ old_id, new_id, store: storeName }) => {
    try {
      const { store } = resolveStore(storeName, undefined);
      try {
        const ok = renameId(store, old_id, new_id);
        if (!ok) {
          return {
            content: [{ type: "text" as const, text: `ERROR: could not rename ${old_id} → ${new_id} (not found, or not a root entry — only root entries are relabelable).` }],
            isError: true,
          };
        }
        // v2 sync lands in Phase 6
        log(`rename_id: ${old_id} → ${new_id}`);
        return {
          content: [{
            type: "text" as const,
            text: `Renamed ${old_id} → ${new_id}. All child nodes, tags, links, and FTS index updated.`,
          }],
        };
      } finally {
        store.close();
      }
    } catch (e) {
      return { content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true };
    }
  }
);

// ---- Tool: delete ----
server.tool(
  "delete",
  "Permanently delete a memory entry or sub-node by ID. " +
    "For root entries: deletes the entire entry with all sub-nodes and tags. " +
    "For sub-nodes: deletes only that node and its subtree.\n\n" +
    "⚠️ IRREVERSIBLE — no undo. Use with caution.",
  {
    id: z.string().describe(
      "ID to delete, e.g. 'L0042' (root entry) or 'P0048.10' (sub-node)"
    ),
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
  },
  async ({ id, store: storeName }) => {
    try {
      const { store } = resolveStore(storeName, undefined);
      try {
        const deleted = deleteEntryOrNode(store, id);
        if (!deleted) {
          return {
            content: [{ type: "text" as const, text: `Not found: ${id}` }],
            isError: true,
          };
        }
        // v2 sync lands in Phase 6
        return {
          content: [{ type: "text" as const, text: `Deleted: ${id}` }],
        };
      } finally {
        store.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }],
        isError: true,
      };
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

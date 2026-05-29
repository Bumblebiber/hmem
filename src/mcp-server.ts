#!/usr/bin/env node
/**
 * hmem — Humanlike Memory MCP Server (daily-use tools).
 *
 * Provides persistent, hierarchical memory for AI agents via MCP.
 * SQLite-backed, v2 facade (entries/nodes/events/sessions).
 *
 * Curation/maintenance tools (memory_health, tag_bulk, rename_id, etc.) live in
 * the separate hmem-curate-server. Activate it with /mcp when needed.
 *
 * Environment variables:
 *   HMEM_PATH                — Full path to .hmem file (auto-resolved if not set)
 *   HMEM_PROJECT_DIR         — Root directory (fallback: dirname of HMEM_PATH)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { searchMemory as searchMemoryFs } from "./memory-search.js";
import { formatPrefixList } from "./hmem-config.js";
import { setActiveDevice } from "./session-state.js";
import {
  HMEM_PATH, PROJECT_DIR, hmemConfig, log,
  jsonArrayString, safeError, activeProjectLine,
  resolveStore,
} from "./mcp-shared.js";

// ---- v2 facade ----
import { createV2Store, type V2Store } from "./v2/store-facade.js";
import { getSchemaMajor, V1FileError } from "./store/db.js";
import { renderEntryTree, readBulk, type WhyRow } from "./v2/read-render.js";
import { searchMemory as searchMemoryDb } from "./v2/search.js";
import { findRelated } from "./v2/related.js";
import { listProjects, loadProject, createProject, readProject } from "./v2/projects.js";
import { writeMemory, appendMemory, updateMemory } from "./v2/writes.js";
import { activate, getSessionLog } from "./v2/sessions-tools.js";

// ---- Version upgrade detection ----
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const PKG_VERSION: string = _require("../package.json").version;

/** Check if hmem was upgraded since last session. Auto-syncs skills and returns upgrade notice. */
function checkVersionUpgrade(): string {
  try {
    const configPath = path.join(PROJECT_DIR, "hmem.config.json");
    if (!fs.existsSync(configPath)) return "";
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const lastSeen = raw?.memory?.lastSeenVersion || raw?.lastSeenVersion;
    if (!lastSeen) {
      saveLastSeenVersion(configPath, raw);
      autoSyncSkills();
      return "";
    }
    if (lastSeen !== PKG_VERSION) {
      saveLastSeenVersion(configPath, raw);
      autoSyncSkills();
      return `\n\n⚠ its-over-9k updated: v${lastSeen} → v${PKG_VERSION}. Skills have been auto-synced. Run /o9k-update for full post-update steps (entry migration, schema enforcement, config check).`;
    }
  } catch {}
  return "";
}

/** Auto-sync skill files on version upgrade. Runs hmem update-skills in background. */
function autoSyncSkills(): void {
  try {
    const hmemBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
    const child = spawn(process.execPath, [hmemBin, "update-skills"], {
      detached: true, stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    log("Auto-syncing skills after version upgrade");
  } catch {}
}

function saveLastSeenVersion(configPath: string, raw: any): void {
  try {
    if (!raw.memory) raw.memory = {};
    raw.memory.lastSeenVersion = PKG_VERSION;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
  } catch {}
}

let versionUpgradeNotice = checkVersionUpgrade();

// ---- Response cap ----
const RESPONSE_CEILING = hmemConfig.maxToolResponseChars && hmemConfig.maxToolResponseChars > 0
  ? hmemConfig.maxToolResponseChars
  : 16000;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Cap a tool response text to the configured ceiling, appending a truncation marker. */
function capResult(result: ToolResult): ToolResult {
  if (result.isError) {
    // One-time version upgrade notice still piggybacks on errors? No — only on success.
    return result;
  }
  // Append one-time version upgrade notice
  if (versionUpgradeNotice && result.content.length > 0) {
    result.content[result.content.length - 1].text += versionUpgradeNotice;
    versionUpgradeNotice = "";
  }
  const text = result.content.map(c => c.text).join("");
  if (text.length > RESPONSE_CEILING) {
    const truncated = text.slice(0, RESPONSE_CEILING) + "\n\n‹…truncated›";
    return { content: [{ type: "text" as const, text: truncated }], isError: result.isError };
  }
  return result;
}

/** Render a --why trace block as readable text. */
function formatWhy(why: WhyRow[] | undefined): string {
  if (!why || why.length === 0) return "";
  const lines = why.map(w => `  ${w.label}  [${w.shown}] ${w.reason}`);
  return `\n\n--- why ---\n${lines.join("\n")}`;
}

/** Open the personal/company/external store for a handler. Caller must close(). */
function openStore(storeName: "personal" | "company", hmemPath?: string): { store: V2Store; label: string; path: string; isExternal: boolean } {
  return resolveStore(storeName, hmemPath);
}

// ---- Server ----
const server = new McpServer({
  name: "hmem",
  version: PKG_VERSION,
});

// ---- Tool: search_memory (filesystem search across memories/personalities/projects/skills) ----
server.tool(
  "search_memory",
  "Searches the collective memory: agent memories (lessons learned, evaluations), " +
    "and optionally personalities, project documentation, and skills. " +
    "Use this tool to learn from past experiences before starting a task.",
  {
    query: z.string().min(2).describe(
      "Search terms (e.g. 'Node.js performance error', 'frontend testing strategy')"
    ),
    scope: z
      .enum(["memories", "personalities", "projects", "skills", "all"])
      .optional()
      .describe(
        "Limit search scope: 'memories' = agent .hmem databases, 'personalities' = agent roles, " +
          "'projects' = project docs, 'skills' = skill references, 'all' = everything (default)"
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Max results (default: 10)"),
  },
  async ({ query, scope, max_results }) => {
    log(`search_memory: query="${query}", scope=${scope || "all"}`);

    const results = searchMemoryFs(PROJECT_DIR, query, {
      scope: scope || "all",
      maxResults: max_results || 10,
    });

    if (results.length === 0) {
      return capResult({
        content: [
          {
            type: "text" as const,
            text: `No results for "${query}" (Scope: ${scope || "all"}).\n\nTip: Try more general terms or a different scope.`,
          },
        ],
      });
    }

    const output = results
      .map((r, i) => {
        const header = r.agent
          ? `### ${i + 1}. ${r.agent} — ${r.file} (Score: ${r.score})`
          : `### ${i + 1}. ${r.file} (Score: ${r.score})`;
        const excerpts = r.excerpts.map((e) => `> ${e.replace(/\n/g, "\n> ")}`).join("\n\n");
        return `${header}\n${excerpts}`;
      })
      .join("\n\n---\n\n");

    return capResult({
      content: [
        {
          type: "text" as const,
          text: `## Memory Search: "${query}"\n**${results.length} hits** (Scope: ${scope || "all"})\n\n${output}`,
        },
      ],
    });
  }
);

// ---- Humanlike Memory (.hmem) ----

const prefixList = formatPrefixList(hmemConfig.prefixes);
const prefixKeys = Object.keys(hmemConfig.prefixes);

server.tool(
  "write_memory",
  "Write a new memory entry to your hierarchical long-term memory (.hmem). " +
    "Use tab indentation to create depth levels:\n" +
    "  Level 1: No indentation — the rough summary (always visible at startup)\n" +
    "  Level 2: 1 tab — more detail (loaded on demand)\n" +
    "  Level 3: 2 tabs — even more detail\n" +
    "  Level 4: 3 tabs — fine-grained detail\n" +
    "  Level 5: 4 tabs — raw context/data\n" +
    "Body text (shown on drill-down, hidden in listings): use the 'body' parameter — or a blank line in 'content':\n" +
    "  write_memory(prefix='L', title='My Lesson', body='Detailed body text.', content='\\tSection\\n\\t\\tDetails')\n" +
    "  write_memory(prefix='L', content='My Lesson\\n\\nBody text.\\n\\tSection\\n\\t\\tDetails')  ← legacy format\n" +
    "The system auto-assigns an ID and timestamp. " +
    `Use prefix to categorize: ${prefixList}.\n\n` +
    "Store types:\n" +
    "  personal (default): Your private memory\n",
  {
    prefix: z.string().toUpperCase().describe(
      `Memory category: ${prefixList}`
    ),
    title: z.string().optional().describe(
      "Optional: explicit root title. If provided, overrides the first line of 'content'. Use together with 'body'."
    ),
    body: z.string().optional().describe(
      "Optional: explicit body text for the root entry (shown on drill-down, hidden in listings). " +
      "Prefer this over blank-line tricks in 'content'. " +
      "Example: write_memory(prefix='P', title='My Project', body='Full description.', content='\\tSection\\n\\t\\tDetails')"
    ),
    content: z.string().optional().describe(
      "Memory content with tab-indented sub-nodes. " +
      "If 'title' is provided: only sub-nodes here (no L1 title needed). " +
      "Legacy mode (no 'title'): full entry including title + blank-line body.\n" +
      "Example (title+body mode): content='\\tSection\\n\\t\\tDetails'\n" +
      "Example (legacy): content='My Entry\\n\\nBody text.\\n\\tSection'"
    ),
    links: jsonArrayString(z.array(z.string()).optional()).describe(
      "Optional: IDs of related memories, e.g. ['P0001', 'L0005']"
    ),
    favorite: z.coerce.boolean().optional().describe(
      "Mark this entry as a favorite — shown with [♥] in bulk reads and always inlined with L2 detail. " +
      "Use for reference info you need to see every session, regardless of category."
    ),
    tags: jsonArrayString(z.array(z.string()).min(1)).describe(
      "Required hashtags for cross-cutting search (min 1, recommend 3+). " +
      "E.g. ['#hmem', '#curation']. Max 10, lowercase, must start with #. Shown after title in reads."
    ),
    pinned: z.coerce.boolean().optional().describe(
      "Mark this entry as pinned [P] (super-favorite). Pinned entries show full L2 content in bulk reads. " +
      "Use for reference entries you need to see in full every session."
    ),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' or 'company'"
    ),
    force: z.coerce.boolean().optional().describe(
      "Force creation of a new root entry even if existing entries share tags. " +
      "Only use when you intentionally want a separate entry, not a child of an existing one."
    ),
  },
  async ({ prefix, title: titleParam, body: bodyParam, content: rawContent, links, favorite, tags, pinned, store: storeName }) => {
    const isFirstTime = !fs.existsSync(HMEM_PATH);

    // Build effective content from title/body/content params (v2 parseTabbed:
    // first line = level_1, blank lines skipped, no-tab lines become L2 children).
    let content: string;
    if (titleParam !== undefined) {
      const subNodes = rawContent?.trim() ?? "";
      content = titleParam
        + (bodyParam ? "\n\n" + bodyParam : "")
        + (subNodes ? "\n" + subNodes : "");
    } else if (rawContent !== undefined && rawContent.trim().length >= 3) {
      if (bodyParam) {
        const nl = rawContent.indexOf("\n");
        const firstLine = nl >= 0 ? rawContent.substring(0, nl) : rawContent;
        const rest = nl >= 0 ? rawContent.substring(nl + 1) : "";
        content = firstLine + "\n\n" + bodyParam + (rest.trim() ? "\n" + rest : "");
      } else {
        content = rawContent;
      }
    } else {
      return capResult({
        content: [{ type: "text" as const, text: "ERROR: Either 'title' or 'content' (min 3 chars) must be provided." }],
        isError: true,
      });
    }

    try {
      const { store, label: storeLabel } = openStore(storeName);
      try {
        const result = writeMemory(store, {
          prefix, content, links, favorite, pinned, tags,
        });
        log(`write_memory [${storeLabel}]: ${result.label} (prefix=${prefix})`);
        // v2 sync lands in Phase 6

        const firstTimeNote = isFirstTime ? `\nMemory store created: ${HMEM_PATH}` : "";

        let relatedHint = "";
        if (result.related.length > 0) {
          relatedHint = "\n\nRelated entries:\n" +
            result.related.map(r => `  ${r.label}  ${r.level_1}`).join("\n");
        }

        const activeLine = storeName === "personal" ? `\n${activeProjectLine(store)}` : "";
        return capResult({
          content: [{
            type: "text" as const,
            text: `Memory saved: ${result.label}\n` +
              `Store: ${storeLabel} | Category: ${prefix}` +
              firstTimeNote + relatedHint + (activeLine.trim() ? activeLine : ""),
          }],
        });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({
        content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }],
        isError: true,
      });
    }
  }
);

server.tool(
  "update_memory",
  "Update the text of an existing memory entry or sub-node (your own personal memory). " +
    "Only modifies the text at the specified ID — children are preserved unchanged.\n\n" +
    "Use cases:\n" +
    "- Update title: update_memory(id='L0003', content='corrected summary')\n" +
    "- Fix a sub-node: update_memory(id='L0003.2', content='node title')\n" +
    "- Mark as obsolete: FIRST write the correction, THEN update with [✓ID] reference:\n" +
    "  1. write_memory(prefix='E', content='Correct fix is...') → E0076\n" +
    "  2. update_memory(id='E0042', content='Wrong — see [✓E0076]', obsolete=true)\n" +
    "- Mark as favorite: update_memory(id='D0010', favorite=true)\n" +
    "- Mark as irrelevant: update_memory(id='L0042', irrelevant=true)\n" +
    "  No correction entry needed (unlike obsolete). Hidden from bulk reads.\n\n" +
    "To add new child nodes, use append_memory.",
  {
    id: z.string().describe("ID of the entry or node to update, e.g. 'L0003' or 'L0003.2'"),
    content: z.string().optional().describe(
      "New title/content (plain text). For root entries this replaces level_1; for sub-nodes the node content."
    ),
    body: z.string().optional().describe(
      "New body text (shown on drill-down). If 'content' is also provided: content=new title, body=new body. " +
      "If only 'body': existing title is preserved, only body is updated."
    ),
    obsolete: z.coerce.boolean().optional().describe(
      "Mark this root entry as no longer valid (root entries only). " +
      "Requires [✓ID] correction reference in content (e.g. 'Wrong — see [✓E0076]')."
    ),
    favorite: z.coerce.boolean().optional().describe(
      "Set or clear the [♥] favorite flag (root entries)."
    ),
    irrelevant: z.coerce.boolean().optional().describe(
      "Mark as irrelevant [-]. No correction entry needed (unlike obsolete). Hidden from output."
    ),
    tags: jsonArrayString(z.array(z.string()).optional()).describe(
      "Set tags on this entry/node. Replaces all existing tags. " +
      "Pass empty array [] to remove all tags. E.g. ['#hmem', '#curation']."
    ),
    pinned: z.coerce.boolean().optional().describe(
      "Set or clear the [P] pinned flag (root entries only)."
    ),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' or 'company'"
    ),
    hmem_path: z.string().optional().describe(
      "Curator mode: absolute path to an external .hmem file to update. " +
      "Overrides the `store` parameter. Sync is skipped for external files."
    ),
  },
  async ({ id, content: rawContent, body: bodyParam, obsolete, favorite, irrelevant, tags, pinned, store: storeName, hmem_path }) => {
    try {
      const { store, label: storeLabel } = openStore(storeName, hmem_path);
      try {
        // Build effective content from body param if provided.
        let content = rawContent;
        if (bodyParam !== undefined) {
          if (content !== undefined && content.trim().length > 0) {
            content = content.trim() + "\n\n" + bodyParam;
          } else {
            content = bodyParam;
          }
        }

        // Obsolete guard: require a [✓ID] correction reference in content.
        if (obsolete === true) {
          const ref = (content ?? "");
          if (!/\[✓[A-Z]+\d+\]/.test(ref)) {
            return capResult({
              content: [{ type: "text" as const, text:
                "ERROR: Marking obsolete requires a [✓ID] correction reference in content " +
                "(e.g. content=\"Wrong — see [✓E0076]\"). Write the correction first, then update."
              }],
              isError: true,
            });
          }
        }

        // Auto-mark completed tasks (✓ DONE / DONE:) as irrelevant.
        if (irrelevant === undefined && content) {
          const trimmed = content.split("\n")[0].trim();
          if (trimmed.startsWith("✓ DONE") || trimmed.startsWith("DONE:")) {
            irrelevant = true;
          }
        }

        const ok = updateMemory(store, id, {
          content, obsolete, favorite, irrelevant, pinned, tags,
        });
        log(`update_memory [${storeLabel}]: ${id} → ${ok ? "updated" : "not found"}${obsolete ? " (obsolete)" : ""}${irrelevant ? " (irrelevant)" : ""}`);
        // v2 sync lands in Phase 6

        if (!ok) {
          return capResult({
            content: [{ type: "text" as const, text: `ERROR: Entry "${id}" not found in ${storeLabel}.` }],
            isError: true,
          });
        }

        const parts: string[] = [`Updated: ${id}`];
        if (obsolete === true) parts.push("marked as [!] obsolete");
        if (obsolete === false) parts.push("obsolete flag cleared");
        if (irrelevant === true) parts.push("marked as [-] irrelevant");
        if (irrelevant === false) parts.push("irrelevant flag cleared");
        if (favorite === true) parts.push("marked as [♥] favorite");
        if (favorite === false) parts.push("favorite flag cleared");
        if (pinned === true) parts.push("marked as [P] pinned");
        if (pinned === false) parts.push("pinned flag cleared");
        if (tags !== undefined) parts.push(tags.length > 0 ? `tags: ${tags.join(" ")}` : "tags cleared");

        const activeLine = storeName === "personal" && !hmem_path ? activeProjectLine(store) : "";
        return capResult({
          content: [{ type: "text" as const, text: parts.join(" | ") + (activeLine ? `\n${activeLine}` : "") }],
        });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({
        content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }],
        isError: true,
      });
    }
  }
);

server.tool(
  "append_memory",
  "Append new child nodes to an existing memory entry or node (your own personal memory). " +
    "Existing children are preserved — new nodes are added after them.\n\n" +
    "Use this to extend an existing entry with additional detail without overwriting it.\n\n" +
    "Content uses tab indentation relative to the parent:\n" +
    "  0 tabs = direct child of id\n" +
    "  1 tab  = grandchild, etc.\n" +
    "Two modes:\n" +
    "  Simple (title+body): append_memory(id='L0003', title='New finding', body='Detailed explanation')\n" +
    "  Complex (full sub-tree): append_memory(id='L0003', content='New finding\\n\\tSub-detail\\n\\t\\tDeep')",
  {
    id: z.string().describe(
      "Root entry ID or parent node ID to append children to, e.g. 'L0003' or 'L0003.2'"
    ),
    title: z.string().optional().describe(
      "Simple mode: title for the new node. Use with 'body' for clean title+body creation."
    ),
    body: z.string().optional().describe(
      "Simple mode: body text for the new node (shown on drill-down). Use with 'title'."
    ),
    content: z.string().optional().describe(
      "Complex mode: full tab-indented sub-tree to append. 0 tabs = direct child of id."
    ),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' or 'company'"
    ),
  },
  async ({ id, title: titleParam, body: bodyParam, content: rawContent, store: storeName }) => {
    let content: string;
    if (titleParam !== undefined) {
      content = titleParam + (bodyParam ? "\n\n" + bodyParam : "");
    } else if (rawContent !== undefined && rawContent.trim().length > 0) {
      content = rawContent;
    } else {
      return capResult({
        content: [{ type: "text" as const, text: "ERROR: Either 'title' or 'content' must be provided." }],
        isError: true,
      });
    }
    try {
      const { store, label: storeLabel } = openStore(storeName);
      try {
        const result = appendMemory(store, id, content);
        log(`append_memory [${storeLabel}]: ${id} + ${result.count} nodes`);
        // v2 sync lands in Phase 6

        if (result.count === 0) {
          return capResult({
            content: [{ type: "text" as const, text: `No nodes appended to ${id} — content was empty or the target was not found.` }],
          });
        }

        const activeLine = storeName === "personal" ? activeProjectLine(store) : "";
        return capResult({
          content: [{
            type: "text" as const,
            text: `Appended ${result.count} node${result.count === 1 ? "" : "s"} to ${id}.` +
              (activeLine ? `\n${activeLine}` : ""),
          }],
        });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({
        content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }],
        isError: true,
      });
    }
  }
);

server.tool(
  "read_memory",
  "Read from your hierarchical long-term memory (.hmem). " +
    "At startup, you received all Level 1 entries (rough summaries). " +
    "Use this tool to drill deeper into specific memories.\n\n" +
    "Query modes:\n" +
    "- By ID: read_memory({ id: 'P0001' }) → entry + direct children\n" +
    "- By node ID: read_memory({ id: 'P0001.2' }) → that node + its children\n" +
    "- By prefix: read_memory({ prefix: 'L' }) → bulk listing of Lessons Learned\n" +
    "- By time: read_memory({ after: '2026-02-15', before: '2026-02-17' })\n" +
    "- Search: read_memory({ search: 'SSE' }) → full-text search across all entries\n" +
    "- Context: read_memory({ context_for: 'P0001' }) → entries related to P0001\n\n" +
    "Store types:\n" +
    "  personal (default): Your private memory\n",
  {
    id: z.string().optional().describe("Specific memory ID, e.g. 'P0001' or 'L0023'"),
    depth: z.number().min(1).max(4).optional().describe("How deep to read (1-4). Default: 2 when reading by ID. For L5 detail, drill into specific node IDs."),
    prefix: z.string().optional().describe(`Filter by category: ${prefixKeys.join(", ")}`),
    after: z.string().optional().describe("Only entries after this date (ISO format, e.g. '2026-02-15')"),
    before: z.string().optional().describe("Only entries before this date (ISO format)"),
    search: z.string().optional().describe("Full-text search across all memory levels"),
    limit: z.number().optional().describe("Max results (default: unlimited — all L1 entries are returned)"),
    titles_only: z.coerce.boolean().optional().describe(
      "Compact title listing — shows all bulk-read entries as a single title line each, without expansion. Like a table of contents."
    ),
    context_for: z.string().optional().describe(
      "Load entries related to this entry (directly linked OR sharing tags). " +
      "Example: read_memory({ context_for: 'P0029' })."
    ),
    max_results: z.number().int().min(1).max(50).optional().describe("Max results for search/context (default 20)"),
    why: z.boolean().optional().describe(
      "Append a --why trace explaining why each entry was shown expanded or as a title."
    ),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Source store: 'personal' or 'company'"
    ),
    tag: z.string().optional().describe(
      "Filter bulk reads by hashtag, e.g. '#hmem'. Only entries with this tag are shown."
    ),
    show_all: z.coerce.boolean().optional().describe(
      "Include irrelevant [-] nodes (curation/review). Default: hidden from drill-in reads."
    ),
    hmem_path: z.string().optional().describe(
      "Curator mode: absolute path to an external .hmem file to read from. Overrides `store`."
    ),
  },
  async ({ id, depth, prefix, after, before, search, limit, titles_only, tag, show_all, context_for, max_results, why, store: storeName, hmem_path }) => {
    try {
      const { store, label: storeLabel } = openStore(storeName, hmem_path);
      try {
        let text: string;
        let whyBlock = "";

        if (id) {
          text = renderEntryTree(store, id, depth ?? 2, show_all);
        } else if (search) {
          text = searchMemoryDb(store, search, { max: max_results });
        } else if (context_for) {
          const hits = findRelated(store, context_for, limit ?? max_results ?? 10);
          text = hits.length > 0
            ? `Related to ${context_for}:\n` +
              hits.map(h => {
                const marker = h.via === "link" ? "[link]" : `[tag×${h.overlap}]`;
                return `  ${marker} ${h.label}  ${h.level_1}`;
              }).join("\n")
            : `No related entries found for ${context_for}.`;
        } else {
          const res = readBulk(store, { prefix, after, before, limit, titlesOnly: titles_only, tag, why });
          text = res.text || "No memories found.";
          if (why) whyBlock = formatWhy(res.why);
        }

        log(`read_memory [${storeLabel}]: ${id ? `id=${id}` : search ? `search="${search}"` : context_for ? `context_for=${context_for}` : prefix ? `prefix=${prefix}` : "bulk"}`);

        return capResult({
          content: [{ type: "text" as const, text: text + whyBlock }],
        });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({
        content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }],
        isError: true,
      });
    }
  }
);

server.tool(
  "find_related",
  "Find entries related to the given entry. " +
    "Uses link references first, then tag overlap. " +
    "Use to discover connections or spot potential duplicates.",
  {
    id: z.string().describe("Root entry ID to find related entries for, e.g. 'P0001'"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to return (default: 5)"),
    store: z.enum(["personal", "company"]).default("personal"),
    hmem_path: z.string().optional().describe(
      "Curator mode: absolute path to an external .hmem file. Overrides `store`."
    ),
  },
  async ({ id, limit, store: storeName, hmem_path }) => {
    try {
      const { store } = openStore(storeName, hmem_path);
      try {
        const results = findRelated(store, id, limit);
        if (results.length === 0) {
          return capResult({ content: [{ type: "text" as const, text: `No related entries found for ${id}.` }] });
        }
        const lines = [`Related to ${id}:`];
        for (const r of results) {
          const marker = r.via === "link" ? "[link]" : `[tag×${r.overlap}]`;
          lines.push(`  ${marker} ${r.label}  ${r.level_1}`);
        }
        return capResult({ content: [{ type: "text" as const, text: lines.join("\n") }] });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({ content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true });
    }
  }
);

server.tool(
  "load_project",
  "Load a project's briefing (entry + sections + recent session summaries). " +
    "A pure read — use `activate` to bind the current session to a project.\n\n" +
    "Example: load_project({ id: 'P0048' })",
  {
    id: z.string().describe("Project entry ID, e.g. 'P0048'"),
    why: z.boolean().optional().describe("Append a --why trace explaining what was loaded."),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' or 'company'"
    ),
  },
  async ({ id, why, store: storeName }) => {
    try {
      const { store } = openStore(storeName);
      try {
        if (!id.startsWith("P")) {
          return capResult({
            content: [{ type: "text" as const, text: `ERROR: load_project only works with P-prefix entries. Got: ${id}` }],
            isError: true,
          });
        }
        const res = loadProject(store, id, { why });
        log(`load_project: ${id} loaded`);
        const whyBlock = why ? formatWhy(res.why) : "";
        return capResult({
          content: [{ type: "text" as const, text: res.text + whyBlock }],
        });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({ content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true });
    }
  }
);

server.tool(
  "read_project",
  "Read a project's context without binding the session to it — for cross-project reference.\n\n" +
    "Example: read_project({ id: 'P0048' })",
  {
    id: z.string().describe("Project entry ID, e.g. 'P0048'"),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' or 'company'"
    ),
  },
  async ({ id, store: storeName }) => {
    try {
      const { store } = openStore(storeName);
      try {
        if (!id.startsWith("P")) {
          return capResult({
            content: [{ type: "text" as const, text: `ERROR: read_project only works with P-prefix entries. Got: ${id}` }],
            isError: true,
          });
        }
        const text = readProject(store, id);
        log(`read_project: ${id} loaded (reference mode)`);
        return capResult({ content: [{ type: "text" as const, text }] });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({ content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true });
    }
  }
);

server.tool(
  "create_project",
  "Create a new project with the standard schema. Creates a P-entry with the scaffolded sections.\n\n" +
    "Example: create_project({ name: 'Carlo Auftrag', tech: 'Python/SAP', description: 'SAP Freigabe-Automatisierung' })",
  {
    name: z.string().describe("Project name (short, for L1 title)"),
    tech: z.string().describe("Tech stack, e.g. 'TS/React', 'Python/Flask', 'AHK v2'"),
    description: z.string().describe("One-line project description"),
    status: z.enum(["Active", "Paused", "Planning", "Mature", "Archived"]).default("Active"),
    repo: z.string().optional().describe("Repo path or URL, e.g. '~/projects/foo' or 'GH: User/repo'"),
    goal: z.string().optional().describe("Main project goal (1-2 sentences)"),
    audience: z.string().optional().describe("Target audience / who uses it"),
    deployment: z.string().optional().describe("How it's deployed (npm, exe, server, manual)"),
    tags: jsonArrayString(z.array(z.string()).optional()).describe("Additional tags beyond #project (auto-added)"),
    store: z.enum(["personal", "company"]).default("personal"),
  },
  async ({ name, tech, description, status, repo, goal, audience, deployment, tags, store: storeName }) => {
    try {
      const { store } = openStore(storeName);
      try {
        const allTags = ["#project", ...(tags ?? [])];
        const result = createProject(store, {
          name, tech, description, goal, audience, status, repo, deployment, tags: allTags,
        });
        log(`create_project: ${result.label} created`);
        // v2 sync lands in Phase 6

        return capResult({
          content: [{
            type: "text" as const,
            text: `✓ Project ${result.label} created.\n\n` +
              `Next: load_project(id="${result.label}") for the full briefing, ` +
              `then activate(project="${result.label}") to bind this session.`,
          }],
        });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({ content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true });
    }
  }
);

server.tool(
  "list_projects",
  "List all projects (P-entries) with their IDs and titles. Minimal output for checkpoint agents.",
  {
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
  },
  async ({ store: storeName }) => {
    try {
      const { store } = openStore(storeName);
      try {
        const text = listProjects(store);
        return capResult({ content: [{ type: "text" as const, text }] });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({ content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true });
    }
  }
);

// ---- Tool: activate (bind current session to a project) ----
server.tool(
  "activate",
  "Bind the current session to a project. Future events are logged under this project. " +
    "Use after load_project to make the project the session's active context.\n\n" +
    "Example: activate({ project: 'P0048' })",
  {
    project: z.string().describe("Project entry ID to bind to, e.g. 'P0048'"),
    since: z.number().int().positive().optional().describe(
      "Optional: bind retroactively from this event seq (advanced)."
    ),
  },
  async ({ project, since }) => {
    try {
      const { store } = openStore("personal");
      try {
        const result = activate(store, project, { since });
        log(`activate: session ${result.session_id} → ${result.project}`);
        // v2 sync lands in Phase 6
        return capResult({
          content: [{
            type: "text" as const,
            text: `✓ Session bound to project ${result.project}.\n` +
              `  session_id: ${result.session_id}`,
          }],
        });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({ content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true });
    }
  }
);

// ---- Tool: get_session_log ----
server.tool(
  "get_session_log",
  "Read the event log for a session (user/agent exchanges). " +
    "Returns the most recent events, capped to `limit`.\n\n" +
    "Example: get_session_log({ session_id: 'abc123' })",
  {
    session_id: z.string().describe("Session ID to read the log for"),
    limit: z.number().int().positive().optional().describe("Max events to return (default: 500, most recent)"),
  },
  async ({ session_id, limit }) => {
    try {
      const { store } = openStore("personal");
      try {
        const cap = limit ?? 500;
        const text = getSessionLog(store, session_id, cap);
        log(`get_session_log: ${session_id} (cap ${cap} events)`);
        return capResult({ content: [{ type: "text" as const, text }] });
      } finally {
        store.close();
      }
    } catch (e) {
      return capResult({ content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true });
    }
  }
);

// ---- Tool: set_active_device ----
server.tool(
  "set_active_device",
  "Set the active device for this machine. Call this once after identifying which machine you are on. " +
    "The device ID must be an I-entry (Infrastructure entry) in hmem. " +
    "Writes ~/.hmem/active-device so all future sessions on this machine know their device. " +
    "Also updates the statusline display immediately.\n\n" +
    "Example: set_active_device({ id: 'I0002' })",
  {
    id: z.string().describe("I-entry ID, e.g. 'I0002'"),
  },
  async ({ id }) => {
    try {
      if (!id.startsWith("I")) {
        return capResult({
          content: [{ type: "text" as const, text: `ERROR: set_active_device only works with I-prefix entries. Got: ${id}` }],
          isError: true,
        });
      }
      const { store } = openStore("personal");
      let title = id;
      try {
        const uid = store.entries.labelToUid(id);
        const entry = uid ? store.entries.getEntry(uid) : null;
        if (!entry) {
          return capResult({
            content: [{ type: "text" as const, text: `ERROR: Entry ${id} not found.` }],
            isError: true,
          });
        }
        title = store.entries.renderRefs(entry.level_1).split("|")[0].split("\n")[0].trim();
      } finally {
        store.close();
      }
      // Writes the ~/.hmem/active-device I-entry file. No global active-project DB flag.
      setActiveDevice(id);
      // Clear all statusline caches so the new device shows immediately
      try {
        const tmpDir = os.tmpdir();
        for (const f of fs.readdirSync(tmpDir)) {
          if (f.startsWith(".hmem_statusline_")) {
            try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
      log(`set_active_device: ${id} (${title})`);
      const text = title === id ? `Active device set to: ${id}` : `Active device set to: ${title} (${id})`;
      return capResult({ content: [{ type: "text" as const, text }] });
    } catch (e) {
      return capResult({ content: [{ type: "text" as const, text: `ERROR: ${safeError(e)}` }], isError: true });
    }
  }
);

// ---- Tool: reset_memory_cache ----
const CACHE_RESET_SIGNAL = "/tmp/hmem-cache-reset-signal";
server.tool(
  "reset_memory_cache",
  "Signal that the session cache should be cleared so all entries are treated as unseen again. " +
    "Use after a major topic change or when you suspect entries were suppressed.\n\n" +
    "Writes a cache-reset signal file consumed by the session hooks.",
  {},
  async () => {
    try { fs.writeFileSync(CACHE_RESET_SIGNAL, String(Date.now()), "utf8"); } catch { /* best effort */ }
    return capResult({
      content: [{ type: "text" as const, text: "Cache-reset signal written. The next bulk read will behave like a fresh session." }],
    });
  }
);

// ---- Update check ----
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const updateCheckFile = path.join(path.dirname(PROJECT_DIR), ".hmem", ".update-check.json");

/** Fire-and-forget update check. Runs max once per day. Logs to stderr if outdated. */
function checkForUpdates(): void {
  try {
    let state: Record<string, string> = {};
    try { state = JSON.parse(fs.readFileSync(updateCheckFile, "utf8")); } catch {}
    const lastCheck = state["its-over-9k"] ? new Date(state["its-over-9k"]).getTime() : 0;
    if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;

    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npmCmd, ["show", "its-over-9k", "version"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      windowsHide: true,
    });
    child.unref();
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("close", () => {
      const latest = out.trim();
      if (!latest) return;
      state["its-over-9k"] = new Date().toISOString();
      try {
        fs.mkdirSync(path.dirname(updateCheckFile), { recursive: true });
        fs.writeFileSync(updateCheckFile, JSON.stringify(state, null, 2), "utf8");
      } catch {}
      if (latest !== PKG_VERSION) {
        const [ci, cj, ck] = PKG_VERSION.split(".").map(Number);
        const [li, lj, lk] = latest.split(".").map(Number);
        const isNewer = li > ci || (li === ci && lj > cj) || (li === ci && lj === cj && lk > ck);
        if (isNewer) {
          log(`⚠ its-over-9k update available: ${PKG_VERSION} → ${latest}. Run: npm install -g its-over-9k@latest`);
        }
      }
    });
  } catch {
    // Update check is best-effort — never crash the server
  }
}

// ---- Start ----
// ---- Serve advisory lockfile (Plan B §3, Layer 1) --------------------------
// `hmem migrate` refuses to run while a live serve process holds this store, to
// avoid the silent-data-loss window of swapping a file out from under an open
// writer. We write a lockfile next to HMEM_PATH on startup and remove it on
// clean exit (best-effort: a stale lock with a dead PID is ignored by migrate).
const SERVE_LOCK_PATH = path.join(path.dirname(HMEM_PATH), ".hmem.serve.lock");
let serveLockWritten = false;

function writeServeLock(): void {
  try {
    fs.writeFileSync(
      SERVE_LOCK_PATH,
      JSON.stringify({ pid: process.pid, started: new Date().toISOString(), hmemPath: HMEM_PATH }),
    );
    serveLockWritten = true;
  } catch {
    // Best-effort: if we can't write the lock, migrate's Layer-2 confirm still guards.
  }
}

function removeServeLock(): void {
  if (!serveLockWritten) return;
  try { fs.rmSync(SERVE_LOCK_PATH, { force: true }); } catch { /* ignore */ }
  serveLockWritten = false;
}

function installServeLockCleanup(): void {
  process.on("exit", removeServeLock);
  // process.on('exit') does NOT fire on signals — handle the common ones so a
  // clean shutdown (Claude Code closing the MCP server) doesn't leave a stale lock.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { removeServeLock(); process.exit(0); });
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  writeServeLock();
  installServeLockCleanup();

  // Startup diagnostics — helps debug "0 entries" issues
  const dbExists = fs.existsSync(HMEM_PATH);
  let entryCount = 0;
  if (dbExists) {
    try {
      const store = createV2Store(HMEM_PATH, hmemConfig);
      try {
        const major = getSchemaMajor(store.db);
        const row = store.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE deleted_at IS NULL").get() as { n: number } | undefined;
        entryCount = row?.n ?? 0;
        log(`Schema major: ${major ?? "unknown"}`);
      } finally { store.close(); }
    } catch (e) {
      // A v1 file is the one non-noise failure here: surface it instead of swallowing,
      // so a v1 user sees WHY their tools refuse (rather than a silent "0 entries").
      if (e instanceof V1FileError) {
        log("Schema major: 1 (v1 file — run 'hmem migrate'; v2 tools refuse writes until migrated)");
      }
    }
  }
  if (!dbExists) {
    log(`WARNING: DB not found at ${HMEM_PATH}`);
    log(`  Check HMEM_PATH in your .mcp.json (current: ${HMEM_PATH})`);
    log(`  The DB will be created on first write_memory() call.`);
  }
  log(`MCP Server running on stdio | DB: ${HMEM_PATH}${dbExists ? ` (${entryCount} entries)` : " [NOT FOUND]"}`);

  checkForUpdates();
}

main().catch((error) => {
  console.error("Fatal error in MCP Server:", error);
  process.exit(1);
});

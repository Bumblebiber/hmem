#!/usr/bin/env node
/**
 * hmem — Humanlike Memory MCP Server.
 *
 * Provides persistent, hierarchical memory for AI agents via MCP.
 * SQLite-backed, 5-level lazy loading, role-based access control.
 *
 * Environment variables:
 *   HMEM_PROJECT_DIR         — Root directory where .hmem files are stored (required)
 *   HMEM_AGENT_ID            — Agent identifier (optional; defaults to memory.hmem)
 *   HMEM_AGENT_ROLE          — Role: worker | al | pl | ceo (default: worker)
 *   HMEM_AUDIT_STATE_PATH    — Path to audit_state.json (default: {PROJECT_DIR}/audit_state.json)
 *
 * Legacy fallbacks (Das Althing):
 *   COUNCIL_PROJECT_DIR, COUNCIL_AGENT_ID, COUNCIL_AGENT_ROLE
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { searchMemory } from "./memory-search.js";
import { openAgentMemory, openCompanyMemory, resolveHmemPath, HmemStore } from "./hmem-store.js";
import type { AgentRole, MemoryEntry, MemoryNode } from "./hmem-store.js";
import { loadHmemConfig, formatPrefixList } from "./hmem-config.js";
import type { HmemConfig } from "./hmem-config.js";

// ---- Environment ----
// HMEM_* vars are the canonical names; COUNCIL_* kept for backwards compatibility
const PROJECT_DIR = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR || "";

if (!PROJECT_DIR) {
  console.error("FATAL: HMEM_PROJECT_DIR not set");
  process.exit(1);
}

// Empty string → resolveHmemPath uses memory.hmem (no agent name required)
let AGENT_ID = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
let DEPTH = parseInt(process.env.HMEM_DEPTH || process.env.COUNCIL_DEPTH || "0", 10);
let ROLE = process.env.HMEM_AGENT_ROLE || process.env.COUNCIL_AGENT_ROLE || "worker";

// Optional: PID-based identity override (used by Das Althing orchestrator)
const ppid = process.ppid;
const ctxFile = path.join(PROJECT_DIR, "orchestrator", ".mcp_contexts", `${ppid}.json`);
try {
  if (fs.existsSync(ctxFile)) {
    const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf-8"));
    AGENT_ID = ctx.agent_id || AGENT_ID;
    DEPTH = ctx.depth ?? DEPTH;
    ROLE = ctx.role || ROLE;
  }
} catch {
  // Fallback to env vars — context file is optional
}

function log(msg: string) {
  console.error(`[hmem:${AGENT_ID || "default"}] ${msg}`);
}

// Load hmem config (hmem.config.json in project dir, falls back to defaults)
const hmemConfig = loadHmemConfig(PROJECT_DIR);
log(`Config: levels=[${hmemConfig.maxCharsPerLevel.join(",")}] depth=${hmemConfig.maxDepth} tiers=${JSON.stringify(hmemConfig.recentDepthTiers)}`);

// ---- Server ----
const server = new McpServer({
  name: "hmem",
  version: "1.1.0",
});

// ---- Tool: search_memory ----
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
    log(`search_memory: query="${query}", scope=${scope || "all"}, by=${AGENT_ID}`);

    const results = searchMemory(PROJECT_DIR, query, {
      scope: scope || "all",
      maxResults: max_results || 10,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No results for "${query}" (Scope: ${scope || "all"}).\n\nTip: Try more general terms or a different scope.`,
          },
        ],
      };
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

    return {
      content: [
        {
          type: "text" as const,
          text: `## Memory Search: "${query}"\n**${results.length} hits** (Scope: ${scope || "all"})\n\n${output}`,
        },
      ],
    };
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
    "The system auto-assigns an ID and timestamp. " +
    `Use prefix to categorize: ${prefixList}.\n\n` +
    "Store types:\n" +
    "  personal (default): Your private memory\n",
  {
    prefix: z.string().toUpperCase().describe(
      `Memory category: ${prefixList}`
    ),
    content: z.string().min(3).describe(
      "The memory content. Use tab indentation for depth levels. Example:\n" +
        "Built the Council Dashboard for Althing Inc.\n" +
        "\tMy role was frontend architecture with React + Vite\n" +
        "\t\tShadcnUI for components, SSE for real-time updates\n" +
        "\t\t\tAuth was tricky — EventSource can't send custom headers"
    ),
    links: z.array(z.string()).optional().describe(
      "Optional: IDs of related memories, e.g. ['P0001', 'L0005']"
    ),
    favorite: z.boolean().optional().describe(
      "Mark this entry as a favorite — shown with [♥] in bulk reads and always inlined with L2 detail. " +
      "Use for reference info you need to see every session, regardless of category."
    ),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' or 'company'"
    ),
    min_role: z.enum(["worker", "al", "pl", "ceo"]).default("worker").describe(
      "Minimum role to see this entry"
    ),
  },
  async ({ prefix, content, links, favorite, store: storeName, min_role: minRole }) => {
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker") as AgentRole;
    const isFirstTime = !AGENT_ID && !fs.existsSync(resolveHmemPath(PROJECT_DIR, ""));

    // Company store: only AL+ can write
    if (storeName === "company") {
      const ROLE_LEVEL: Record<string, number> = { worker: 0, al: 1, pl: 2, ceo: 3 };
      if ((ROLE_LEVEL[agentRole] || 0) < 1) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Only AL, PL, and CEO roles can write to company memory." }],
          isError: true,
        };
      }
    }

    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
      try {
        // Warn if database is corrupted
        if (hmemStore.corrupted) {
          return {
            content: [{ type: "text" as const, text:
              "WARNING: Memory database is corrupted! A backup (.corrupt) was saved automatically.\n" +
              "Writing to a corrupted database may cause further data loss.\n" +
              "Recover via: git show LAST_GOOD_COMMIT:path/to/file.hmem > recovered.hmem"
            }],
            isError: true,
          };
        }

        const effectiveMinRole = storeName === "company" ? (minRole as AgentRole) : ("worker" as AgentRole);
        const result = hmemStore.write(prefix, content, links, effectiveMinRole, favorite);
        const storeLabel = storeName === "company" ? "company" : (templateName || "memory");
        log(`write_memory [${storeLabel}]: ${result.id} (prefix=${prefix}, min_role=${effectiveMinRole})`);

        const hmemPath = resolveHmemPath(PROJECT_DIR, templateName);
        const firstTimeNote = isFirstTime
          ? `\nMemory store created: ${hmemPath}\nTo use a custom name, set HMEM_AGENT_ID in your .mcp.json.`
          : "";

        return {
          content: [{
            type: "text" as const,
            text: `Memory saved: ${result.id} (${result.timestamp.substring(0, 19)})\n` +
              `Store: ${storeLabel} | Category: ${prefix}` +
              (storeName === "company" ? ` | Clearance: ${effectiveMinRole}+` : "") +
              firstTimeNote,
          }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${e}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "update_memory",
  "Update the text of an existing memory entry or sub-node (your own personal memory). " +
    "Only modifies the text at the specified ID — children are preserved unchanged.\n\n" +
    "Use cases:\n" +
    "- Correct outdated wording: update_memory(id='L0003', content='corrected summary')\n" +
    "- Fix a sub-node: update_memory(id='L0003.2', content='corrected detail')\n" +
    "- Mark as obsolete: FIRST write the correction, THEN update with [✓ID] reference:\n" +
    "  1. write_memory(prefix='E', content='Correct fix is...') → E0076\n" +
    "  2. update_memory(id='E0042', content='Wrong — see [✓E0076]', obsolete=true)\n" +
    "- Mark as favorite: update_memory(id='D0010', content='...', favorite=true)\n\n" +
    "To add new child nodes, use append_memory. " +
    "To replace the entire tree, use delete_agent_memory + write_memory (curator only).",
  {
    id: z.string().describe("ID of the entry or node to update, e.g. 'L0003' or 'L0003.2'"),
    content: z.string().min(1).describe("New text content for this node (plain text, no indentation)"),
    links: z.array(z.string()).optional().describe(
      "Optional: update linked entry IDs (root entries only). Replaces existing links."
    ),
    obsolete: z.boolean().optional().describe(
      "Mark this root entry as no longer valid (root entries only). " +
      "Requires [✓ID] correction reference in content (e.g. 'Wrong — see [✓E0076]')."
    ),
    favorite: z.boolean().optional().describe(
      "Set or clear the [♥] favorite flag on this root entry (root entries only). " +
      "Favorites are always shown with L2 detail in bulk reads."
    ),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' or 'company'"
    ),
  },
  async ({ id, content, links, obsolete, favorite, store: storeName }) => {
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker") as AgentRole;

    if (storeName === "company") {
      const ROLE_LEVEL: Record<string, number> = { worker: 0, al: 1, pl: 2, ceo: 3 };
      if ((ROLE_LEVEL[agentRole] || 0) < 1) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Only AL, PL, and CEO roles can write to company memory." }],
          isError: true,
        };
      }
    }

    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
      try {
        if (hmemStore.corrupted) {
          return {
            content: [{ type: "text" as const, text: "WARNING: Memory database is corrupted! Aborting update to prevent further data loss." }],
            isError: true,
          };
        }

        const ok = hmemStore.updateNode(id, content, links, obsolete, favorite);
        const storeLabel = storeName === "company" ? "company" : (templateName || "memory");
        log(`update_memory [${storeLabel}]: ${id} → ${ok ? "updated" : "not found"}${obsolete ? " (marked obsolete)" : ""}${favorite !== undefined ? ` (favorite=${favorite})` : ""}`);

        if (!ok) {
          return {
            content: [{ type: "text" as const, text: `ERROR: Entry "${id}" not found in ${storeLabel}.` }],
            isError: true,
          };
        }

        const parts: string[] = [`Updated: ${id}`];
        if (links !== undefined) parts.push("links updated");
        if (obsolete === true) parts.push("marked as [!] obsolete");
        if (favorite === true) parts.push("marked as [♥] favorite");
        if (favorite === false) parts.push("favorite flag cleared");
        return { content: [{ type: "text" as const, text: parts.join(" | ") }] };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${e}` }],
        isError: true,
      };
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
    "  1 tab  = grandchild, etc.\n\n" +
    "Examples:\n" +
    "  append_memory(id='L0003', content='New finding\\n\\tSub-detail') " +
      "→ adds L2 node + L3 child\n" +
    "  append_memory(id='L0003.2', content='Extra note') " +
      "→ adds L3 node under the L2 node L0003.2",
  {
    id: z.string().describe(
      "Root entry ID or parent node ID to append children to, e.g. 'L0003' or 'L0003.2'"
    ),
    content: z.string().min(1).describe(
      "Tab-indented content to append. 0 tabs = direct child of id.\n" +
      "Example: 'New point\\n\\tSub-detail'"
    ),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' or 'company'"
    ),
  },
  async ({ id, content, store: storeName }) => {
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker") as AgentRole;

    if (storeName === "company") {
      const ROLE_LEVEL: Record<string, number> = { worker: 0, al: 1, pl: 2, ceo: 3 };
      if ((ROLE_LEVEL[agentRole] || 0) < 1) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Only AL, PL, and CEO roles can write to company memory." }],
          isError: true,
        };
      }
    }

    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
      try {
        if (hmemStore.corrupted) {
          return {
            content: [{ type: "text" as const, text: "WARNING: Memory database is corrupted! Aborting append to prevent further data loss." }],
            isError: true,
          };
        }

        const result = hmemStore.appendChildren(id, content);
        const storeLabel = storeName === "company" ? "company" : (templateName || "memory");
        log(`append_memory [${storeLabel}]: ${id} + ${result.count} nodes → [${result.ids.join(", ")}]`);

        if (result.count === 0) {
          return {
            content: [{ type: "text" as const, text: "No nodes appended — content was empty or contained no valid lines." }],
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Appended ${result.count} node${result.count === 1 ? "" : "s"} to ${id}.\n` +
              `New top-level children: ${result.ids.join(", ")}`,
          }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${e}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "read_memory",
  "Read from your hierarchical long-term memory (.hmem). " +
    "At startup, you received all Level 1 entries (rough summaries). " +
    "Use this tool to drill deeper into specific memories.\n\n" +
    "Query modes:\n" +
    "- By ID: read_memory({ id: 'P0001' }) → L1 + direct L2 children (one level at a time)\n" +
    "- By node ID: read_memory({ id: 'P0001.2' }) → that node's content + its direct children\n" +
    "- By prefix: read_memory({ prefix: 'L' }) → All Lessons Learned (Level 1)\n" +
    "- By time: read_memory({ after: '2026-02-15', before: '2026-02-17' })\n" +
    "- Search: read_memory({ search: 'SSE' }) → Full-text search across all levels\n" +
    "- Time-around: read_memory({ time_around: 'P0001' }) → entries near P0001's timestamp\n\n" +
    "Lazy loading: ID queries always return the node + its DIRECT children only.\n" +
    "To go deeper, call read_memory(id=child_id). depth parameter is ignored for ID queries.\n\n" +
    "Store types:\n" +
    "  personal (default): Your private memory\n",
  {
    id: z.string().optional().describe("Specific memory ID, e.g. 'P0001' or 'L0023'"),
    depth: z.number().min(1).max(3).optional().describe("How deep to read (1-3). Default: 2 when reading by ID, 1 for listings. L4/L5 accessible via direct node ID only."),
    prefix: z.string().optional().describe(`Filter by category: ${prefixKeys.join(", ")}`),
    after: z.string().optional().describe("Only entries after this date (ISO format, e.g. '2026-02-15')"),
    before: z.string().optional().describe("Only entries before this date (ISO format)"),
    search: z.string().optional().describe("Full-text search across all memory levels"),
    limit: z.number().optional().describe("Max results (default: unlimited — all L1 entries are returned)"),
    time: z.string().optional().describe("Time filter 'HH:MM' — filter entries by time of day"),
    period: z.string().optional().describe("Time window: '+4h' (after), '-2h' (before), '4h' (±4h symmetric), 'both' (±2h default)"),
    time_around: z.string().optional().describe("Reference entry ID — find entries created around the same time"),
    show_obsolete: z.boolean().optional().describe("Include all obsolete entries (default: only top 3 most-accessed)"),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Source store: 'personal' or 'company'"
    ),
    curator: z.boolean().optional().describe(
      "Set true to show full metadata (access counts, roles, dates). For curators only."
    ),
  },
  async ({ id, depth, prefix, after, before, search, limit: maxResults, time, period, time_around, show_obsolete, store: storeName, curator }) => {
    if (AGENT_ID === "UNKNOWN") {
      return {
        content: [{ type: "text" as const, text: "ERROR: Agent-ID unknown. read_memory is only available for spawned agents." }],
        isError: true,
      };
    }

    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker") as AgentRole;

    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR, hmemConfig)
        : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
      try {
        const corruptionWarning = hmemStore.corrupted
          ? "⚠ WARNING: Memory database is corrupted! Reads may be incomplete. A backup (.corrupt) was saved.\n\n"
          : "";

        const effectiveDepth = depth || (id ? 2 : 1);

        const entries = hmemStore.read({
          id, depth: effectiveDepth, prefix, after, before, search,
          limit: maxResults,
          agentRole: storeName === "company" ? agentRole : undefined,
          time, period, timeAround: time_around,
          showObsolete: show_obsolete,
        });

        if (entries.length === 0) {
          const hint = id ? `No memory with ID "${id}".` :
            search ? `No memories matching "${search}".` :
              time_around ? `No entries found around "${time_around}".` :
              "No memories found for this query.";
          return { content: [{ type: "text" as const, text: hint }] };
        }

        // Format output
        const isBulkListing = !id && !search && !time_around;
        const output = isBulkListing
          ? formatGroupedOutput(hmemStore, entries, curator ?? false, hmemConfig)
          : formatFlatOutput(entries, curator ?? false);

        const stats = hmemStore.stats();
        const storeLabel = storeName === "company" ? "company" : templateName;
        const visibleCount = entries.length;
        const header = `## Memory: ${storeLabel} (${stats.total} total entries)\n` +
          `Query: ${id ? `id=${id}` : ""}${prefix ? `prefix=${prefix}` : ""}${search ? `search="${search}"` : ""}${time_around ? `time_around=${time_around}` : ""}${after ? ` after=${after}` : ""}${before ? ` before=${before}` : ""}${time ? ` time=${time}` : ""} | Depth: ${effectiveDepth} | Results: ${visibleCount}\n`;

        log(`read_memory [${storeLabel}]: ${visibleCount} results (depth=${effectiveDepth}, role=${agentRole})`);

        return {
          content: [{
            type: "text" as const,
            text: corruptionWarning + header + "\n" + output,
          }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${e}` }],
        isError: true,
      };
    }
  }
);

// bump_memory removed — access_count is auto-incremented on reads, favorites cover explicit importance

// ---- Curator Tools (ceo role only) ----

const AUDIT_STATE_FILE = process.env.HMEM_AUDIT_STATE_PATH
  || path.join(PROJECT_DIR, "audit_state.json");

function loadAuditState(): Record<string, string> {
  try {
    if (fs.existsSync(AUDIT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(AUDIT_STATE_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveAuditState(state: Record<string, string>): void {
  const dir = path.dirname(AUDIT_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = AUDIT_STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, AUDIT_STATE_FILE);
}

function isCurator(): boolean {
  return ROLE === "ceo";
}

server.tool(
  "get_audit_queue",
  "CURATOR ONLY (ceo role). Returns agents whose .hmem has changed since last audit. " +
    "Use this at the start of each curation run to get the list of agents to process. " +
    "Each agent should be audited in a separate spawn to keep context bounded.",
  {},
  async () => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: get_audit_queue is only available to the ceo/curator role." }],
        isError: true,
      };
    }

    const auditState = loadAuditState();

    // Scan for .hmem files in PROJECT_DIR and subdirectories (1 level deep)
    const queue: Array<{ name: string; hmemPath: string; modified: string; lastAudit: string | null }> = [];

    // Check common agent directory patterns
    for (const subdir of ["Agents", "Assistenten", "agents", "."]) {
      const dir = path.join(PROJECT_DIR, subdir);
      if (!fs.existsSync(dir)) continue;

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        const hmemPath = path.join(dir, name, `${name}.hmem`);
        if (!fs.existsSync(hmemPath)) continue;

        const stat = fs.statSync(hmemPath);
        const modified = stat.mtime.toISOString();
        const lastAudit = auditState[name] || null;

        if (!lastAudit || new Date(modified) > new Date(lastAudit)) {
          queue.push({ name, hmemPath, modified, lastAudit });
        }
      }
    }

    // Also check for standalone memory.hmem in PROJECT_DIR
    const defaultHmem = path.join(PROJECT_DIR, "memory.hmem");
    if (fs.existsSync(defaultHmem)) {
      const stat = fs.statSync(defaultHmem);
      const modified = stat.mtime.toISOString();
      const lastAudit = auditState["default"] || null;
      if (!lastAudit || new Date(modified) > new Date(lastAudit)) {
        queue.push({ name: "default", hmemPath: defaultHmem, modified, lastAudit });
      }
    }

    if (queue.length === 0) {
      return {
        content: [{ type: "text" as const, text: "Audit queue is empty — all agent memories are up to date." }],
      };
    }

    const lines = queue.map(a =>
      `- **${a.name}**: modified ${a.modified.substring(0, 16)}` +
      (a.lastAudit ? ` | last audited ${a.lastAudit.substring(0, 16)}` : " | never audited")
    );

    return {
      content: [{
        type: "text" as const,
        text: `## Audit Queue (${queue.length} agents to check)\n\n${lines.join("\n")}\n\n` +
          `Process one agent per spawn: terminate after each to keep context bounded.`,
      }],
    };
  }
);

server.tool(
  "read_agent_memory",
  "CURATOR ONLY (ceo role). Read the full memory of any agent (for audit purposes). " +
    "Returns all entries at the specified depth. Use depth=3 for a thorough audit.",
  {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR', 'SIGURD'"),
    depth: z.number().int().min(1).max(5).optional().describe("Depth to read (1-5, default: 3)"),
  },
  async ({ agent_name, depth }) => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: read_agent_memory is only available to the ceo/curator role." }],
        isError: true,
      };
    }

    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
      return {
        content: [{ type: "text" as const, text: `No .hmem found for agent "${agent_name}" (expected: ${hmemPath}).` }],
      };
    }

    const store = new HmemStore(hmemPath, hmemConfig);
    try {
      const entries = store.read({ depth: depth || 3, limit: 500 });
      const stats = store.stats();

      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: `Agent "${agent_name}" has no memory entries.` }] };
      }

      const lines: string[] = [`## Memory: ${agent_name} (${stats.total} entries, depth=${depth || 3})\n`];
      for (const e of entries) {
        const date = e.created_at.substring(0, 10);
        const role = e.min_role !== "worker" ? ` [${e.min_role}+]` : "";
        const access = e.access_count > 0 ? ` (${e.access_count}x)` : "";
        lines.push(`[${e.id}] ${date}${role}${access}`);
        lines.push(`  L1: ${e.level_1}`);
        if (e.level_2) lines.push(`  L2: ${e.level_2}`);
        if (e.level_3) lines.push(`  L3: ${e.level_3}`);
        if (e.level_4) lines.push(`  L4: ${e.level_4}`);
        if (e.level_5) lines.push(`  L5: ${e.level_5}`);
        if (e.links?.length) lines.push(`  Links: ${e.links.join(", ")}`);
        lines.push("");
      }

      log(`read_agent_memory [CURATOR]: ${agent_name} depth=${depth || 3} → ${entries.length} entries`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } finally {
      store.close();
    }
  }
);

server.tool(
  "fix_agent_memory",
  "CURATOR ONLY (ceo role). Correct a specific entry or node in any agent's memory.\n\n" +
    "Accepts both root IDs ('L0003') and compound node IDs ('L0003.2'):\n" +
    "- Root ID: updates L1 summary text, min_role clearance, and/or obsolete flag\n" +
    "- Compound node ID: updates the content of that specific node\n\n" +
    "To fix wrong prefix: delete + re-add (prefix cannot be changed in-place).\n" +
    "To consolidate fragmented P entries: use read_agent_memory to read them, " +
    "fix_agent_memory to update the keeper entry, delete_agent_memory to remove duplicates.",
  {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR'"),
    entry_id: z.string().describe(
      "Root entry ID ('L0003') or compound node ID ('L0003.2'). " +
      "Node IDs update memory_nodes.content directly."
    ),
    content: z.string().optional().describe(
      "New text content. For root entries: replaces the L1 summary. " +
      "For node IDs: replaces that node's content."
    ),
    min_role: z.enum(["worker", "al", "pl", "ceo"]).optional().describe(
      "Update access clearance (root entries only)."
    ),
    obsolete: z.boolean().optional().describe(
      "Mark or unmark as obsolete (root entries only). " +
      "Obsolete entries stay in memory but are shown with [⚠ OBSOLETE]."
    ),
    favorite: z.boolean().optional().describe(
      "Set or clear the [♥] favorite flag (root entries only)."
    ),
  },
  async ({ agent_name, entry_id, content, min_role, obsolete, favorite }) => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: fix_agent_memory is only available to the ceo/curator role." }],
        isError: true,
      };
    }

    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
      return {
        content: [{ type: "text" as const, text: `No .hmem found for agent "${agent_name}".` }],
        isError: true,
      };
    }

    const store = new HmemStore(hmemPath, hmemConfig);
    try {
      const isNode = entry_id.includes(".");
      let ok = false;
      const changed: string[] = [];

      if (isNode) {
        // Compound node ID — update memory_nodes.content
        if (!content) {
          return {
            content: [{ type: "text" as const, text: "ERROR: 'content' is required when fixing a compound node ID." }],
            isError: true,
          };
        }
        ok = store.updateNode(entry_id, content);
        if (ok) changed.push("content");
      } else {
        // Root entry — update memories table
        if (!content && min_role === undefined && obsolete === undefined && favorite === undefined) {
          return {
            content: [{ type: "text" as const, text: "ERROR: Provide at least one of: content, min_role, obsolete, favorite." }],
            isError: true,
          };
        }
        if (content) {
          ok = store.updateNode(entry_id, content, undefined, obsolete, favorite, true /* curatorBypass */);
          changed.push("L1");
          if (obsolete !== undefined) changed.push("obsolete");
          if (favorite !== undefined) changed.push("favorite");
        } else {
          const fields: any = {};
          if (min_role !== undefined) fields.min_role = min_role;
          if (obsolete !== undefined) fields.obsolete = obsolete;
          if (favorite !== undefined) fields.favorite = favorite;
          ok = store.update(entry_id, fields);
        }
        if (min_role !== undefined) changed.push("min_role");
        if (!content && obsolete !== undefined) changed.push("obsolete");
        if (!content && favorite !== undefined) changed.push("favorite");
      }

      log(`fix_agent_memory [CURATOR]: ${agent_name} ${entry_id} → ${ok ? "updated" : "not found"} (${changed.join(", ")})`);

      return {
        content: [{
          type: "text" as const,
          text: ok
            ? `Fixed: ${agent_name}/${entry_id} (${changed.join(", ")})`
            : `ERROR: Entry "${entry_id}" not found in ${agent_name}'s memory.`,
        }],
        isError: !ok,
      };
    } finally {
      store.close();
    }
  }
);

server.tool(
  "append_agent_memory",
  "CURATOR ONLY (ceo role). Append new child nodes to an existing entry in any agent's memory. " +
    "Use exclusively for merging/consolidating entries — e.g. when collapsing two P entries into one, " +
    "carry over the best content from the entry being deleted into the keeper before deleting.\n\n" +
    "Content is tab-indented relative to the parent (same as append_memory):\n" +
    "  0 tabs = direct child of id\n" +
    "  1 tab  = grandchild, etc.",
  {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR'"),
    id: z.string().describe(
      "Root entry ID or parent node ID to append children to, e.g. 'P0004' or 'P0004.2'"
    ),
    content: z.string().min(1).describe(
      "Tab-indented content to append. 0 tabs = direct child of id."
    ),
  },
  async ({ agent_name, id, content }) => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: append_agent_memory is only available to the ceo/curator role." }],
        isError: true,
      };
    }

    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
      return {
        content: [{ type: "text" as const, text: `No .hmem found for agent "${agent_name}".` }],
        isError: true,
      };
    }

    const store = new HmemStore(hmemPath, hmemConfig);
    try {
      const result = store.appendChildren(id, content);
      log(`append_agent_memory [CURATOR]: ${agent_name} ${id} + ${result.count} nodes → [${result.ids.join(", ")}]`);

      if (result.count === 0) {
        return {
          content: [{ type: "text" as const, text: "No nodes appended — content was empty or contained no valid lines." }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: `Appended ${result.count} node${result.count === 1 ? "" : "s"} to ${agent_name}/${id}.\n` +
            `New top-level children: ${result.ids.join(", ")}`,
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${e}` }],
        isError: true,
      };
    } finally {
      store.close();
    }
  }
);

server.tool(
  "delete_agent_memory",
  "CURATOR ONLY (ceo role). Delete an entry from any agent's memory. " +
    "Use sparingly — only for exact duplicates or entries that are factually wrong and cannot be fixed.",
  {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR'"),
    entry_id: z.string().describe("Entry ID to delete, e.g. 'E0007'"),
  },
  async ({ agent_name, entry_id }) => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: delete_agent_memory is only available to the ceo/curator role." }],
        isError: true,
      };
    }

    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
      return {
        content: [{ type: "text" as const, text: `No .hmem found for agent "${agent_name}".` }],
        isError: true,
      };
    }

    const store = new HmemStore(hmemPath, hmemConfig);
    try {
      const ok = store.delete(entry_id);
      log(`delete_agent_memory [CURATOR]: ${agent_name} ${entry_id} → ${ok ? "deleted" : "not found"}`);

      return {
        content: [{
          type: "text" as const,
          text: ok
            ? `Deleted: ${agent_name}/${entry_id}`
            : `ERROR: Entry "${entry_id}" not found in ${agent_name}'s memory.`,
        }],
        isError: !ok,
      };
    } finally {
      store.close();
    }
  }
);

server.tool(
  "mark_audited",
  "CURATOR ONLY (ceo role). Mark an agent as audited (updates timestamp in audit_state.json). " +
    "Call this after finishing each agent in the audit queue.",
  {
    agent_name: z.string().describe("Template name of the agent that was audited, e.g. 'THOR'"),
  },
  async ({ agent_name }) => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: mark_audited is only available to the ceo/curator role." }],
        isError: true,
      };
    }

    const state = loadAuditState();
    state[agent_name] = new Date().toISOString();
    saveAuditState(state);

    log(`mark_audited [CURATOR]: ${agent_name}`);
    return {
      content: [{ type: "text" as const, text: `Marked as audited: ${agent_name} (${state[agent_name].substring(0, 16)})` }],
    };
  }
);

// ---- Output Formatting ----

/**
 * Format bulk-read output grouped by prefix with header entries.
 * Non-curator: strips [♥], [★] markers, shortens [OBSOLETE] to [!].
 */
function formatGroupedOutput(
  store: HmemStore,
  entries: MemoryEntry[],
  curator: boolean,
  config: HmemConfig,
): string {
  const lines: string[] = [];

  const headers = store.getHeaders();
  const headerMap = new Map<string, MemoryEntry>();
  for (const h of headers) headerMap.set(h.prefix, h);

  // Get total counts per prefix from DB (includes hidden entries)
  const stats = store.stats();

  const nonObsolete = entries.filter(e => !e.obsolete);
  const obsolete = entries.filter(e => e.obsolete);

  const byPrefix = new Map<string, MemoryEntry[]>();
  for (const e of nonObsolete) {
    const arr = byPrefix.get(e.prefix);
    if (arr) arr.push(e);
    else byPrefix.set(e.prefix, [e]);
  }

  for (const [prefix, prefixEntries] of byPrefix) {
    const header = headerMap.get(prefix);
    const description = header?.level_1 ?? config.prefixDescriptions[prefix] ?? config.prefixes[prefix] ?? prefix;
    const totalCount = stats.byPrefix[prefix] ?? prefixEntries.length;
    lines.push(`## ${description} (${prefixEntries.length}/${totalCount} shown)\n`);

    for (const e of prefixEntries) {
      renderEntryFormatted(lines, e, curator);
    }
  }

  if (obsolete.length > 0) {
    lines.push("");
    for (const e of obsolete) {
      renderEntryFormatted(lines, e, curator);
    }
  }

  return lines.join("\n");
}

function formatFlatOutput(entries: MemoryEntry[], curator: boolean): string {
  const lines: string[] = [];
  for (const e of entries) {
    renderEntryFormatted(lines, e, curator);
  }
  return lines.join("\n");
}

function renderEntryFormatted(lines: string[], e: MemoryEntry, curator: boolean): void {
  const isNode = e.id.includes(".");

  if (isNode) {
    if (curator) {
      const nodeDepth = (e.id.match(/\./g) || []).length + 1;
      lines.push(`[${e.id}] L${nodeDepth}: ${e.level_1}`);
    } else {
      lines.push(`${e.id}  ${e.level_1}`);
    }
  } else {
    if (curator) {
      const promotedTag = e.promoted === "favorite" ? " [♥]" : e.promoted === "access" ? " [★]" : "";
      const obsoleteTag = e.obsolete ? " [⚠ OBSOLETE]" : "";
      const date = e.created_at.substring(0, 10);
      const accessed = e.access_count > 0 ? ` (${e.access_count}x accessed)` : "";
      const roleTag = e.min_role !== "worker" ? ` [${e.min_role}+]` : "";
      lines.push(`[${e.id}] ${date}${roleTag}${promotedTag}${obsoleteTag}${accessed}`);
      lines.push(`  L1: ${e.level_1}`);
    } else {
      // Non-curator: [♥] favorites, [★] promoted, [!] obsolete
      const promotedTag = e.promoted === "favorite" ? " [♥]" : e.promoted === "access" ? " [★]" : "";
      const obsoleteTag = e.obsolete ? " [!]" : "";
      const mmdd = e.created_at.substring(5, 10);
      lines.push(`${e.id} ${mmdd}${promotedTag}${obsoleteTag}  ${e.level_1}`);
    }
  }

  if (e.children && e.children.length > 0) {
    if (e.expanded) {
      if (curator) {
        lines.push(`  ${e.children.length} ${e.children.length === 1 ? "child" : "children"}:`);
      }
      renderChildrenFormatted(lines, e.children, curator);
    } else if (e.hiddenChildrenCount !== undefined) {
      const child = e.children[0] as MemoryNode;
      if (curator) {
        const hint = (child.child_count ?? 0) > 0
          ? `  (${child.child_count} — use id="${child.id}" to expand)`
          : "";
        lines.push(`  [${child.id}] L${child.depth}: ${child.content}${hint}`);
      } else {
        const hint = (child.child_count ?? 0) > 0
          ? `  [+${child.child_count} → ${child.id}]`
          : "";
        lines.push(`  ${child.depth}.${child.seq}  ${child.content}${hint}`);
      }
      if (child.children && child.children.length > 0) {
        renderChildrenFormatted(lines, child.children, curator);
      }
      if (e.hiddenChildrenCount > 0) {
        lines.push(`  [+${e.hiddenChildrenCount} more → ${e.id}]`);
      }
    } else {
      if (curator) {
        lines.push(`  ${e.children.length} ${e.children.length === 1 ? "child" : "children"}:`);
      }
      renderChildrenFormatted(lines, e.children, curator);
    }
  }

  if (e.links && e.links.length > 0) lines.push(`  Links: ${e.links.join(", ")}`);

  if (e.linkedEntries && e.linkedEntries.length > 0) {
    lines.push(`  --- Linked entries ---`);
    for (const linked of e.linkedEntries) {
      const isLinkedNode = linked.id.includes(".");
      if (isLinkedNode) {
        const d = (linked.id.match(/\./g) || []).length + 1;
        lines.push(`  [${linked.id}] L${d}: ${linked.level_1}`);
      } else {
        const ldate = linked.created_at.substring(0, 10);
        lines.push(`  [${linked.id}] ${ldate}`);
        lines.push(`    L1: ${linked.level_1}`);
      }
      if (linked.children && linked.children.length > 0) {
        for (const lchild of linked.children as MemoryNode[]) {
          const cd = (lchild.id.match(/\./g) || []).length + 1;
          const hint = (lchild.child_count ?? 0) > 0
            ? ` (${lchild.child_count} ${lchild.child_count === 1 ? "child" : "children"} — use id="${lchild.id}" to expand)`
            : "";
          lines.push(`    [${lchild.id}] L${cd}: ${lchild.content}${hint}`);
        }
      }
    }
  }

  lines.push("");
}

function renderChildrenFormatted(lines: string[], children: MemoryNode[], curator: boolean): void {
  for (const child of children) {
    const indent = "  ".repeat(child.depth - 1);
    if (curator) {
      const hint = (child.child_count ?? 0) > 0
        ? `  (${child.child_count} — use id="${child.id}" to expand)`
        : "";
      lines.push(`${indent}[${child.id}] L${child.depth}: ${child.content}${hint}`);
    } else {
      const hint = (child.child_count ?? 0) > 0
        ? `  [+${child.child_count} → ${child.id}]`
        : "";
      lines.push(`${indent}${child.depth}.${child.seq}  ${child.content}${hint}`);
    }
    if (child.children && child.children.length > 0) {
      renderChildrenFormatted(lines, child.children, curator);
    }
  }
}

// ---- Start ----
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in MCP Server:", error);
  process.exit(1);
});

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
import type { AgentRole, MemoryNode } from "./hmem-store.js";
import { loadHmemConfig, formatPrefixList } from "./hmem-config.js";

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
    "  personal (default): Your private memory\n" +
    "  company: Shared knowledge base (FIRMENWISSEN) — requires AL+ role to write",
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
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' (your own memory) or 'company' (shared FIRMENWISSEN, AL+ only)"
    ),
    min_role: z.enum(["worker", "al", "pl", "ceo"]).default("worker").describe(
      "Minimum role to see this entry (company store only). 'worker' = everyone, 'al' = AL+PL+CEO, etc."
    ),
  },
  async ({ prefix, content, links, store: storeName, min_role: minRole }) => {
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker") as AgentRole;
    const isFirstTime = !AGENT_ID && !fs.existsSync(resolveHmemPath(PROJECT_DIR, ""));

    // Company store: only AL+ can write
    if (storeName === "company") {
      const ROLE_LEVEL: Record<string, number> = { worker: 0, al: 1, pl: 2, ceo: 3 };
      if ((ROLE_LEVEL[agentRole] || 0) < 1) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Only AL, PL, and CEO roles can write to company memory (FIRMENWISSEN)." }],
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
        const result = hmemStore.write(prefix, content, links, effectiveMinRole);
        const storeLabel = storeName === "company" ? "FIRMENWISSEN" : (templateName || "memory");
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
  "read_memory",
  "Read from your hierarchical long-term memory (.hmem). " +
    "At startup, you received all Level 1 entries (rough summaries). " +
    "Use this tool to drill deeper into specific memories.\n\n" +
    "Query modes:\n" +
    "- By ID: read_memory({ id: 'P0001' }) → L1 + direct L2 children (one level at a time)\n" +
    "- By node ID: read_memory({ id: 'P0001.2' }) → that node's content + its direct children\n" +
    "- By prefix: read_memory({ prefix: 'L' }) → All Lessons Learned (Level 1)\n" +
    "- By time: read_memory({ after: '2026-02-15', before: '2026-02-17' })\n" +
    "- Search: read_memory({ search: 'SSE' }) → Full-text search across all levels\n\n" +
    "Lazy loading: ID queries always return the node + its DIRECT children only.\n" +
    "To go deeper, call read_memory(id=child_id). depth parameter is ignored for ID queries.\n\n" +
    "Store types:\n" +
    "  personal (default): Your private memory\n" +
    "  company: Shared knowledge base (FIRMENWISSEN) — filtered by your role clearance",
  {
    id: z.string().optional().describe("Specific memory ID, e.g. 'P0001' or 'L0023'"),
    depth: z.number().min(1).max(3).optional().describe("How deep to read (1-3). Default: 2 when reading by ID, 1 for listings. L4/L5 accessible via direct node ID only."),
    prefix: z.string().optional().describe(`Filter by category: ${prefixKeys.join(", ")}`),
    after: z.string().optional().describe("Only entries after this date (ISO format, e.g. '2026-02-15')"),
    before: z.string().optional().describe("Only entries before this date (ISO format)"),
    search: z.string().optional().describe("Full-text search across all memory levels"),
    limit: z.number().optional().describe("Max results (default: 50)"),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Source store: 'personal' (your own memory) or 'company' (shared FIRMENWISSEN)"
    ),
    curator: z.boolean().optional().describe(
      "Set true to show full metadata (access counts, roles, dates). For curators only."
    ),
  },
  async ({ id, depth, prefix, after, before, search, limit: maxResults, store: storeName }) => {
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
        // Warn if database is corrupted (but still allow reads)
        const corruptionWarning = hmemStore.corrupted
          ? "⚠ WARNING: Memory database is corrupted! Reads may be incomplete. A backup (.corrupt) was saved.\n\n"
          : "";

        // Default depth: 2 for single-ID lookup, 1 for listings
        const effectiveDepth = depth || (id ? 2 : 1);

        const entries = hmemStore.read({
          id, depth: effectiveDepth, prefix, after, before, search,
          limit: maxResults || 50,
          agentRole: storeName === "company" ? agentRole : undefined,
        });

        if (entries.length === 0) {
          const hint = id ? `No memory with ID "${id}".` :
            search ? `No memories matching "${search}".` :
              "No memories found for this query.";
          return {
            content: [{ type: "text" as const, text: hint }],
          };
        }

        // Format output — tree-aware
        const lines: string[] = [];
        for (const e of entries) {
          const isNode = e.id.includes(".");

          if (isNode) {
            const depth = (e.id.match(/\./g) || []).length + 1;
            lines.push(`[${e.id}] L${depth}: ${e.level_1}`);
          } else {
            const date = e.created_at.substring(0, 10);
            const accessed = e.access_count > 0 ? ` (${e.access_count}x accessed)` : "";
            const roleTag = e.min_role !== "worker" ? ` [${e.min_role}+]` : "";
            lines.push(`[${e.id}] ${date}${roleTag}${accessed}`);
            lines.push(`  L1: ${e.level_1}`);
          }

          // Children (populated for ID-based reads)
          if (e.children && e.children.length > 0) {
            lines.push(`  ${e.children.length} ${e.children.length === 1 ? "child" : "children"}:`);
            for (const child of e.children as MemoryNode[]) {
              const childDepth = (child.id.match(/\./g) || []).length + 1;
              const hint = (child.child_count ?? 0) > 0
                ? `  (${child.child_count} ${child.child_count === 1 ? "child" : "children"} — use id="${child.id}" to expand)`
                : "";
              lines.push(`  [${child.id}] L${childDepth}: ${child.content}${hint}`);
            }
          }

          if (e.links && e.links.length > 0) lines.push(`  Links: ${e.links.join(", ")}`);

          // Auto-resolved linked entries
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

        const stats = hmemStore.stats();
        const storeLabel = storeName === "company" ? "FIRMENWISSEN" : templateName;
        const header = `## Memory: ${storeLabel} (${stats.total} total entries)\n` +
          `Query: ${id ? `id=${id}` : ""}${prefix ? `prefix=${prefix}` : ""}${search ? `search="${search}"` : ""}${after ? ` after=${after}` : ""}${before ? ` before=${before}` : ""} | Depth: ${effectiveDepth} | Results: ${entries.length}\n`;

        log(`read_memory [${storeLabel}]: ${entries.length} results (depth=${effectiveDepth}, role=${agentRole})`);

        return {
          content: [{
            type: "text" as const,
            text: corruptionWarning + header + "\n" + lines.join("\n"),
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
  "CURATOR ONLY (ceo role). Correct a specific entry in any agent's memory. " +
    "Use to fix wrong content, re-categorize (wrong prefix cannot be changed — delete + re-add), " +
    "or adjust min_role clearance.",
  {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR'"),
    entry_id: z.string().describe("Entry ID to fix, e.g. 'L0003'"),
    level_1: z.string().optional().describe("Corrected Level 1 summary"),
    level_2: z.string().optional().describe("Corrected Level 2 detail (null to clear)"),
    level_3: z.string().optional().describe("Corrected Level 3 detail (null to clear)"),
    min_role: z.enum(["worker", "al", "pl", "ceo"]).optional().describe("Update access clearance"),
  },
  async ({ agent_name, entry_id, level_1, level_2, level_3, min_role }) => {
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
      const fields: any = {};
      if (level_1 !== undefined) fields.level_1 = level_1;
      if (level_2 !== undefined) fields.level_2 = level_2;
      if (level_3 !== undefined) fields.level_3 = level_3;
      if (min_role !== undefined) fields.min_role = min_role;

      const ok = store.update(entry_id, fields);
      log(`fix_agent_memory [CURATOR]: ${agent_name} ${entry_id} → ${ok ? "updated" : "not found"}`);

      return {
        content: [{
          type: "text" as const,
          text: ok
            ? `Fixed: ${agent_name}/${entry_id} (fields: ${Object.keys(fields).join(", ")})`
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

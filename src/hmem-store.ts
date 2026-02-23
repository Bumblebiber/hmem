/**
 * Humanlike Memory Store (.hmem)
 *
 * SQLite-based long-term memory for agents with true tree structure.
 * L1 summaries live in the `memories` table (injected at startup).
 * L2+ nodes live in `memory_nodes` — each node has its own compound ID
 * (e.g., E0006.1, E0006.1.2) and is individually addressable.
 *
 * Two store types:
 *   - Personal: per-agent memory (Agents/THOR/THOR.hmem)
 *   - Company:  shared knowledge base (FIRMENWISSEN.hmem) with role-based access
 *
 * ID format:
 *   Root entries: PREFIX + zero-padded sequence (e.g., P0001, L0023, T0042)
 *   Sub-nodes:    root_id + "." + sibling_seq, recursively (e.g., E0006.1, E0006.1.2)
 *
 * Prefixes: P=Project, L=Lesson, T=Task, E=Error, D=Decision, M=Milestone, S=Skill, N=Navigator
 *
 * Role hierarchy: worker < al < pl < ceo
 * Each entry has a min_role — agents only see entries at or below their clearance.
 *
 * read_memory(id) semantics:
 *   Always returns the node + its DIRECT children only.
 *   To go deeper, call read_memory(id=child_id).
 *   depth parameter is IGNORED for ID-based queries.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { HmemConfig, DepthTier } from "./hmem-config.js";
import { DEFAULT_CONFIG, resolveDepthForPosition } from "./hmem-config.js";

// ---- Types ----

export type AgentRole = "worker" | "al" | "pl" | "ceo";

export interface MemoryEntry {
  id: string;
  prefix: string;
  seq: number;
  created_at: string;
  level_1: string;
  level_2: string | null;
  level_3: string | null;
  level_4: string | null;
  level_5: string | null;
  access_count: number;
  last_accessed: string | null;
  links: string[] | null;
  min_role: AgentRole;
  /** True if the entry has been marked as no longer valid. Shown with [⚠ OBSOLETE] in reads. */
  obsolete?: boolean;
  /** True if the agent explicitly marked this entry as a favorite. Shown with [♥] in reads. */
  favorite?: boolean;
  /**
   * Set by bulk reads to indicate why this entry received extra depth inline.
   * 'favorite' = favorite flag set, 'access' = top-N by access_count.
   * Rendered as [♥] or [★] in output.
   */
  promoted?: "access" | "favorite";
  /**
   * In bulk reads: number of direct children NOT shown (only the latest child is included).
   * undefined = ID-based read (all direct children shown as usual).
   * 0 = bulk read, entry has exactly 1 child (nothing hidden).
   * N>0 = bulk read, N additional children exist beyond the one shown.
   */
  hiddenChildrenCount?: number;
  children?: MemoryNode[];       // populated for ID-based reads and bulk reads (latest child)
  linkedEntries?: MemoryEntry[]; // auto-resolved linked entries (ID-based reads only)
}

export interface MemoryNode {
  id: string;           // E0006.1, E0006.1.2
  parent_id: string;    // E0006 or E0006.1
  root_id: string;      // always the root memories.id
  depth: number;        // 2-5
  seq: number;          // sibling order (1-based)
  content: string;
  created_at: string;
  access_count: number;
  last_accessed: string | null;
  child_count?: number;     // populated when fetching children
  children?: MemoryNode[];  // populated when fetching with depth > 1
}

export interface ReadOptions {
  id?: string;
  depth?: number;             // ignored for ID queries; 1-5 for bulk (default 1)
  prefix?: string;            // "P", "L", "T", "E", "D", "M", "S"
  after?: string;             // ISO date
  before?: string;            // ISO date
  search?: string;            // full-text search across all levels
  limit?: number;             // max results, default from config
  agentRole?: AgentRole;      // filter by role clearance (company store)
  recentDepthTiers?: import("./hmem-config.js").DepthTier[]; // override recency tiers
  /** Internal: skip link resolution to prevent circular references. Default: true for ID queries. */
  resolveLinks?: boolean;
}

export interface WriteResult {
  id: string;
  timestamp: string;
}

// Prefixes are now loaded from config — see this.cfg.prefixes

const ROLE_LEVEL: Record<AgentRole, number> = {
  worker: 0, al: 1, pl: 2, ceo: 3,
};

// (limits are now instance-level via this.cfg.maxCharsPerLevel)

/** All roles that a given role may see (itself + below). */
function allowedRoles(role: AgentRole): AgentRole[] {
  const level = ROLE_LEVEL[role];
  return (Object.keys(ROLE_LEVEL) as AgentRole[]).filter(r => ROLE_LEVEL[r] <= level);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
    id            TEXT PRIMARY KEY,
    prefix        TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    level_1       TEXT NOT NULL,
    level_2       TEXT,
    level_3       TEXT,
    level_4       TEXT,
    level_5       TEXT,
    access_count  INTEGER DEFAULT 0,
    last_accessed TEXT,
    links         TEXT,
    min_role      TEXT DEFAULT 'worker',
    obsolete      INTEGER DEFAULT 0,
    favorite      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prefix ON memories(prefix);
CREATE INDEX IF NOT EXISTS idx_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_access ON memories(access_count);
CREATE INDEX IF NOT EXISTS idx_role ON memories(min_role);

CREATE TABLE IF NOT EXISTS memory_nodes (
    id            TEXT PRIMARY KEY,
    parent_id     TEXT NOT NULL,
    root_id       TEXT NOT NULL,
    depth         INTEGER NOT NULL,
    seq           INTEGER NOT NULL,
    content       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    access_count  INTEGER DEFAULT 0,
    last_accessed TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON memory_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_root   ON memory_nodes(root_id);

CREATE TABLE IF NOT EXISTS schema_version (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

// Migration: add columns to existing databases that lack them
const MIGRATIONS = [
  "ALTER TABLE memories ADD COLUMN min_role TEXT DEFAULT 'worker'",
  "ALTER TABLE memories ADD COLUMN obsolete INTEGER DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN favorite INTEGER DEFAULT 0",
];

// ---- HmemStore class ----

export class HmemStore {
  private db: Database.Database;
  private readonly dbPath: string;
  private readonly cfg: HmemConfig;
  /** True if integrity_check found errors on open (read-only mode recommended). */
  public readonly corrupted: boolean;

  constructor(hmemPath: string, config?: HmemConfig) {
    this.dbPath = hmemPath;
    this.cfg = config ?? { ...DEFAULT_CONFIG };
    const dir = path.dirname(hmemPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(hmemPath);
    this.db.pragma("journal_mode = WAL");

    // Integrity check — detect corruption before any writes
    this.corrupted = false;
    try {
      const result = this.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
      const status = result[0]?.integrity_check ?? "unknown";
      if (status !== "ok") {
        (this as { corrupted: boolean }).corrupted = true;
        const backupPath = hmemPath + ".corrupt";
        console.error(`[hmem] WARNING: Database corrupted! integrity_check: ${status}`);
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(hmemPath, backupPath);
          console.error(`[hmem] Backup saved to ${backupPath}`);
        }
        console.error(`[hmem] Attempting to continue — reads may be incomplete.`);
      }
    } catch (e) {
      (this as { corrupted: boolean }).corrupted = true;
      console.error(`[hmem] WARNING: integrity_check failed: ${e}`);
    }

    this.db.exec(SCHEMA);
    this.migrate();
    this.migrateToTree();
  }

  /**
   * Write a new memory entry.
   * Content uses tab indentation to define the tree:
   *   "Project X: built a dashboard\n\tMy role was frontend\n\t\tUsed React + Vite"
   * L1 (no tabs) → memories.level_1
   * Each indented line → its own memory_nodes row with compound ID
   * Multiple lines at the same indent depth → siblings (new capability)
   */
  write(prefix: string, content: string, links?: string[], minRole: AgentRole = "worker", favorite?: boolean): WriteResult {
    prefix = prefix.toUpperCase();
    if (!this.cfg.prefixes[prefix]) {
      const valid = Object.entries(this.cfg.prefixes).map(([k, v]) => `${k}=${v}`).join(", ");
      throw new Error(`Invalid prefix "${prefix}". Valid: ${valid}`);
    }

    // Determine root ID first so parseTree can use it directly
    const seq = this.nextSeq(prefix);
    const rootId = `${prefix}${String(seq).padStart(4, "0")}`;
    const timestamp = new Date().toISOString();

    const { level1, nodes } = this.parseTree(content, rootId);

    if (!level1) {
      throw new Error("Content must have at least one line (Level 1).");
    }
    const l1Limit = this.cfg.maxCharsPerLevel[0];
    if (level1.length > l1Limit) {
      throw new Error(`Level 1 exceeds ${l1Limit} character limit (${level1.length} chars). Keep L1 compact.`);
    }
    for (const node of nodes) {
      // depth 2-5 → index 1-4
      const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(node.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
      if (node.content.length > nodeLimit) {
        throw new Error(
          `L${node.depth} content exceeds ${nodeLimit} character limit ` +
          `(${node.content.length} chars). Split into multiple write_memory calls or use file references.`
        );
      }
    }

    const insertRoot = this.db.prepare(`
      INSERT INTO memories (id, prefix, seq, created_at, level_1, level_2, level_3, level_4, level_5, links, min_role, favorite)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
    `);

    const insertNode = this.db.prepare(`
      INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Run in a transaction
    this.db.transaction(() => {
      insertRoot.run(
        rootId, prefix, seq, timestamp,
        level1,
        links ? JSON.stringify(links) : null,
        minRole,
        favorite ? 1 : 0
      );
      for (const node of nodes) {
        insertNode.run(node.id, node.parent_id, rootId, node.depth, node.seq, node.content, timestamp);
      }
    })();

    return { id: rootId, timestamp };
  }

  /**
   * Read memories with flexible querying.
   *
   * For ID-based queries: always returns the node + its DIRECT children.
   * depth parameter is ignored for ID queries (one level at a time).
   *
   * For bulk queries: returns L1 summaries (depth=1 default).
   */
  read(opts: ReadOptions = {}): MemoryEntry[] {
    const limit = opts.limit || this.cfg.defaultReadLimit;
    const roleFilter = this.buildRoleFilter(opts.agentRole);

    // Single entry by ID (root or compound node)
    if (opts.id) {
      const isNode = opts.id.includes(".");

      if (isNode) {
        // Compound node ID — fetch from memory_nodes
        const row = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(opts.id) as any;
        if (!row) return [];
        this.bumpNodeAccess(opts.id);

        const children = this.fetchChildren(opts.id);
        return [this.nodeToEntry(this.rowToNode(row), children)];
      } else {
        // Root ID — fetch from memories
        const sql = `SELECT * FROM memories WHERE id = ?${roleFilter ? ` AND ${roleFilter}` : ""}`;
        const row = this.db.prepare(sql).get(opts.id) as any;
        if (!row) return [];
        this.bumpAccess(opts.id);

        const children = this.fetchChildren(opts.id);
        const entry = this.rowToEntry(row, children);

        // Auto-resolve links (unless suppressed to prevent circular references)
        const shouldResolveLinks = opts.resolveLinks !== false;
        if (shouldResolveLinks && entry.links && entry.links.length > 0) {
          entry.linkedEntries = entry.links.flatMap(linkId => {
            try {
              return this.read({ id: linkId, agentRole: opts.agentRole, resolveLinks: false });
            } catch {
              return [];
            }
          });
        }

        return [entry];
      }
    }

    // Full-text search across memories + memory_nodes
    if (opts.search) {
      const pattern = `%${opts.search}%`;
      // Search in memories level_1
      const searchCondition = "(level_1 LIKE ?)";
      const where = roleFilter ? `WHERE ${searchCondition} AND ${roleFilter}` : `WHERE ${searchCondition}`;

      // Also search memory_nodes content
      const nodeRows = this.db.prepare(
        `SELECT DISTINCT root_id FROM memory_nodes WHERE content LIKE ? LIMIT ?`
      ).all(pattern, limit) as any[];
      const nodeRootIds = new Set(nodeRows.map(r => r.root_id));

      const memRows = this.db.prepare(
        `SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ?`
      ).all(pattern, limit) as any[];

      // Merge: include any roots found in node search too
      const allIds = new Set(memRows.map((r: any) => r.id));
      const extraIds = [...nodeRootIds].filter(id => !allIds.has(id));

      let extraRows: any[] = [];
      if (extraIds.length > 0) {
        const placeholders = extraIds.map(() => "?").join(", ");
        const extraWhere = roleFilter
          ? `WHERE id IN (${placeholders}) AND ${roleFilter}`
          : `WHERE id IN (${placeholders})`;
        extraRows = this.db.prepare(
          `SELECT * FROM memories ${extraWhere} ORDER BY created_at DESC`
        ).all(...extraIds) as any[];
      }

      const allRows = [...memRows, ...extraRows];
      for (const row of allRows) this.bumpAccess(row.id);
      return allRows.map(r => this.rowToEntry(r));
    }

    // Build filtered bulk query (L1 only)
    const conditions: string[] = [];
    const params: any[] = [];

    if (roleFilter) {
      conditions.push(roleFilter);
    }
    if (opts.prefix) {
      conditions.push("prefix = ?");
      params.push(opts.prefix.toUpperCase());
    }
    if (opts.after) {
      conditions.push("created_at >= ?");
      params.push(opts.after);
    }
    if (opts.before) {
      conditions.push("created_at <= ?");
      params.push(opts.before);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Sort by effective_date: the most recent of root created_at OR latest child node created_at.
    // This ensures entries with recently appended L2 nodes surface alongside genuinely new entries.
    const rows = this.db.prepare(`
      SELECT m.*,
        COALESCE(
          (SELECT MAX(n.created_at) FROM memory_nodes n WHERE n.root_id = m.id),
          m.created_at
        ) AS effective_date
      FROM memories m
      ${where}
      ORDER BY effective_date DESC
      LIMIT ?
    `).all(...params, limit) as any[];

    if (opts.prefix || opts.after || opts.before) {
      for (const row of rows) this.bumpAccess(row.id);
    }

    // Recency gradient: inline children up to the tier-resolved depth for recent entries
    // Favorites (F) and top-accessed entries are always pinned at depth 2 minimum
    const tiers: DepthTier[] = opts.recentDepthTiers ?? this.cfg.recentDepthTiers;

    // Identify top-N entries by access_count ("organic favorites")
    const topN = this.cfg.accessCountTopN ?? 5;
    const topAccessIds = topN > 0
      ? new Set(
          [...rows]
            .filter(r => r.access_count > 0)
            .sort((a, b) => b.access_count - a.access_count)
            .slice(0, topN)
            .map(r => r.id)
        )
      : new Set<string>();

    return rows.map((r, i) => {
      let depth = resolveDepthForPosition(i, tiers);
      let promoted: "access" | "favorite" | undefined;
      if (r.favorite === 1) {
        promoted = "favorite";
        if (depth < 2) depth = 2;
      } else if (topAccessIds.has(r.id)) {
        promoted = "access";
        if (depth < 2) depth = 2;
      }

      let children: MemoryNode[] | undefined;
      let hiddenChildrenCount: number | undefined;

      if (depth >= 2) {
        const latest = this.fetchLatestChild(r.id, depth);
        if (latest) {
          children = [latest.node];
          hiddenChildrenCount = latest.totalSiblings - 1;
        } else {
          hiddenChildrenCount = 0;
        }
      }

      const entry = this.rowToEntry(r, children);
      entry.promoted = promoted;
      entry.hiddenChildrenCount = hiddenChildrenCount;
      return entry;
    });
  }

  /**
   * Get all Level 1 entries for injection at agent startup.
   * Does NOT bump access_count (routine injection).
   */
  getLevel1All(agentRole?: AgentRole): string {
    const roleFilter = this.buildRoleFilter(agentRole);
    const where = roleFilter ? `WHERE ${roleFilter}` : "";
    const rows = this.db.prepare(
      `SELECT id, created_at, level_1 FROM memories ${where} ORDER BY created_at DESC`
    ).all() as any[];

    if (rows.length === 0) return "";

    return rows.map(r => {
      const date = r.created_at.substring(0, 10);
      return `[${r.id}] ${date} — ${r.level_1}`;
    }).join("\n");
  }

  /**
   * Export entire memory to Markdown for git tracking.
   */
  exportMarkdown(): string {
    const rows = this.db.prepare(
      "SELECT * FROM memories ORDER BY prefix, seq"
    ).all() as any[];

    if (rows.length === 0) return "# Memory Export\n\n(empty)\n";

    let md = "# Memory Export\n\n";
    md += `> Auto-generated from .hmem — ${new Date().toISOString()}\n`;
    md += `> ${rows.length} entries\n\n`;

    let currentPrefix = "";

    for (const row of rows) {
      if (row.prefix !== currentPrefix) {
        currentPrefix = row.prefix;
        md += `---\n\n## ${this.cfg.prefixes[currentPrefix] || currentPrefix}\n\n`;
      }

      const date = row.created_at.substring(0, 10);
      const accessed = row.access_count > 0 ? ` (accessed ${row.access_count}x)` : "";
      const role = row.min_role !== "worker" ? ` [${row.min_role}+]` : "";
      md += `### [${row.id}] ${date}${role}${accessed}\n`;
      md += `${row.level_1}\n`;

      // Include tree nodes
      const nodes = this.db.prepare(
        "SELECT * FROM memory_nodes WHERE root_id = ? ORDER BY depth, seq"
      ).all(row.id) as any[];
      for (const n of nodes) {
        const indent = "  ".repeat(n.depth - 1);
        md += `${indent}→ [${n.id}] ${n.content}\n`;
      }

      if (row.links) {
        const links = JSON.parse(row.links) as string[];
        if (links.length > 0) md += `  Links: ${links.join(", ")}\n`;
      }
      md += "\n";
    }

    return md;
  }

  /**
   * Get statistics about the memory store.
   */
  stats(): { total: number; byPrefix: Record<string, number> } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM memories").get() as any).c;
    const rows = this.db.prepare(
      "SELECT prefix, COUNT(*) as c FROM memories GROUP BY prefix"
    ).all() as any[];

    const byPrefix: Record<string, number> = {};
    for (const r of rows) byPrefix[r.prefix] = r.c;
    return { total, byPrefix };
  }

  /**
   * Update specific fields of an existing root entry (curator use only).
   */
  update(id: string, fields: Partial<Pick<MemoryEntry, "level_1" | "level_2" | "level_3" | "level_4" | "level_5" | "links" | "min_role" | "obsolete" | "favorite">>): boolean {
    const sets: string[] = [];
    const params: any[] = [];

    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      if (key === "links" && Array.isArray(val)) {
        params.push(JSON.stringify(val));
      } else if (key === "obsolete" || key === "favorite") {
        params.push(val ? 1 : 0);
      } else {
        params.push(val);
      }
    }
    if (sets.length === 0) return false;

    params.push(id);
    const result = this.db.prepare(
      `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`
    ).run(...params);
    return result.changes > 0;
  }

  /**
   * Delete an entry by ID (curator use only).
   * Also deletes all associated memory_nodes.
   */
  delete(id: string): boolean {
    // Delete nodes first (no CASCADE in older SQLite)
    this.db.prepare("DELETE FROM memory_nodes WHERE root_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * Update the text content of an existing root entry or sub-node.
   * For root entries: updates level_1, optionally updates links.
   * For sub-nodes: updates node content only.
   * Does NOT modify children — use appendChildren to extend the tree.
   */
  updateNode(id: string, newContent: string, links?: string[], obsolete?: boolean, favorite?: boolean): boolean {
    const trimmed = newContent.trim();
    if (id.includes(".")) {
      // Sub-node in memory_nodes — check char limit for its depth
      const nodeRow = this.db.prepare("SELECT depth FROM memory_nodes WHERE id = ?").get(id) as any;
      if (!nodeRow) return false;
      const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(nodeRow.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
      if (trimmed.length > nodeLimit) {
        throw new Error(`Content exceeds ${nodeLimit} character limit (${trimmed.length} chars) for L${nodeRow.depth}.`);
      }
      const result = this.db.prepare("UPDATE memory_nodes SET content = ? WHERE id = ?").run(trimmed, id);
      return result.changes > 0;
    } else {
      // Root entry in memories — check L1 char limit
      const l1Limit = this.cfg.maxCharsPerLevel[0];
      if (trimmed.length > l1Limit) {
        throw new Error(`Level 1 exceeds ${l1Limit} character limit (${trimmed.length} chars). Keep L1 compact.`);
      }
      const sets: string[] = ["level_1 = ?"];
      const params: any[] = [trimmed];
      if (links !== undefined) {
        sets.push("links = ?");
        params.push(links.length > 0 ? JSON.stringify(links) : null);
      }
      if (obsolete !== undefined) {
        sets.push("obsolete = ?");
        params.push(obsolete ? 1 : 0);
      }
      if (favorite !== undefined) {
        sets.push("favorite = ?");
        params.push(favorite ? 1 : 0);
      }
      params.push(id);
      const result = this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      return result.changes > 0;
    }
  }

  /**
   * Append new child nodes under an existing entry (root or node).
   * Content is tab-indented relative to the parent:
   *   0 tabs = direct child of parentId (L_parent+1)
   *   1 tab  = grandchild (L_parent+2), etc.
   * Existing children are preserved; new nodes are added after them.
   * Returns the IDs of newly created top-level children.
   */
  appendChildren(parentId: string, content: string): { count: number; ids: string[] } {
    const parentIsRoot = !parentId.includes(".");

    // Verify parent exists
    if (parentIsRoot) {
      if (!this.db.prepare("SELECT id FROM memories WHERE id = ?").get(parentId)) {
        throw new Error(`Root entry "${parentId}" not found.`);
      }
    } else {
      if (!this.db.prepare("SELECT id FROM memory_nodes WHERE id = ?").get(parentId)) {
        throw new Error(`Node "${parentId}" not found.`);
      }
    }

    const parentDepth = parentIsRoot ? 1 : (parentId.match(/\./g)!.length + 1);
    const rootId = parentIsRoot ? parentId : parentId.split(".")[0];

    // Find next available seq for direct children of parent
    const maxSeqRow = this.db.prepare(
      "SELECT MAX(seq) as maxSeq FROM memory_nodes WHERE parent_id = ?"
    ).get(parentId) as any;
    const startSeq = (maxSeqRow?.maxSeq ?? 0) + 1;

    const nodes = this.parseRelativeTree(content, parentId, parentDepth, startSeq);
    if (nodes.length === 0) return { count: 0, ids: [] };

    // Validate char limits before writing
    for (const node of nodes) {
      const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(node.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
      if (node.content.length > nodeLimit) {
        throw new Error(
          `L${node.depth} content exceeds ${nodeLimit} character limit ` +
          `(${node.content.length} chars). Split into multiple calls or use file references.`
        );
      }
    }

    const timestamp = new Date().toISOString();
    const insertNode = this.db.prepare(`
      INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const topLevelIds: string[] = [];

    this.db.transaction(() => {
      for (const node of nodes) {
        insertNode.run(node.id, node.parent_id, rootId, node.depth, node.seq, node.content, timestamp);
        if (node.parent_id === parentId) topLevelIds.push(node.id);
      }
    })();

    return { count: nodes.length, ids: topLevelIds };
  }

  close(): void {
    this.db.close();
  }

  // ---- Private helpers ----

  private migrate(): void {
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists — ignore
      }
    }
  }

  /**
   * One-time migration: move level_2..level_5 data to memory_nodes tree.
   * Idempotent — tracked via schema_version table.
   */
  private migrateToTree(): void {
    const done = this.db.prepare(
      "SELECT value FROM schema_version WHERE key = 'tree_v1'"
    ).get();
    if (done) return;

    this.db.transaction(() => {
      const insertNode = this.db.prepare(`
        INSERT OR IGNORE INTO memory_nodes (id, parent_id, root_id, depth, seq, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      // Fetch all rows with at least level_2
      const rows = this.db.prepare(
        "SELECT id, created_at, level_2, level_3, level_4, level_5 FROM memories WHERE level_2 IS NOT NULL"
      ).all() as any[];

      for (const row of rows) {
        const rootId = row.id;
        const ts = row.created_at;

        if (row.level_2) {
          insertNode.run(rootId + ".1", rootId, rootId, 2, 1, row.level_2, ts);
          if (row.level_3) {
            insertNode.run(rootId + ".1.1", rootId + ".1", rootId, 3, 1, row.level_3, ts);
            if (row.level_4) {
              insertNode.run(rootId + ".1.1.1", rootId + ".1.1", rootId, 4, 1, row.level_4, ts);
              if (row.level_5) {
                insertNode.run(rootId + ".1.1.1.1", rootId + ".1.1.1", rootId, 5, 1, row.level_5, ts);
              }
            }
          }
        }
      }

      // Null out legacy columns
      this.db.prepare(
        "UPDATE memories SET level_2=NULL, level_3=NULL, level_4=NULL, level_5=NULL"
      ).run();

      // Mark done
      this.db.prepare(
        "INSERT INTO schema_version (key, value) VALUES ('tree_v1', 'done')"
      ).run();
    })();
  }

  private buildRoleFilter(agentRole?: AgentRole): string {
    if (!agentRole) return "";
    const roles = allowedRoles(agentRole);
    const placeholders = roles.map(r => `'${r}'`).join(", ");
    return `min_role IN (${placeholders})`;
  }

  private nextSeq(prefix: string): number {
    const row = this.db.prepare(
      "SELECT MAX(seq) as maxSeq FROM memories WHERE prefix = ?"
    ).get(prefix) as any;
    return (row?.maxSeq || 0) + 1;
  }

  private bumpAccess(id: string): void {
    this.db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?"
    ).run(new Date().toISOString(), id);
  }

  private bumpNodeAccess(id: string): void {
    this.db.prepare(
      "UPDATE memory_nodes SET access_count = access_count + 1, last_accessed = ? WHERE id = ?"
    ).run(new Date().toISOString(), id);
  }

  /** Fetch direct children of a node (root or compound), including their grandchild counts. */
  private fetchChildren(parentId: string): MemoryNode[] {
    return this.fetchChildrenDeep(parentId, 2, 2);
  }

  /**
   * Fetch only the single most recently created direct child of a parent,
   * along with the total sibling count. Used for token-efficient bulk reads.
   * Returns null if no children exist.
   */
  private fetchLatestChild(parentId: string, maxDepth: number):
    { node: MemoryNode; totalSiblings: number } | null {
    const rows = this.db.prepare(
      "SELECT * FROM memory_nodes WHERE parent_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1"
    ).all(parentId) as any[];
    if (rows.length === 0) return null;

    const totalRow = this.db.prepare(
      "SELECT COUNT(*) as c FROM memory_nodes WHERE parent_id = ?"
    ).get(parentId) as any;

    const grandchildCount = (this.db.prepare(
      "SELECT COUNT(*) as c FROM memory_nodes WHERE parent_id = ?"
    ).get(rows[0].id) as any).c;

    const node = this.rowToNode(rows[0], grandchildCount);
    if (maxDepth >= 3 && grandchildCount > 0) {
      node.children = this.fetchChildrenDeep(rows[0].id, 3, maxDepth);
    }

    return { node, totalSiblings: totalRow.c };
  }

  /**
   * Fetch children recursively up to maxDepth.
   * currentDepth: the depth level of the children being fetched (2 = L2, 3 = L3, …)
   * maxDepth: stop recursing when currentDepth > maxDepth
   */
  private fetchChildrenDeep(parentId: string, currentDepth: number, maxDepth: number): MemoryNode[] {
    const rows = this.db.prepare(
      "SELECT * FROM memory_nodes WHERE parent_id = ? ORDER BY seq"
    ).all(parentId) as any[];

    return rows.map(r => {
      const childCount = (this.db.prepare(
        "SELECT COUNT(*) as c FROM memory_nodes WHERE parent_id = ?"
      ).get(r.id) as any).c;
      const node = this.rowToNode(r, childCount);
      if (currentDepth < maxDepth && childCount > 0) {
        node.children = this.fetchChildrenDeep(r.id, currentDepth + 1, maxDepth);
      }
      return node;
    });
  }

  private rowToNode(row: any, childCount?: number): MemoryNode {
    return {
      id: row.id,
      parent_id: row.parent_id,
      root_id: row.root_id,
      depth: row.depth,
      seq: row.seq,
      content: row.content,
      created_at: row.created_at,
      access_count: row.access_count || 0,
      last_accessed: row.last_accessed || null,
      child_count: childCount,
    };
  }

  private rowToEntry(row: any, children?: MemoryNode[]): MemoryEntry {
    return {
      id: row.id,
      prefix: row.prefix,
      seq: row.seq,
      created_at: row.created_at,
      level_1: row.level_1,
      level_2: null,  // always null post-migration
      level_3: null,
      level_4: null,
      level_5: null,
      access_count: row.access_count,
      last_accessed: row.last_accessed,
      links: row.links ? JSON.parse(row.links) : null,
      min_role: row.min_role || "worker",
      obsolete: row.obsolete === 1,
      favorite: row.favorite === 1,
      children,
    };
  }

  /**
   * Wrap a MemoryNode as a MemoryEntry for uniform API return.
   * The formatter detects node entries by checking e.id.includes(".").
   * level_1 is repurposed to carry the node content.
   */
  private nodeToEntry(node: MemoryNode, children: MemoryNode[]): MemoryEntry {
    return {
      id: node.id,
      prefix: node.root_id.match(/^([A-Z]+)/)?.[1] ?? "?",
      seq: node.seq,
      created_at: node.created_at,
      level_1: node.content,
      level_2: null,
      level_3: null,
      level_4: null,
      level_5: null,
      access_count: node.access_count,
      last_accessed: node.last_accessed,
      links: null,
      min_role: "worker",
      children,
    };
  }

  /**
   * Parse tab-indented content into L1 text + a list of tree nodes.
   *
   * Algorithm:
   *   - seqAtParent: Map<parentId, number> — sibling counter per parent
   *   - lastIdAtDepth: Map<depth, nodeId>  — last-written node id at each depth
   *
   * Each indented line at depth D:
   *   parent = (D == 2) ? rootId : lastIdAtDepth[D-1]
   *   seq    = ++seqAtParent[parent]
   *   id     = parent + "." + seq
   *
   * @param content  Tab-indented content string
   * @param rootId   The root entry ID (e.g. "E0006") — used to build compound IDs
   */
  private parseTree(content: string, rootId: string): {
    level1: string;
    nodes: Array<{ id: string; parent_id: string; depth: number; seq: number; content: string }>;
  } {
    const seqAtParent = new Map<string, number>();
    const lastIdAtDepth = new Map<number, string>();
    const nodes: Array<{ id: string; parent_id: string; depth: number; seq: number; content: string }> = [];

    let level1 = "";

    // Auto-detect space indentation unit: use first indented line (if no tabs present)
    const rawLines = content.split("\n").map(l => l.trimEnd()).filter(Boolean);
    let spaceUnit = 4;
    if (!rawLines.some(l => l.startsWith("\t"))) {
      for (const l of rawLines) {
        const leading = l.length - l.trimStart().length;
        if (leading > 0) { spaceUnit = leading; break; }
      }
    }

    for (const line of rawLines) {
      const trimmedEnd = line;
      if (!trimmedEnd) continue;

      // Count leading tabs; fall back to auto-detected space unit
      const tabMatch = trimmedEnd.match(/^\t*/);
      const leadingTabs = tabMatch ? tabMatch[0].length : 0;
      let depth: number;
      if (leadingTabs > 0) {
        depth = Math.min(leadingTabs, 4) + 1; // 1 tab = L2, 2 tabs = L3, etc.
      } else {
        const leadingSpaces = trimmedEnd.length - trimmedEnd.trimStart().length;
        const spaceTabs = Math.floor(leadingSpaces / spaceUnit);
        depth = spaceTabs > 0 ? Math.min(spaceTabs, 4) + 1 : 1;
      }

      const text = trimmedEnd.trim();

      if (depth === 1) {
        // L1 — multiple L1 lines joined (should be rare)
        level1 = level1 ? level1 + " | " + text : text;
        continue;
      }

      // L2+: determine parent and generate compound ID
      const parentId = depth === 2 ? rootId : (lastIdAtDepth.get(depth - 1) ?? rootId);
      const seq = (seqAtParent.get(parentId) ?? 0) + 1;
      seqAtParent.set(parentId, seq);
      const nodeId = `${parentId}.${seq}`;
      lastIdAtDepth.set(depth, nodeId);

      nodes.push({ id: nodeId, parent_id: parentId, depth, seq, content: text });
    }

    return { level1, nodes };
  }

  /**
   * Parse tab-indented content relative to a parent node.
   * relDepth 0 = direct child of parent (absDepth = parentDepth + 1).
   * startSeq: the first seq number to assign to direct children (continuing after existing siblings).
   */
  private parseRelativeTree(
    content: string,
    parentId: string,
    parentDepth: number,
    startSeq: number
  ): Array<{ id: string; parent_id: string; depth: number; seq: number; content: string }> {
    const seqAtParent = new Map<string, number>();
    // Pre-seed parent so first direct child gets startSeq
    seqAtParent.set(parentId, startSeq - 1);
    const lastIdAtRelDepth = new Map<number, string>();
    const nodes: Array<{ id: string; parent_id: string; depth: number; seq: number; content: string }> = [];

    const rawLines = content.split("\n").map(l => l.trimEnd()).filter(Boolean);
    // Auto-detect space unit if no tabs used
    let spaceUnit = 4;
    if (!rawLines.some(l => l.startsWith("\t"))) {
      for (const l of rawLines) {
        const leading = l.length - l.trimStart().length;
        if (leading > 0) { spaceUnit = leading; break; }
      }
    }

    const maxAbsDepth = this.cfg.maxDepth;

    for (const line of rawLines) {
      const text = line.trim();
      if (!text) continue;

      // Count leading tabs; fall back to space-based detection
      const tabMatch = line.match(/^\t*/);
      const leadingTabs = tabMatch ? tabMatch[0].length : 0;
      let relDepth: number;
      if (leadingTabs > 0) {
        relDepth = leadingTabs;
      } else {
        const leading = line.length - line.trimStart().length;
        relDepth = leading > 0 ? Math.floor(leading / spaceUnit) : 0;
      }

      const absDepth = parentDepth + 1 + relDepth;
      if (absDepth > maxAbsDepth) continue; // silently skip beyond max depth

      const myParentId = relDepth === 0
        ? parentId
        : (lastIdAtRelDepth.get(relDepth - 1) ?? parentId);

      const seq = (seqAtParent.get(myParentId) ?? 0) + 1;
      seqAtParent.set(myParentId, seq);
      const nodeId = `${myParentId}.${seq}`;
      lastIdAtRelDepth.set(relDepth, nodeId);

      nodes.push({ id: nodeId, parent_id: myParentId, depth: absDepth, seq, content: text });
    }

    return nodes;
  }
}

// ---- Convenience: resolve .hmem path for an agent ----

export function resolveHmemPath(projectDir: string, templateName: string): string {
  // No agent name configured → use memory.hmem directly in project root
  if (!templateName || templateName === "UNKNOWN") {
    return path.join(projectDir, "memory.hmem");
  }
  // Named agent → Agents/NAME/NAME.hmem (check Assistenten/ as fallback)
  let agentDir = path.join(projectDir, "Agents", templateName);
  if (!fs.existsSync(agentDir)) {
    const alt = path.join(projectDir, "Assistenten", templateName);
    if (fs.existsSync(alt)) agentDir = alt;
  }
  return path.join(agentDir, `${templateName}.hmem`);
}

/**
 * Open (or create) an HmemStore for an agent's personal memory.
 */
export function openAgentMemory(projectDir: string, templateName: string, config?: HmemConfig): HmemStore {
  const hmemPath = resolveHmemPath(projectDir, templateName);
  return new HmemStore(hmemPath, config);
}

/**
 * Open (or create) the shared company knowledge store (FIRMENWISSEN.hmem).
 */
export function openCompanyMemory(projectDir: string, config?: HmemConfig): HmemStore {
  const hmemPath = path.join(projectDir, "FIRMENWISSEN.hmem");
  return new HmemStore(hmemPath, config);
}

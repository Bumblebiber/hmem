/**
 * Hierarchical Memory Store (.hmem)
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
 * Prefixes: P=Project, L=Lesson, T=Task, E=Error, D=Decision, M=Milestone, F=Favorite, S=Skill
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
  children?: MemoryNode[];  // populated for ID-based reads
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
  child_count?: number; // populated when fetching children
}

export interface ReadOptions {
  id?: string;
  depth?: number;       // ignored for ID queries; 1-5 for bulk (default 1)
  prefix?: string;      // "P", "L", "T", "E", "D", "M", "S"
  after?: string;       // ISO date
  before?: string;      // ISO date
  search?: string;      // full-text search across all levels
  limit?: number;       // max results, default 100
  agentRole?: AgentRole; // filter by role clearance (company store)
}

export interface WriteResult {
  id: string;
  timestamp: string;
}

const VALID_PREFIXES = new Set(["P", "L", "T", "E", "D", "M", "F", "S"]);

const ROLE_LEVEL: Record<AgentRole, number> = {
  worker: 0, al: 1, pl: 2, ceo: 3,
};

const MAX_NODE_CONTENT = 50_000;  // characters — hard cap for L2-L5
const MAX_L1_CONTENT   = 500;     // characters — L1 must stay compact

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
    min_role      TEXT DEFAULT 'worker'
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

// Migration: add min_role to existing databases that lack it
const MIGRATIONS = [
  "ALTER TABLE memories ADD COLUMN min_role TEXT DEFAULT 'worker'",
];

// ---- HmemStore class ----

export class HmemStore {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(hmemPath: string) {
    this.dbPath = hmemPath;
    const dir = path.dirname(hmemPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(hmemPath);
    this.db.pragma("journal_mode = WAL");
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
  write(prefix: string, content: string, links?: string[], minRole: AgentRole = "worker"): WriteResult {
    prefix = prefix.toUpperCase();
    if (!VALID_PREFIXES.has(prefix)) {
      throw new Error(`Invalid prefix "${prefix}". Valid: ${[...VALID_PREFIXES].join(", ")}`);
    }

    // Determine root ID first so parseTree can use it directly
    const seq = this.nextSeq(prefix);
    const rootId = `${prefix}${String(seq).padStart(4, "0")}`;
    const timestamp = new Date().toISOString();

    const { level1, nodes } = this.parseTree(content, rootId);

    if (!level1) {
      throw new Error("Content must have at least one line (Level 1).");
    }
    if (level1.length > MAX_L1_CONTENT) {
      throw new Error(`Level 1 exceeds ${MAX_L1_CONTENT} character limit (${level1.length} chars). Keep L1 compact.`);
    }
    for (const node of nodes) {
      if (node.content.length > MAX_NODE_CONTENT) {
        throw new Error(
          `Node content at depth ${node.depth} exceeds ${MAX_NODE_CONTENT} character limit ` +
          `(${node.content.length} chars). Split into multiple write_memory calls or use file references.`
        );
      }
    }

    const insertRoot = this.db.prepare(`
      INSERT INTO memories (id, prefix, seq, created_at, level_1, level_2, level_3, level_4, level_5, links, min_role)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
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
        minRole
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
    const limit = opts.limit || 100;
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
        return [this.rowToEntry(row, children)];
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
    const rows = this.db.prepare(
      `SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...params, limit) as any[];

    if (opts.prefix || opts.after || opts.before) {
      for (const row of rows) this.bumpAccess(row.id);
    }

    return rows.map(r => this.rowToEntry(r));
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
    const prefixNames: Record<string, string> = {
      P: "Projects", L: "Lessons Learned", T: "Tasks",
      E: "Errors", D: "Decisions", M: "Milestones", F: "Favorites", S: "Skills",
    };

    for (const row of rows) {
      if (row.prefix !== currentPrefix) {
        currentPrefix = row.prefix;
        md += `---\n\n## ${prefixNames[currentPrefix] || currentPrefix}\n\n`;
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
  update(id: string, fields: Partial<Pick<MemoryEntry, "level_1" | "level_2" | "level_3" | "level_4" | "level_5" | "links" | "min_role">>): boolean {
    const sets: string[] = [];
    const params: any[] = [];

    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      params.push(key === "links" && Array.isArray(val) ? JSON.stringify(val) : val);
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
    const rows = this.db.prepare(
      "SELECT * FROM memory_nodes WHERE parent_id = ? ORDER BY seq"
    ).all(parentId) as any[];

    return rows.map(r => {
      const childCount = (this.db.prepare(
        "SELECT COUNT(*) as c FROM memory_nodes WHERE parent_id = ?"
      ).get(r.id) as any).c;
      return this.rowToNode(r, childCount);
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
export function openAgentMemory(projectDir: string, templateName: string): HmemStore {
  const hmemPath = resolveHmemPath(projectDir, templateName);
  return new HmemStore(hmemPath);
}

/**
 * Open (or create) the shared company knowledge store (FIRMENWISSEN.hmem).
 */
export function openCompanyMemory(projectDir: string): HmemStore {
  const hmemPath = path.join(projectDir, "FIRMENWISSEN.hmem");
  return new HmemStore(hmemPath);
}

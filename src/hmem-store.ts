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
 *   - Company:  shared knowledge base (company.hmem) with role-based access
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
import type { HmemConfig } from "./hmem-config.js";
import { DEFAULT_CONFIG, DEFAULT_PREFIX_DESCRIPTIONS } from "./hmem-config.js";

// ---- Types ----

export type AgentRole = "worker" | "al" | "pl" | "ceo";

export interface MemoryEntry {
  id: string;
  prefix: string;
  seq: number;
  created_at: string;
  /** Short label for navigation (~30 chars). Auto-extracted if not explicit. */
  title: string;
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
  /** True if the agent marked this entry as irrelevant. Hidden from bulk reads, no correction needed. */
  irrelevant?: boolean;
  /** True if this entry was already delivered in a previous bulk read (session cache). */
  suppressed?: boolean;
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
  /** True if all L2 children are shown + links resolved (V2 expanded entry). */
  expanded?: boolean;
  /** True if this entry is a category header (seq===0, e.g. P0000). */
  isHeader?: boolean;
  children?: MemoryNode[];       // populated for ID-based reads and bulk reads (latest child)
  linkedEntries?: MemoryEntry[]; // auto-resolved linked entries (ID-based reads only)
  /** Number of linked entries hidden because they are obsolete. */
  hiddenObsoleteLinks?: number;
  /** Number of linked entries hidden because they are irrelevant. */
  hiddenIrrelevantLinks?: number;
  /** If this entry was reached via obsolete chain resolution, the chain of IDs traversed. */
  obsoleteChain?: string[];
  /** Optional hashtags for cross-cutting search, e.g. ["#hmem", "#curation"]. */
  tags?: string[];
  /** Entries sharing 2+ tags with this entry (populated on ID-based reads). */
  relatedEntries?: { id: string; title: string; created_at: string; tags: string[] }[];
  /** True if the entry is pinned (super-favorite). Pinned entries show full L2 content in bulk reads. */
  pinned?: boolean;
}

export interface MemoryNode {
  id: string;           // E0006.1, E0006.1.2
  parent_id: string;    // E0006 or E0006.1
  root_id: string;      // always the root memories.id
  depth: number;        // 2-5
  seq: number;          // sibling order (1-based)
  /** Short label for navigation (~30 chars). Auto-extracted from content. */
  title: string;
  content: string;
  created_at: string;
  access_count: number;
  last_accessed: string | null;
  favorite?: boolean;       // true if marked as a favorite
  irrelevant?: boolean;     // true if marked as irrelevant (hidden from output)
  child_count?: number;     // populated when fetching children
  children?: MemoryNode[];  // populated when fetching with depth > 1
  /** Optional hashtags, e.g. ["#hmem", "#curation"]. */
  tags?: string[];
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
  /** Internal: skip link resolution to prevent circular references. Default: true for ID queries. */
  resolveLinks?: boolean;
  /** How many levels of link resolution (default 1). 0 = none. Linked entries decrement this. */
  linkDepth?: number;
  /** Internal: visited entry IDs for cycle detection during link resolution. */
  _visitedLinks?: Set<string>;
  /** Include all obsolete entries in bulk reads (default: only top N most-accessed). */
  showObsolete?: boolean;
  /** Time filter: "HH:MM" — filter entries by time of day. */
  time?: string;
  /** Time window: "+2h", "-1h", "both" — direction and size around the time/date. */
  period?: string;
  /** Reference entry ID — find entries created around the same time as this entry. */
  timeAround?: string;
  /** Internal: bypass obsolete enforcement for curator tools. */
  _curatorBypass?: boolean;
  /** Follow obsolete chains to their correction. Default: true for ID queries. */
  followObsolete?: boolean;
  /** Show the full obsolete chain path (all intermediate entries). Default: false. */
  showObsoletePath?: boolean;
  /** Return only titles — compact listing without V2 selection, children, or links. */
  titlesOnly?: boolean;
  /** Expand full tree with complete node content (for deep-dive into a project). depth controls how deep. */
  expand?: boolean;
  /** IDs already delivered in this session — shown as title-only in subsequent bulk reads. */
  cachedIds?: Set<string>;
  /** IDs within hidden phase (< 5 min) — completely excluded from output. */
  hiddenIds?: Set<string>;
  /** Slot reduction fraction: 1.0 = full, 0.5 = half percentage, 0.25 = quarter, ... */
  slotFraction?: number;
  /** Bulk read mode: 'discover' (newest-heavy, default) or 'essentials' (importance-heavy). */
  mode?: "discover" | "essentials";
  /** Curation mode: show ALL entries (bypass V2 selection + session cache), depth 3 children, no child V2. */
  showAll?: boolean;
  /** Filter by tag, e.g. "#hmem". Only entries/nodes with this tag are included. */
  tag?: string;
}

export interface WriteResult {
  id: string;
  timestamp: string;
}

export interface ImportResult {
  inserted: number;
  merged: number;
  nodesInserted: number;
  nodesSkipped: number;
  tagsImported: number;
  remapped: boolean;
  conflicts: number;
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
    favorite      INTEGER DEFAULT 0,
    irrelevant    INTEGER DEFAULT 0
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
  "ALTER TABLE memories ADD COLUMN title TEXT",
  "ALTER TABLE memory_nodes ADD COLUMN title TEXT",
  "ALTER TABLE memories ADD COLUMN irrelevant INTEGER DEFAULT 0",
  "ALTER TABLE memory_nodes ADD COLUMN favorite INTEGER DEFAULT 0",
  "ALTER TABLE memory_nodes ADD COLUMN irrelevant INTEGER DEFAULT 0",
  // Hashtag support: join table for cross-cutting tags on entries and nodes
  "CREATE TABLE IF NOT EXISTS memory_tags (entry_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (entry_id, tag))",
  "CREATE INDEX IF NOT EXISTS idx_tags_tag ON memory_tags(tag)",
  // Pinned: super-favorites that show full L2 content in bulk reads
  "ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0",
];

// ---- HmemStore class ----

export class HmemStore {
  private db: Database.Database;
  private readonly dbPath: string;
  getDbPath(): string { return this.dbPath; }
  private readonly cfg: HmemConfig;
  /** True if integrity_check found errors on open (read-only mode recommended). */
  public readonly corrupted: boolean;

  /**
   * Char-limit tolerance: configured limits are the "recommended" target shown in skills/errors.
   * Actual hard reject is at limit * CHAR_LIMIT_TOLERANCE (25% buffer to avoid wasted retries).
   */
  private static readonly CHAR_LIMIT_TOLERANCE = 1.25;

  constructor(hmemPath: string, config?: HmemConfig) {
    this.dbPath = hmemPath;
    this.cfg = config ?? { ...DEFAULT_CONFIG };
    const dir = path.dirname(hmemPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(hmemPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

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
    this.migrateHeaders();
    this.migrateObsoleteAccessCount();
  }

  /** Throw if the database is corrupted — prevents silent data loss on write operations. */
  private guardCorrupted(): void {
    if (this.corrupted) {
      throw new Error("[hmem] Database is corrupted — write operations disabled. See .corrupt backup.");
    }
  }

  /**
   * Write a new memory entry.
   * Content uses tab indentation to define the tree:
   *   "Project X: built a dashboard\n\tMy role was frontend\n\t\tUsed React + Vite"
   * L1 (no tabs) → memories.level_1
   * Each indented line → its own memory_nodes row with compound ID
   * Multiple lines at the same indent depth → siblings (new capability)
   */
  write(prefix: string, content: string, links?: string[], minRole: AgentRole = "worker", favorite?: boolean, tags?: string[], pinned?: boolean): WriteResult {
    this.guardCorrupted();
    prefix = prefix.toUpperCase();
    if (!this.cfg.prefixes[prefix]) {
      const valid = Object.entries(this.cfg.prefixes).map(([k, v]) => `${k}=${v}`).join(", ");
      throw new Error(`Invalid prefix "${prefix}". Valid: ${valid}`);
    }

    // Determine root ID first so parseTree can use it directly
    const seq = this.nextSeq(prefix);
    const rootId = `${prefix}${String(seq).padStart(4, "0")}`;
    const timestamp = new Date().toISOString();

    const { title, level1, nodes } = this.parseTree(content, rootId);

    if (!level1) {
      throw new Error("Content must have at least one line (Level 1).");
    }
    const l1Limit = this.cfg.maxCharsPerLevel[0];
    const t = HmemStore.CHAR_LIMIT_TOLERANCE;
    if (level1.length > l1Limit * t) {
      throw new Error(`Level 1 exceeds ${l1Limit} character limit (${level1.length} chars). Keep L1 compact.`);
    }
    for (const node of nodes) {
      // depth 2-5 → index 1-4
      const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(node.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
      if (node.content.length > nodeLimit * t) {
        throw new Error(
          `L${node.depth} content exceeds ${nodeLimit} character limit ` +
          `(${node.content.length} chars). Split into multiple write_memory calls or use file references.`
        );
      }
    }

    const insertRoot = this.db.prepare(`
      INSERT INTO memories (id, prefix, seq, created_at, title, level_1, level_2, level_3, level_4, level_5, links, min_role, favorite, pinned)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
    `);

    const insertNode = this.db.prepare(`
      INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Validate tags before transaction
    const validatedTags = tags && tags.length > 0 ? this.validateTags(tags) : [];

    // Run in a transaction
    this.db.transaction(() => {
      insertRoot.run(
        rootId, prefix, seq, timestamp,
        title, level1,
        links ? JSON.stringify(links) : null,
        minRole,
        favorite ? 1 : 0,
        pinned ? 1 : 0
      );
      for (const node of nodes) {
        insertNode.run(node.id, node.parent_id, rootId, node.depth, node.seq, node.title, node.content, timestamp);
      }
      if (validatedTags.length > 0) {
        this.setTags(rootId, validatedTags);
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
    const limit = opts.limit; // undefined = no limit (all entries)
    const roleFilter = this.buildRoleFilter(opts.agentRole);

    // Single entry by ID (root or compound node)
    if (opts.id) {
      const isNode = opts.id.includes(".");

      if (isNode) {
        // Compound node ID — fetch from memory_nodes
        const row = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(opts.id) as any;
        if (!row) return [];
        this.bumpNodeAccess(opts.id);

        const nodeDepth = (row as any).depth ?? 2;
        // expand: fetch requested depth + 1 extra level (for boundary titles)
        const expandDepth = opts.expand ? (opts.depth || 5) + 1 : nodeDepth + 1;
        const children = this.fetchChildrenDeep(opts.id, nodeDepth + 1, expandDepth);
        const entry = this.nodeToEntry(this.rowToNode(row), children);
        if (opts.expand) entry.expanded = true;

        // Load tags for this node + its children
        const allNodeIds = [opts.id, ...children.map(c => c.id)];
        const tagMap = this.fetchTagsBulk(allNodeIds);
        if (tagMap.has(opts.id)) entry.tags = tagMap.get(opts.id);
        for (const child of children) {
          if (tagMap.has(child.id)) child.tags = tagMap.get(child.id);
        }

        return [entry];
      } else {
        // Root ID — fetch from memories
        const sql = `SELECT * FROM memories WHERE id = ?${roleFilter.sql ? ` AND ${roleFilter.sql}` : ""}`;
        const row = this.db.prepare(sql).get(opts.id, ...roleFilter.params) as any;
        if (!row) return [];

        // ── Obsolete chain resolution ──
        const shouldFollow = opts.followObsolete !== false; // default: true
        if (shouldFollow && row.obsolete === 1) {
          const { finalId, chain } = this.resolveObsoleteChain(opts.id);

          if (chain.length > 1) {
            // Chain resolved — return final entry (or full path)
            if (opts.showObsoletePath) {
              // Return ALL entries in the chain
              const entries: MemoryEntry[] = [];
              for (const chainId of chain) {
                const chainRow = this.db.prepare(sql).get(chainId, ...roleFilter.params) as any;
                if (!chainRow) continue;
                const children = this.fetchChildren(chainId);
                const entry = this.rowToEntry(chainRow, children);
                entry.obsoleteChain = chain;
                entries.push(entry);
              }
              // Bump access on the final (valid) entry only
              this.bumpAccess(finalId);
              return entries;
            } else {
              // Return ONLY the final valid entry
              this.bumpAccess(finalId);
              const finalRow = this.db.prepare(sql).get(finalId, ...roleFilter.params) as any;
              if (!finalRow) return []; // correction target inaccessible
              const children = this.fetchChildren(finalId);
              const entry = this.rowToEntry(finalRow, children);
              entry.obsoleteChain = chain;
              // Resolve links on the final entry
              this.resolveEntryLinks(entry, opts);
              return [entry];
            }
          }
          // chain.length <= 1: no correction found, fall through to normal behavior
        }

        this.bumpAccess(opts.id);

        // expand: fetch requested depth + 1 extra level (for boundary titles)
        const expandDepth = opts.expand ? (opts.depth || 5) + 1 : 2;
        const children = this.fetchChildrenDeep(opts.id, 2, expandDepth);
        const entry = this.rowToEntry(row, children);
        if (opts.expand) entry.expanded = true;

        // Auto-resolve links
        this.resolveEntryLinks(entry, opts);

        // Load tags for entry + children, find related entries
        const allIds = [opts.id, ...this.collectNodeIds(children)];
        const tagMap = this.fetchTagsBulk(allIds);
        if (tagMap.has(opts.id)) entry.tags = tagMap.get(opts.id);
        for (const child of children) {
          if (tagMap.has(child.id)) child.tags = tagMap.get(child.id);
          if (child.children) {
            for (const gc of child.children) {
              if (tagMap.has(gc.id)) gc.tags = tagMap.get(gc.id);
            }
          }
        }
        // Related entries: find other entries sharing 2+ tags
        const entryTags = entry.tags ?? [];
        if (entryTags.length >= 2) {
          entry.relatedEntries = this.findRelated(opts.id, entryTags, 5);
        }

        return [entry];
      }
    }

    // Time-around: find entries created around the same time as a reference entry
    if (opts.timeAround) {
      const refId = opts.timeAround;
      const isRefNode = refId.includes(".");
      let refTime: string | null = null;
      if (isRefNode) {
        const refRow = this.db.prepare("SELECT created_at FROM memory_nodes WHERE id = ?").get(refId) as any;
        refTime = refRow?.created_at ?? null;
      } else {
        const refRow = this.db.prepare("SELECT created_at FROM memories WHERE id = ?").get(refId) as any;
        refTime = refRow?.created_at ?? null;
      }
      if (!refTime) return [];

      const refDate = new Date(refTime);
      const { start, end } = this.parseTimeWindow(refDate, opts.period ?? "both");

      const conditions: string[] = ["seq > 0", "created_at >= ?", "created_at <= ?"];
      const params: any[] = [start.toISOString(), end.toISOString()];
      if (roleFilter.sql) { conditions.push(roleFilter.sql); params.push(...roleFilter.params); }

      const where = `WHERE ${conditions.join(" AND ")}`;
      const rows = this.db.prepare(
        `SELECT * FROM memories ${where} ORDER BY created_at DESC`
      ).all(...params) as any[];
      return rows.map(r => this.rowToEntry(r));
    }

    // Full-text search across memories + memory_nodes
    if (opts.search) {
      const pattern = `%${opts.search}%`;
      // Search in memories level_1 (exclude headers: seq > 0)
      const searchCondition = "(level_1 LIKE ? AND seq > 0)";
      const where = roleFilter.sql ? `WHERE ${searchCondition} AND ${roleFilter.sql}` : `WHERE ${searchCondition}`;

      // Also search memory_nodes content
      const nodeLimitClause = limit !== undefined ? ` LIMIT ${limit}` : "";
      const nodeRows = this.db.prepare(
        `SELECT DISTINCT root_id FROM memory_nodes WHERE content LIKE ?${nodeLimitClause}`
      ).all(pattern) as any[];
      const nodeRootIds = new Set(nodeRows.map(r => r.root_id));

      // Also search tags (e.g. search="#hmem" matches tag "#hmem")
      const tagRows = this.db.prepare(
        "SELECT entry_id FROM memory_tags WHERE tag LIKE ?"
      ).all(pattern) as any[];
      for (const row of tagRows) {
        const eid = row.entry_id as string;
        nodeRootIds.add(eid.includes(".") ? eid.split(".")[0] : eid);
      }

      const memLimitClause = limit !== undefined ? ` LIMIT ${limit}` : "";
      const memRows = this.db.prepare(
        `SELECT * FROM memories ${where} ORDER BY created_at DESC${memLimitClause}`
      ).all(pattern, ...roleFilter.params) as any[];

      // Merge: include any roots found in node search too
      const allIds = new Set(memRows.map((r: any) => r.id));
      const extraIds = [...nodeRootIds].filter(id => !allIds.has(id));

      let extraRows: any[] = [];
      if (extraIds.length > 0) {
        const placeholders = extraIds.map(() => "?").join(", ");
        const extraWhere = roleFilter.sql
          ? `WHERE id IN (${placeholders}) AND seq > 0 AND ${roleFilter.sql}`
          : `WHERE id IN (${placeholders}) AND seq > 0`;
        extraRows = this.db.prepare(
          `SELECT * FROM memories ${extraWhere} ORDER BY created_at DESC`
        ).all(...extraIds, ...roleFilter.params) as any[];
      }

      const allRows = [...memRows, ...extraRows];
      for (const row of allRows) this.bumpAccess(row.id);
      return allRows.map(r => this.rowToEntry(r));
    }

    // Build filtered bulk query (exclude headers: seq > 0)
    const conditions: string[] = ["seq > 0"];
    const params: any[] = [];

    if (roleFilter.sql) {
      conditions.push(roleFilter.sql);
      params.push(...roleFilter.params);
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

    // Time-based filtering
    if (opts.time) {
      const { start, end } = this.parseTimeFilter(opts.time, opts.after ?? new Date().toISOString().substring(0, 10), opts.period);
      conditions.push("created_at >= ?");
      params.push(start.toISOString());
      conditions.push("created_at <= ?");
      params.push(end.toISOString());
    }

    // Tag-based filtering: restrict to entries that have the specified tag
    if (opts.tag) {
      const tagRootIds = this.getRootIdsByTag(opts.tag.toLowerCase());
      if (tagRootIds.size === 0) return [];
      const placeholders = [...tagRootIds].map(() => "?").join(", ");
      conditions.push(`id IN (${placeholders})`);
      params.push(...tagRootIds);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Sort by effective_date: the most recent of root created_at OR latest child node created_at.
    // This ensures entries with recently appended L2 nodes surface alongside genuinely new entries.
    const limitClause = limit !== undefined ? `LIMIT ${limit}` : "";
    const rows = this.db.prepare(`
      SELECT m.*,
        COALESCE(
          (SELECT MAX(n.created_at) FROM memory_nodes n WHERE n.root_id = m.id),
          m.created_at
        ) AS effective_date
      FROM memories m
      ${where}
      ORDER BY effective_date DESC
      ${limitClause}
    `).all(...params) as any[];

    if (opts.prefix || opts.after || opts.before) {
      for (const row of rows) this.bumpAccess(row.id);
    }

    return this.readBulkV2(rows, opts);
  }


  /**
   * Calculate V2 selection slot counts based on the number of relevant entries.
   * Uses percentage-based scaling with min/max caps when configured,
   * falls back to fixed topNewestCount/topAccessCount otherwise.
   */
  private calcV2Slots(relevantCount: number, isEssentials: boolean = false, fraction: number = 1.0): { newestCount: number; accessCount: number } {
    const v2 = this.cfg.bulkReadV2;
    let newest: number, access: number;

    if (v2.newestPercent !== undefined) {
      const effNewest = v2.newestPercent * fraction;
      const effAccess = (v2.accessPercent ?? 10) * fraction;
      newest = Math.min(
        v2.newestMax ?? 15,
        Math.max(v2.newestMin ?? 5, Math.ceil(relevantCount * (effNewest / 100)))
      );
      access = Math.min(
        v2.accessMax ?? 8,
        Math.max(v2.accessMin ?? 3, Math.ceil(relevantCount * (effAccess / 100)))
      );
    } else {
      newest = Math.max(1, Math.round(v2.topNewestCount * fraction));
      access = Math.max(1, Math.round(v2.topAccessCount * fraction));
    }

    if (isEssentials) {
      const total = newest + access;
      newest = Math.max(1, Math.floor(newest * 0.4));
      access = total - newest;
    }

    return { newestCount: newest, accessCount: access };
  }

  /**
   * V2 bulk-read algorithm: per-prefix expansion, smart obsolete filtering,
   * expanded entries with all L2 children + links.
   */
  private readBulkV2(rows: any[], opts: ReadOptions): MemoryEntry[] {
    const v2 = this.cfg.bulkReadV2;

    // Step 0: Filter out irrelevant entries (never shown in bulk reads)
    const irrelevantCount = rows.filter(r => r.irrelevant === 1).length;
    const activeRows = rows.filter(r => r.irrelevant !== 1);

    // Step 1: Separate obsolete from non-obsolete FIRST
    const obsoleteRows = activeRows.filter(r => r.obsolete === 1);
    const nonObsoleteRows = activeRows.filter(r => r.obsolete !== 1);

    // Step 2: Group NON-OBSOLETE by prefix (obsolete must not steal expansion slots)
    const byPrefix = new Map<string, any[]>();
    for (const r of nonObsoleteRows) {
      const arr = byPrefix.get(r.prefix);
      if (arr) arr.push(r);
      else byPrefix.set(r.prefix, [r]);
    }

    // === Curation mode: show ALL entries, bypass V2 + session cache, depth 3 children ===
    if (opts.showAll) {
      const visibleObsolete = opts.showObsolete ? obsoleteRows : [];
      const allVisible = [...nonObsoleteRows, ...visibleObsolete];
      const visibleIds = new Set(allVisible.map(r => r.id));

      const entries = allVisible.map(r => {
        // Fetch children to depth 3 (L2 + L3), no V2 selection, filter irrelevant
        const allChildren = this.fetchChildrenDeep(r.id, 2, 4)
          .filter(c => !c.irrelevant);

        // Resolve links
        let linkedEntries: MemoryEntry[] | undefined;
        const links: string[] = r.links ? JSON.parse(r.links) : [];
        if (links.length > 0) {
          linkedEntries = links.flatMap(linkId => {
            if (visibleIds.has(linkId)) return [];
            try {
              return this.read({ id: linkId, resolveLinks: false, linkDepth: 0, followObsolete: false });
            } catch { return []; }
          }).filter(e => !e.obsolete && !e.irrelevant);
        }

        const entry = this.rowToEntry(r, allChildren);
        entry.expanded = true;
        if (r.favorite === 1) entry.promoted = "favorite";
        if (linkedEntries && linkedEntries.length > 0) entry.linkedEntries = linkedEntries;
        return entry;
      });
      this.assignBulkTags(entries);
      return entries;
    }

    // === Normal mode: V2 selection + session cache ===

    // Session cache: two phases — hidden (< 5 min, excluded) and cached (5-30 min, title-only)
    const cached = opts.cachedIds ?? new Set<string>();
    const hidden = opts.hiddenIds ?? new Set<string>();
    const fraction = opts.slotFraction ?? 1.0;

    // Step 3: Build expansion set from non-obsolete rows
    const expandedIds = new Set<string>();
    const isEssentials = opts.mode === "essentials";

    // Per prefix: top N newest + top M most-accessed — slot counts scale with prefix size
    for (const [, prefixRows] of byPrefix) {
      const { newestCount, accessCount } = this.calcV2Slots(prefixRows.length, isEssentials, fraction);

      // Newest: skip cached AND hidden entries, fill from fresh entries only
      const uncachedRows = prefixRows.filter(r => !cached.has(r.id) && !hidden.has(r.id));
      for (const r of uncachedRows.slice(0, newestCount)) {
        expandedIds.add(r.id);
      }

      // Most-accessed: from uncached entries, excluding those already picked as newest.
      // Minimum threshold: access_count >= 2 — a single access can be noise.
      const mostAccessed = [...uncachedRows]
        .filter(r => r.access_count >= 2 && !expandedIds.has(r.id))
        .sort((a, b) => this.weightedAccessScore(b) - this.weightedAccessScore(a))
        .slice(0, accessCount);
      for (const r of mostAccessed) expandedIds.add(r.id);
    }

    // Global: all uncached+unhidden favorites
    for (const r of nonObsoleteRows) {
      if ((r.favorite === 1 || r.pinned === 1) && !cached.has(r.id) && !hidden.has(r.id)) {
        expandedIds.add(r.id);
      }
    }

    // topAccess reference for promoted marker (time-weighted, min 2 accesses)
    const { accessCount: globalAccessSlots } = this.calcV2Slots(nonObsoleteRows.length);
    const topAccess = [...nonObsoleteRows]
      .filter(r => r.access_count >= 2)
      .sort((a, b) => this.weightedAccessScore(b) - this.weightedAccessScore(a))
      .slice(0, globalAccessSlots);

    // Obsolete entries: only shown when explicitly requested
    const visibleObsolete = opts.showObsolete ? obsoleteRows : [];

    // Step 4: Build visible rows (hidden entries completely excluded)
    // - Expanded entries: full content with children
    // - Cached entries: title-only (no expansion, no children)
    const expandedNonObsolete = nonObsoleteRows.filter(r => expandedIds.has(r.id));
    const cachedVisible = nonObsoleteRows.filter(r => cached.has(r.id) && !expandedIds.has(r.id) && !hidden.has(r.id));
    const visibleRows = [...expandedNonObsolete, ...cachedVisible, ...visibleObsolete];
    const visibleIds = new Set(visibleRows.map(r => r.id));

    // titles_only: V2 selection applies, but skip link resolution
    if (opts.titlesOnly) {
      // Bulk-fetch L2 child counts (one query for all visible entries)
      const allIds = visibleRows.map(r => r.id);
      const childCounts = this.bulkChildCount(allIds);

      const entries = visibleRows.map(r => {
        const isExpanded = expandedIds.has(r.id);
        const totalChildren = childCounts.get(r.id) ?? 0;

        let children: MemoryNode[] | undefined;
        let hiddenCount: number | undefined;

        if (isExpanded && totalChildren > 0) {
          // Fetch L2 children with V2 selection (percentage-based), no links
          const allChildren = this.fetchChildren(r.id).filter(c => !c.irrelevant);
          const childSlots = this.calcV2Slots(allChildren.length);
          if (allChildren.length > childSlots.newestCount) {
            const newestSet = new Set(
              [...allChildren]
                .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
                .slice(0, childSlots.newestCount)
                .map(c => c.id)
            );
            const accessSet = new Set(
              [...allChildren]
                .filter(c => c.access_count >= 2)
                .sort((a, b) => this.weightedAccessScore(b) - this.weightedAccessScore(a))
                .slice(0, childSlots.accessCount)
                .map(c => c.id)
            );
            const selectedIds = new Set([...newestSet, ...accessSet]);
            children = allChildren.filter(c => selectedIds.has(c.id));
            hiddenCount = allChildren.length - children.length;
          } else {
            children = allChildren;
          }
        } else if (totalChildren > 0) {
          hiddenCount = totalChildren;
        }

        const entry = this.rowToEntry(r, children);
        if (r.favorite === 1) entry.promoted = "favorite";
        else if (topAccess.some(t => t.id === r.id)) entry.promoted = "access";
        if (isExpanded) entry.expanded = true;
        if (hiddenCount !== undefined && hiddenCount > 0) entry.hiddenChildrenCount = hiddenCount;
        return entry;
      });
      this.assignBulkTags(entries);
      return entries;
    }

    const entries = visibleRows.map(r => {
      const isExpanded = expandedIds.has(r.id);
      let promoted: "access" | "favorite" | undefined;
      if (r.favorite === 1) promoted = "favorite";
      else if (topAccess.some(t => t.id === r.id)) promoted = "access";

      let children: MemoryNode[] | undefined;
      let linkedEntries: MemoryEntry[] | undefined;
      let hiddenChildrenCount: number | undefined;
      let hiddenObsoleteLinks = 0;
      let hiddenIrrelevantLinks = 0;

      if (isExpanded) {
        // Fetch all L2 children, then apply V2 selection (percentage-based)
        const allChildren = this.fetchChildren(r.id).filter(c => !c.irrelevant);
        const childSlots = this.calcV2Slots(allChildren.length);
        if (allChildren.length > childSlots.newestCount) {
          const newestSet = new Set(
            [...allChildren]
              .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
              .slice(0, childSlots.newestCount)
              .map(c => c.id)
          );
          const accessSet = new Set(
            [...allChildren]
              .filter(c => c.access_count > 0)
              .sort((a, b) => this.weightedAccessScore(b) - this.weightedAccessScore(a))
              .slice(0, childSlots.accessCount)
              .map(c => c.id)
          );
          const selectedIds = new Set([...newestSet, ...accessSet]);
          children = allChildren.filter(c => selectedIds.has(c.id));
          if (children.length < allChildren.length) {
            hiddenChildrenCount = allChildren.length - children.length;
          }
        } else {
          children = allChildren;
        }

        // Resolve links — skip entries already visible in bulk read
        const links: string[] = r.links ? JSON.parse(r.links) : [];
        if (links.length > 0) {
          const allLinked = links.flatMap(linkId => {
            if (visibleIds.has(linkId)) return []; // already shown in bulk read
            try {
              return this.read({ id: linkId, resolveLinks: false, linkDepth: 0, followObsolete: false });
            } catch { return []; }
          });
          for (const e of allLinked) {
            if (e.obsolete) hiddenObsoleteLinks++;
            else if (e.irrelevant) hiddenIrrelevantLinks++;
          }
          linkedEntries = allLinked.filter(e => !e.obsolete && !e.irrelevant);
        }
      }

      const entry = this.rowToEntry(r, children);
      entry.promoted = promoted;
      entry.expanded = isExpanded;
      if (hiddenChildrenCount !== undefined) entry.hiddenChildrenCount = hiddenChildrenCount;
      if (linkedEntries && linkedEntries.length > 0) entry.linkedEntries = linkedEntries;
      if (hiddenObsoleteLinks > 0) entry.hiddenObsoleteLinks = hiddenObsoleteLinks;
      if (hiddenIrrelevantLinks > 0) entry.hiddenIrrelevantLinks = hiddenIrrelevantLinks;

      return entry;
    });
    this.assignBulkTags(entries);
    return entries;
  }

  /**
   * Get all Level 1 entries for injection at agent startup.
   * Does NOT bump access_count (routine injection).
   */
  getLevel1All(agentRole?: AgentRole): string {
    const roleFilter = this.buildRoleFilter(agentRole);
    const where = roleFilter.sql ? `WHERE seq > 0 AND ${roleFilter.sql}` : "WHERE seq > 0";
    const rows = this.db.prepare(
      `SELECT id, created_at, level_1 FROM memories ${where} ORDER BY created_at DESC`
    ).all(...roleFilter.params) as any[];

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
      "SELECT * FROM memories WHERE seq > 0 ORDER BY prefix, seq"
    ).all() as any[];

    if (rows.length === 0) return "# Memory Export\n\n(empty)\n";

    // Fetch ALL nodes in a single query, group by root_id (avoids N+1)
    const allNodes = this.db.prepare(
      "SELECT * FROM memory_nodes ORDER BY root_id, depth, seq"
    ).all() as any[];
    const nodesByRoot = new Map<string, any[]>();
    for (const n of allNodes) {
      const arr = nodesByRoot.get(n.root_id);
      if (arr) arr.push(n);
      else nodesByRoot.set(n.root_id, [n]);
    }

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

      // Include tree nodes (pre-fetched)
      const nodes = nodesByRoot.get(row.id) ?? [];
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
   * Export memory to a new .hmem SQLite file.
   * Creates a standalone copy that can be opened with HmemStore or hmem.py.
   */
  exportPublicToHmem(outputPath: string): { entries: number; nodes: number; tags: number } {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    if (fs.existsSync(outputPath + "-wal")) fs.unlinkSync(outputPath + "-wal");
    if (fs.existsSync(outputPath + "-shm")) fs.unlinkSync(outputPath + "-shm");

    const exportDb = new Database(outputPath);
    exportDb.pragma("journal_mode = WAL");
    exportDb.exec(SCHEMA);
    for (const sql of MIGRATIONS) {
      try { exportDb.exec(sql); } catch {}
    }

    // Determine export-compatible columns (source may have extra columns)
    const memCols = (exportDb.pragma("table_info(memories)") as any[]).map((c: any) => c.name);
    const nodeCols = (exportDb.pragma("table_info(memory_nodes)") as any[]).map((c: any) => c.name);

    // Copy all entries (only columns the export schema knows)
    const rows = this.db.prepare(
      `SELECT ${memCols.join(", ")} FROM memories WHERE seq > 0 ORDER BY prefix, seq`
    ).all() as any[];

    if (rows.length > 0) {
      const placeholders = memCols.map(() => "?").join(", ");
      const insertMem = exportDb.prepare(
        `INSERT INTO memories (${memCols.join(", ")}) VALUES (${placeholders})`
      );
      const txn = exportDb.transaction((entries: any[]) => {
        for (const r of entries) insertMem.run(...memCols.map(c => r[c]));
      });
      txn(rows);
    }

    // Copy all nodes
    const allNodes = this.db.prepare(
      `SELECT ${nodeCols.join(", ")} FROM memory_nodes ORDER BY root_id, depth, seq`
    ).all() as any[];

    if (allNodes.length > 0) {
      const placeholders = nodeCols.map(() => "?").join(", ");
      const insertNode = exportDb.prepare(
        `INSERT INTO memory_nodes (${nodeCols.join(", ")}) VALUES (${placeholders})`
      );
      const txn = exportDb.transaction((nodes: any[]) => {
        for (const n of nodes) insertNode.run(...nodeCols.map(c => n[c]));
      });
      txn(allNodes);
    }

    // Copy all tags
    const allTags = this.db.prepare("SELECT * FROM memory_tags").all() as any[];

    if (allTags.length > 0) {
      const insertTag = exportDb.prepare(
        "INSERT INTO memory_tags (entry_id, tag) VALUES (?, ?)"
      );
      const txn = exportDb.transaction((tags: any[]) => {
        for (const t of tags) insertTag.run(t.entry_id, t.tag);
      });
      txn(allTags);
    }

    exportDb.pragma("wal_checkpoint(TRUNCATE)");
    exportDb.close();

    return { entries: rows.length, nodes: allNodes.length, tags: allTags.length };
  }

  /**
   * Import entries from another .hmem file with L1 deduplication and ID remapping.
   */
  importFromHmem(sourcePath: string, dryRun: boolean = false): ImportResult {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }

    const sourceDb = new Database(sourcePath, { readonly: true });
    try {
      return this._doImport(sourceDb, dryRun);
    } finally {
      sourceDb.close();
    }
  }

  private _doImport(sourceDb: Database.Database, dryRun: boolean): ImportResult {
    // ---- Phase 1: Analyse ----
    const srcEntries = sourceDb.prepare(
      "SELECT * FROM memories WHERE seq > 0 ORDER BY prefix, seq"
    ).all() as any[];
    const srcNodes = sourceDb.prepare(
      "SELECT * FROM memory_nodes ORDER BY root_id, depth, seq"
    ).all() as any[];

    let srcTags: any[] = [];
    try {
      srcTags = sourceDb.prepare("SELECT * FROM memory_tags").all() as any[];
    } catch { /* table may not exist in older exports */ }

    const srcNodesByRoot = new Map<string, any[]>();
    for (const n of srcNodes) {
      const arr = srcNodesByRoot.get(n.root_id);
      if (arr) arr.push(n);
      else srcNodesByRoot.set(n.root_id, [n]);
    }

    const srcTagsByEntry = new Map<string, string[]>();
    for (const t of srcTags) {
      const arr = srcTagsByEntry.get(t.entry_id);
      if (arr) arr.push(t.tag);
      else srcTagsByEntry.set(t.entry_id, [t.tag]);
    }

    type EntryAction = { type: "duplicate"; srcEntry: any; targetId: string }
                     | { type: "new"; srcEntry: any };
    const actions: EntryAction[] = [];
    let conflicts = 0;

    for (const src of srcEntries) {
      const existing = this.db.prepare(
        "SELECT id FROM memories WHERE prefix = ? AND level_1 = ? AND seq > 0"
      ).get(src.prefix, src.level_1) as any;

      if (existing) {
        actions.push({ type: "duplicate", srcEntry: src, targetId: existing.id });
      } else {
        actions.push({ type: "new", srcEntry: src });
        const conflict = this.db.prepare(
          "SELECT id FROM memories WHERE id = ?"
        ).get(src.id) as any;
        if (conflict) conflicts++;
      }
    }

    const needsRemap = conflicts > 0;

    let totalNodesToInsert = 0;
    let totalNodesToSkip = 0;

    for (const action of actions) {
      if (action.type === "duplicate") {
        const srcChildren = (srcNodesByRoot.get(action.srcEntry.id) ?? [])
          .filter((n: any) => n.depth === 2 && n.parent_id === action.srcEntry.id);
        const targetChildren = this.db.prepare(
          "SELECT content FROM memory_nodes WHERE parent_id = ? AND depth = 2"
        ).all(action.targetId) as any[];
        const targetContents = new Set(targetChildren.map((c: any) => c.content));

        for (const sc of srcChildren) {
          const descendants = (srcNodesByRoot.get(action.srcEntry.id) ?? [])
            .filter((n: any) => n.id.startsWith(sc.id + ".") || n.id === sc.id);
          if (targetContents.has(sc.content)) {
            totalNodesToSkip += descendants.length;
          } else {
            totalNodesToInsert += descendants.length;
          }
        }
      } else {
        totalNodesToInsert += (srcNodesByRoot.get(action.srcEntry.id) ?? []).length;
      }
    }

    const newCount = actions.filter(a => a.type === "new").length;
    const dupeCount = actions.filter(a => a.type === "duplicate").length;

    if (dryRun) {
      return {
        inserted: newCount, merged: dupeCount,
        nodesInserted: totalNodesToInsert, nodesSkipped: totalNodesToSkip,
        tagsImported: srcTags.length, remapped: needsRemap, conflicts,
      };
    }

    // ---- Phase 2: ID Remapping ----
    const idMap = new Map<string, string>();

    if (needsRemap) {
      const usedSeqs = new Map<string, number>();
      for (const action of actions) {
        if (action.type === "new") {
          const prefix = action.srcEntry.prefix;
          const baseSeq = this.nextSeq(prefix);
          const offset = usedSeqs.get(prefix) ?? 0;
          const seq = baseSeq + offset;
          usedSeqs.set(prefix, offset + 1);
          idMap.set(action.srcEntry.id, `${prefix}${String(seq).padStart(4, "0")}`);
        }
      }
    }

    for (const action of actions) {
      if (action.type === "duplicate") {
        idMap.set(action.srcEntry.id, action.targetId);
      }
    }

    const remapId = (id: string): string => {
      if (!id) return id;
      const rootId = id.split(".")[0];
      const newRootId = idMap.get(rootId);
      if (!newRootId) return id;
      return newRootId + id.substring(rootId.length);
    };

    const remapLinks = (linksJson: string | null): string | null => {
      if (!linksJson) return linksJson;
      try {
        const links = JSON.parse(linksJson) as string[];
        return JSON.stringify(links.map(remapId));
      } catch { return linksJson; }
    };

    const remapContent = (content: string): string => {
      if (!content) return content;
      return content.replace(/\[✓([A-Z]\d{4}(?:\.\d+)*)\]/g, (match, id) => {
        const newId = remapId(id);
        return newId !== id ? `[✓${newId}]` : match;
      });
    };

    // ---- Phase 3: Insert/Merge ----
    const result: ImportResult = {
      inserted: 0, merged: 0, nodesInserted: 0, nodesSkipped: 0,
      tagsImported: 0, remapped: needsRemap, conflicts,
    };

    const memCols = (this.db.pragma("table_info(memories)") as any[]).map((c: any) => c.name);
    const nodeCols = (this.db.pragma("table_info(memory_nodes)") as any[]).map((c: any) => c.name);
    const srcMemCols = (() => { try { return (sourceDb.pragma("table_info(memories)") as any[]).map((c: any) => c.name); } catch { return []; } })();
    const srcNodeCols = (() => { try { return (sourceDb.pragma("table_info(memory_nodes)") as any[]).map((c: any) => c.name); } catch { return []; } })();
    const commonMemCols = memCols.filter(c => srcMemCols.includes(c));
    const commonNodeCols = nodeCols.filter(c => srcNodeCols.includes(c));

    this.db.transaction(() => {
      for (const action of actions) {
        if (action.type !== "new") continue;
        const src = action.srcEntry;
        const newId = idMap.get(src.id) ?? src.id;

        const values: any = {};
        for (const col of commonMemCols) values[col] = src[col];
        values.id = newId;
        if (needsRemap) {
          values.links = remapLinks(src.links);
          values.level_1 = remapContent(src.level_1);
        }

        this.db.prepare(
          `INSERT INTO memories (${commonMemCols.join(", ")}) VALUES (${commonMemCols.map(() => "?").join(", ")})`
        ).run(...commonMemCols.map(c => values[c]));

        const entryNodes = srcNodesByRoot.get(src.id) ?? [];
        for (const node of entryNodes) {
          const nv: any = {};
          for (const col of commonNodeCols) nv[col] = node[col];
          nv.id = remapId(node.id);
          nv.parent_id = remapId(node.parent_id);
          nv.root_id = newId;
          if (needsRemap) { nv.links = remapLinks(node.links); nv.content = remapContent(node.content); }

          this.db.prepare(
            `INSERT INTO memory_nodes (${commonNodeCols.join(", ")}) VALUES (${commonNodeCols.map(() => "?").join(", ")})`
          ).run(...commonNodeCols.map(c => nv[c]));
          result.nodesInserted++;
        }

        const entryTags = srcTagsByEntry.get(src.id) ?? [];
        for (const tag of entryTags) {
          this.db.prepare("INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)").run(newId, tag);
          result.tagsImported++;
        }
        for (const node of entryNodes) {
          for (const tag of (srcTagsByEntry.get(node.id) ?? [])) {
            this.db.prepare("INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)").run(remapId(node.id), tag);
            result.tagsImported++;
          }
        }
        result.inserted++;
      }

      for (const action of actions) {
        if (action.type !== "duplicate") continue;
        const src = action.srcEntry;
        const targetId = action.targetId;

        const targetChildren = this.db.prepare(
          "SELECT content FROM memory_nodes WHERE parent_id = ? AND depth = 2"
        ).all(targetId) as any[];
        const targetContents = new Set(targetChildren.map((c: any) => c.content));

        const srcAllNodes = srcNodesByRoot.get(src.id) ?? [];
        const srcL2 = srcAllNodes.filter((n: any) => n.depth === 2 && n.parent_id === src.id);

        const maxSeqRow = this.db.prepare(
          "SELECT MAX(seq) as maxSeq FROM memory_nodes WHERE parent_id = ?"
        ).get(targetId) as any;
        let nextChildSeq = (maxSeqRow?.maxSeq ?? 0) + 1;

        for (const l2 of srcL2) {
          if (targetContents.has(l2.content)) {
            result.nodesSkipped += srcAllNodes.filter((n: any) =>
              n.id === l2.id || n.id.startsWith(l2.id + ".")).length;
            continue;
          }

          const descendants = srcAllNodes.filter((n: any) =>
            n.id === l2.id || n.id.startsWith(l2.id + "."));
          const l2NewId = `${targetId}.${nextChildSeq}`;
          nextChildSeq++;

          for (const desc of descendants) {
            const nv: any = {};
            for (const col of commonNodeCols) nv[col] = desc[col];
            const oldPrefix = l2.id;
            const newPrefix = l2NewId;
            nv.id = desc.id === l2.id ? l2NewId : newPrefix + desc.id.substring(oldPrefix.length);
            nv.parent_id = desc.parent_id === src.id ? targetId
              : desc.parent_id === l2.id ? l2NewId
              : newPrefix + desc.parent_id.substring(oldPrefix.length);
            nv.root_id = targetId;
            nv.content = remapContent(desc.content);
            nv.links = remapLinks(desc.links);
            if (desc.id === l2.id) nv.seq = nextChildSeq - 1;
            if (!nv.title) nv.title = (nv.content || "").substring(0, this.cfg.maxTitleChars || 50);

            this.db.prepare(
              `INSERT INTO memory_nodes (${commonNodeCols.join(", ")}) VALUES (${commonNodeCols.map(() => "?").join(", ")})`
            ).run(...commonNodeCols.map(c => nv[c]));
            result.nodesInserted++;

            for (const tag of (srcTagsByEntry.get(desc.id) ?? [])) {
              this.db.prepare("INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)").run(nv.id, tag);
              result.tagsImported++;
            }
          }
        }

        for (const tag of (srcTagsByEntry.get(src.id) ?? [])) {
          this.db.prepare("INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)").run(targetId, tag);
          result.tagsImported++;
        }
        result.merged++;
      }
    })();

    return result;
  }

  /**
   * Get statistics about the memory store.
   */
  stats(): { total: number; byPrefix: Record<string, number>; totalChars: number } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE seq > 0").get() as any).c;
    const rows = this.db.prepare(
      "SELECT prefix, COUNT(*) as c FROM memories WHERE seq > 0 GROUP BY prefix"
    ).all() as any[];

    const byPrefix: Record<string, number> = {};
    for (const r of rows) byPrefix[r.prefix] = r.c;

    // Total characters across all entries + nodes (for token estimation)
    const memChars = (this.db.prepare("SELECT COALESCE(SUM(LENGTH(level_1)),0) as c FROM memories WHERE seq > 0").get() as any).c;
    const nodeChars = (this.db.prepare("SELECT COALESCE(SUM(LENGTH(content)),0) as c FROM memory_nodes").get() as any).c;
    return { total, byPrefix, totalChars: memChars + nodeChars };
  }

  /**
   * Update specific fields of an existing root entry (curator use only).
   */
  update(id: string, fields: Partial<Pick<MemoryEntry, "level_1" | "level_2" | "level_3" | "level_4" | "level_5" | "links" | "min_role" | "obsolete" | "favorite" | "irrelevant">>): boolean {
    this.guardCorrupted();
    const sets: string[] = [];
    const params: any[] = [];

    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      if (key === "links" && Array.isArray(val)) {
        params.push(JSON.stringify(val));
      } else if (key === "obsolete" || key === "favorite" || key === "irrelevant") {
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
    this.guardCorrupted();
    // Delete tags for root + all child nodes
    this.db.prepare("DELETE FROM memory_tags WHERE entry_id = ? OR entry_id LIKE ?").run(id, `${id}.%`);
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
  updateNode(id: string, newContent: string, links?: string[], obsolete?: boolean, favorite?: boolean, curatorBypass?: boolean, irrelevant?: boolean, tags?: string[], pinned?: boolean): boolean {
    this.guardCorrupted();
    const trimmed = newContent.trim();
    if (id.includes(".")) {
      // Sub-node in memory_nodes — check char limit for its depth
      const nodeRow = this.db.prepare("SELECT depth FROM memory_nodes WHERE id = ?").get(id) as any;
      if (!nodeRow) return false;
      const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(nodeRow.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
      if (trimmed.length > nodeLimit * HmemStore.CHAR_LIMIT_TOLERANCE) {
        throw new Error(`Content exceeds ${nodeLimit} character limit (${trimmed.length} chars) for L${nodeRow.depth}.`);
      }
      const sets = ["content = ?", "title = ?"];
      const params: any[] = [trimmed, this.autoExtractTitle(trimmed)];
      if (favorite !== undefined) {
        sets.push("favorite = ?");
        params.push(favorite ? 1 : 0);
      }
      if (irrelevant !== undefined) {
        sets.push("irrelevant = ?");
        params.push(irrelevant ? 1 : 0);
      }
      params.push(id);
      const result = this.db.prepare(`UPDATE memory_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      if (result.changes > 0 && tags !== undefined) {
        this.setTags(id, tags.length > 0 ? this.validateTags(tags) : []);
      }
      return result.changes > 0;
    } else {
      // Root entry in memories — check L1 char limit
      const l1Limit = this.cfg.maxCharsPerLevel[0];
      if (trimmed.length > l1Limit * HmemStore.CHAR_LIMIT_TOLERANCE) {
        throw new Error(`Level 1 exceeds ${l1Limit} character limit (${trimmed.length} chars). Keep L1 compact.`);
      }

      // Obsolete enforcement: require [✓ID] correction reference
      if (obsolete === true && !curatorBypass) {
        const correctionMatch = trimmed.match(/\[✓([A-Z]\d{4}(?:\.\d+)*)\]/);
        if (!correctionMatch) {
          throw new Error("Cannot mark as obsolete without [✓ID] correction reference — write the correction first.");
        }
        const correctionId = correctionMatch[1];
        // Validate correction target exists
        const existsInMemories = this.db.prepare("SELECT 1 FROM memories WHERE id = ?").get(correctionId);
        const existsInNodes = this.db.prepare("SELECT 1 FROM memory_nodes WHERE id = ?").get(correctionId);
        if (!existsInMemories && !existsInNodes) {
          throw new Error(`Correction target "${correctionId}" not found.`);
        }
        // Add bidirectional links
        this.addLink(id, correctionId);
        this.addLink(correctionId, id);

        // Transfer access_count: obsolete entry → correction entry, then reset obsolete to 0
        const oldEntry = this.db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id) as { access_count: number } | undefined;
        if (oldEntry && oldEntry.access_count > 0) {
          const now = new Date().toISOString();
          if (existsInMemories) {
            this.db.prepare("UPDATE memories SET access_count = access_count + ?, last_accessed = ? WHERE id = ?")
              .run(oldEntry.access_count, now, correctionId);
          } else {
            this.db.prepare("UPDATE memory_nodes SET access_count = access_count + ?, last_accessed = ? WHERE id = ?")
              .run(oldEntry.access_count, now, correctionId);
          }
        }
      }

      const sets: string[] = ["level_1 = ?", "title = ?"];
      const params: any[] = [trimmed, this.autoExtractTitle(trimmed)];
      if (links !== undefined) {
        sets.push("links = ?");
        params.push(links.length > 0 ? JSON.stringify(links) : null);
      }
      if (obsolete !== undefined) {
        sets.push("obsolete = ?");
        params.push(obsolete ? 1 : 0);
        if (obsolete) {
          sets.push("access_count = 0");
        }
      }
      if (favorite !== undefined) {
        sets.push("favorite = ?");
        params.push(favorite ? 1 : 0);
      }
      if (irrelevant !== undefined) {
        sets.push("irrelevant = ?");
        params.push(irrelevant ? 1 : 0);
      }
      if (pinned !== undefined) {
        sets.push("pinned = ?");
        params.push(pinned ? 1 : 0);
      }
      params.push(id);
      const result = this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      if (result.changes > 0 && tags !== undefined) {
        this.setTags(id, tags.length > 0 ? this.validateTags(tags) : []);
      }
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
    this.guardCorrupted();
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

    // Validate char limits before writing (with tolerance buffer)
    const t = HmemStore.CHAR_LIMIT_TOLERANCE;
    for (const node of nodes) {
      const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(node.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
      if (node.content.length > nodeLimit * t) {
        throw new Error(
          `L${node.depth} content exceeds ${nodeLimit} character limit ` +
          `(${node.content.length} chars). Split into multiple calls or use file references.`
        );
      }
    }

    const timestamp = new Date().toISOString();
    const insertNode = this.db.prepare(`
      INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const topLevelIds: string[] = [];

    this.db.transaction(() => {
      for (const node of nodes) {
        insertNode.run(node.id, node.parent_id, rootId, node.depth, node.seq, this.autoExtractTitle(node.content), node.content, timestamp);
        if (node.parent_id === parentId) topLevelIds.push(node.id);
      }
    })();

    // Bubble-up: bump access on the direct parent and root entry
    if (parentId.includes(".")) {
      // Parent is a node → bump the node + bump the root
      this.bumpNodeAccess(parentId);
      this.bumpAccess(rootId);
    } else {
      // Parent is root → bump the root
      this.bumpAccess(parentId);
    }

    return { count: nodes.length, ids: topLevelIds };
  }

  /**
   * Bump access_count on a root entry or node.
   * Returns true if the entry was found and bumped.
   */
  bump(id: string, increment: number = 1): boolean {
    this.guardCorrupted();
    const now = new Date().toISOString();
    if (id.includes(".")) {
      const r = this.db.prepare(
        "UPDATE memory_nodes SET access_count = access_count + ?, last_accessed = ? WHERE id = ?"
      ).run(increment, now, id);
      return r.changes > 0;
    } else {
      const r = this.db.prepare(
        "UPDATE memories SET access_count = access_count + ?, last_accessed = ? WHERE id = ?"
      ).run(increment, now, id);
      return r.changes > 0;
    }
  }

  /**
   * Get all header entries (seq=0) for grouped output formatting.
   */
  getHeaders(): MemoryEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM memories WHERE seq = 0 ORDER BY prefix"
    ).all() as any[];
    return rows.map(r => {
      const entry = this.rowToEntry(r);
      entry.isHeader = true;
      return entry;
    });
  }

  close(): void {
    // Flush WAL to main database file before closing — prevents WAL bloat
    // that can lead to corruption on unclean shutdown
    try {
      this.db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // Best-effort — don't fail close() if checkpoint fails
    }
    this.db.close();
  }

  // ---- Private helpers ----

  // ---- Tag helpers ----

  private static readonly TAG_REGEX = /^#[a-z0-9_-]{1,49}$/;
  private static readonly MAX_TAGS_PER_ENTRY = 10;

  /** Validate and normalize tags: lowercase, must match #word pattern. */
  private validateTags(tags: string[]): string[] {
    if (tags.length > HmemStore.MAX_TAGS_PER_ENTRY) {
      throw new Error(`Too many tags (${tags.length}). Maximum is ${HmemStore.MAX_TAGS_PER_ENTRY}.`);
    }
    const normalized = tags.map(t => t.toLowerCase());
    for (const tag of normalized) {
      if (!HmemStore.TAG_REGEX.test(tag)) {
        throw new Error(`Invalid tag "${tag}". Tags must match #word (lowercase, a-z 0-9 _ -).`);
      }
    }
    return [...new Set(normalized)]; // deduplicate
  }

  /** Replace all tags on an entry/node. Pass empty array to clear. */
  private setTags(entryId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM memory_tags WHERE entry_id = ?").run(entryId);
    if (tags.length === 0) return;
    const insert = this.db.prepare("INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)");
    for (const tag of tags) {
      insert.run(entryId, tag);
    }
  }

  /** Get tags for a single entry/node. */
  private fetchTags(entryId: string): string[] {
    return (this.db.prepare("SELECT tag FROM memory_tags WHERE entry_id = ? ORDER BY tag").all(entryId) as any[])
      .map(r => r.tag);
  }

  /** Bulk-fetch tags for multiple IDs at once. */
  private fetchTagsBulk(ids: string[]): Map<string, string[]> {
    if (ids.length === 0) return new Map();
    const map = new Map<string, string[]>();
    // Process in chunks of 500 to avoid SQLite variable limits
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db.prepare(
        `SELECT entry_id, tag FROM memory_tags WHERE entry_id IN (${placeholders}) ORDER BY entry_id, tag`
      ).all(...chunk) as any[];
      for (const row of rows) {
        const arr = map.get(row.entry_id);
        if (arr) arr.push(row.tag);
        else map.set(row.entry_id, [row.tag]);
      }
    }
    return map;
  }

  /**
   * Find entries sharing 2+ tags with the given entry.
   * Returns title-only results sorted by number of shared tags (descending).
   */
  findRelated(entryId: string, tags: string[], limit: number = 5): { id: string; title: string; created_at: string; tags: string[] }[] {
    if (tags.length < 2) return [];
    const placeholders = tags.map(() => "?").join(", ");
    // Find all entry_ids sharing at least 2 tags (exclude self)
    const rows = this.db.prepare(`
      SELECT entry_id, COUNT(*) as shared
      FROM memory_tags
      WHERE tag IN (${placeholders}) AND entry_id != ?
      GROUP BY entry_id
      HAVING COUNT(*) >= 2
      ORDER BY shared DESC
      LIMIT ?
    `).all(...tags, entryId, limit * 3) as any[]; // fetch extra to account for node→root dedup

    if (rows.length === 0) return [];

    // Resolve node IDs to root entries, dedup
    const seen = new Set<string>();
    const results: { id: string; title: string; created_at: string; tags: string[] }[] = [];

    for (const row of rows) {
      if (results.length >= limit) break;
      const eid = row.entry_id as string;
      const isNode = eid.includes(".");
      const rootId = isNode ? eid.split(".")[0] : eid;

      if (seen.has(rootId) || rootId === entryId || rootId === entryId.split(".")[0]) continue;
      seen.add(rootId);

      // Fetch root entry title
      const rootRow = this.db.prepare("SELECT title, level_1, created_at, irrelevant, obsolete FROM memories WHERE id = ?").get(rootId) as any;
      if (!rootRow || rootRow.irrelevant === 1 || rootRow.obsolete === 1) continue;

      const title = rootRow.title || this.autoExtractTitle(rootRow.level_1);
      const entryTags = this.fetchTags(rootId);
      results.push({ id: rootId, title, created_at: rootRow.created_at, tags: entryTags });
    }

    return results;
  }

  /** Bulk-assign tags to entries + their children from a single fetchTagsBulk call. */
  private assignBulkTags(entries: MemoryEntry[]): void {
    const allIds: string[] = [];
    for (const e of entries) {
      allIds.push(e.id);
      if (e.children) allIds.push(...this.collectNodeIds(e.children));
    }
    if (allIds.length === 0) return;
    const tagMap = this.fetchTagsBulk(allIds);
    for (const e of entries) {
      if (tagMap.has(e.id)) e.tags = tagMap.get(e.id);
      if (e.children) {
        for (const child of e.children) {
          if (tagMap.has(child.id)) child.tags = tagMap.get(child.id);
          if (child.children) {
            for (const gc of child.children) {
              if (tagMap.has(gc.id)) gc.tags = tagMap.get(gc.id);
            }
          }
        }
      }
    }
  }

  /** Recursively collect all node IDs from a tree of MemoryNodes. */
  private collectNodeIds(nodes: MemoryNode[]): string[] {
    const ids: string[] = [];
    for (const node of nodes) {
      ids.push(node.id);
      if (node.children) ids.push(...this.collectNodeIds(node.children));
    }
    return ids;
  }

  /** Get root IDs that have a specific tag (for bulk-read filtering). */
  private getRootIdsByTag(tag: string): Set<string> {
    const rows = this.db.prepare(
      "SELECT entry_id FROM memory_tags WHERE tag = ?"
    ).all(tag) as any[];
    const rootIds = new Set<string>();
    for (const row of rows) {
      const eid = row.entry_id as string;
      if (eid.includes(".")) {
        rootIds.add(eid.split(".")[0]);
      } else {
        rootIds.add(eid);
      }
    }
    return rootIds;
  }

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

  /**
   * One-time migration: create abstract header entries (X0000) for each prefix.
   * Headers have seq=0 and serve as group separators in bulk reads.
   * Idempotent — tracked via schema_version table.
   */
  private migrateHeaders(): void {
    const done = this.db.prepare(
      "SELECT value FROM schema_version WHERE key = 'headers_v1'"
    ).get();
    if (done) return;

    const timestamp = new Date().toISOString();
    const descriptions = this.cfg.prefixDescriptions ?? DEFAULT_PREFIX_DESCRIPTIONS;

    this.db.transaction(() => {
      const insertHeader = this.db.prepare(`
        INSERT OR IGNORE INTO memories (id, prefix, seq, created_at, level_1, min_role)
        VALUES (?, ?, 0, ?, ?, 'worker')
      `);

      for (const prefix of Object.keys(this.cfg.prefixes)) {
        const headerId = `${prefix}0000`;
        const description = descriptions[prefix] || this.cfg.prefixes[prefix];
        insertHeader.run(headerId, prefix, timestamp, description);
      }

      this.db.prepare(
        "INSERT INTO schema_version (key, value) VALUES ('headers_v1', 'done')"
      ).run();
    })();
  }

  /**
   * One-time migration: reset access_count to 0 for all obsolete entries.
   * Entries marked obsolete before the access_count transfer feature was deployed
   * may still have stale access counts. This ensures obsolete entries don't
   * artificially surface in "top most-accessed" rankings.
   */
  private migrateObsoleteAccessCount(): void {
    const done = this.db.prepare(
      "SELECT value FROM schema_version WHERE key = 'obsolete_access_reset_v1'"
    ).get();
    if (done) return;

    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE memories SET access_count = 0 WHERE obsolete = 1 AND access_count > 0"
      ).run();
      // memory_nodes has no obsolete column — only root entries can be obsolete
      this.db.prepare(
        "INSERT INTO schema_version (key, value) VALUES ('obsolete_access_reset_v1', 'done')"
      ).run();
    })();
  }

  /**
   * Add a link from sourceId to targetId (idempotent).
   * Only works for root entries (not nodes).
   */
  private addLink(sourceId: string, targetId: string): void {
    if (sourceId.includes(".") || targetId.includes(".")) return; // nodes don't have links
    const row = this.db.prepare("SELECT links FROM memories WHERE id = ?").get(sourceId) as any;
    if (!row) return;
    const links: string[] = row.links ? JSON.parse(row.links) : [];
    if (!links.includes(targetId)) {
      links.push(targetId);
      this.db.prepare("UPDATE memories SET links = ? WHERE id = ?").run(JSON.stringify(links), sourceId);
    }
  }

  /**
   * Parse time filter "HH:MM" + date + period into start/end window.
   */
  private parseTimeFilter(time: string, date: string, period?: string): { start: Date; end: Date } {
    const [hours, minutes] = time.split(":").map(Number);
    const baseDate = new Date(date);
    baseDate.setHours(hours, minutes, 0, 0);
    return this.parseTimeWindow(baseDate, period ?? "+2h");
  }

  /**
   * Parse a time window around a reference date.
   * period: "+4h" (4h future), "-2h" (2h past), "4h" (±4h symmetric), "both" (±2h default)
   */
  private parseTimeWindow(refDate: Date, period: string): { start: Date; end: Date } {
    const match = period.match(/^([+-]?)(\d+)h$/);
    if (period === "both" || !match) {
      const windowMs = 2 * 60 * 60 * 1000; // default ±2h
      return {
        start: new Date(refDate.getTime() - windowMs),
        end: new Date(refDate.getTime() + windowMs),
      };
    }
    const direction = match[1]; // "+", "-", or "" (symmetric)
    const hours = parseInt(match[2], 10);
    const windowMs = hours * 60 * 60 * 1000;

    if (direction === "-") {
      return { start: new Date(refDate.getTime() - windowMs), end: refDate };
    } else if (direction === "+") {
      return { start: refDate, end: new Date(refDate.getTime() + windowMs) };
    } else {
      // No sign = symmetric ±Nh
      return {
        start: new Date(refDate.getTime() - windowMs),
        end: new Date(refDate.getTime() + windowMs),
      };
    }
  }

  private buildRoleFilter(agentRole?: AgentRole): { sql: string; params: string[] } {
    if (!agentRole) return { sql: "", params: [] };
    const roles = allowedRoles(agentRole);
    const placeholders = roles.map(() => "?").join(", ");
    return { sql: `min_role IN (${placeholders})`, params: roles };
  }

  private nextSeq(prefix: string): number {
    const row = this.db.prepare(
      "SELECT MAX(seq) as maxSeq FROM memories WHERE prefix = ?"
    ).get(prefix) as any;
    return (row?.maxSeq || 0) + 1;
  }

  /** Auto-resolve linked entries on an entry (extracted for reuse in chain resolution). */
  private resolveEntryLinks(entry: MemoryEntry, opts: ReadOptions): void {
    const linkDepth = opts.resolveLinks === false ? 0 : (opts.linkDepth ?? 1);
    if (linkDepth > 0 && entry.links && entry.links.length > 0) {
      const visited = opts._visitedLinks ?? new Set<string>();
      visited.add(entry.id);
      const allLinked = entry.links.flatMap(linkId => {
        if (visited.has(linkId)) return []; // cycle detected — skip
        try {
          return this.read({
            id: linkId,
            agentRole: opts.agentRole,
            linkDepth: linkDepth - 1,
            _visitedLinks: visited,
            followObsolete: false, // don't chain-resolve inside link resolution
          });
        } catch {
          return [];
        }
      });
      let hiddenObsolete = 0;
      let hiddenIrrelevant = 0;
      for (const e of allLinked) {
        if (e.obsolete) hiddenObsolete++;
        else if (e.irrelevant) hiddenIrrelevant++;
      }
      entry.linkedEntries = allLinked.filter(e => !e.obsolete && !e.irrelevant);
      if (hiddenObsolete > 0) entry.hiddenObsoleteLinks = hiddenObsolete;
      if (hiddenIrrelevant > 0) entry.hiddenIrrelevantLinks = hiddenIrrelevant;
    }
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

  /**
   * Follow the obsolete chain from an entry to its final valid correction.
   * Parses [✓ID] from level_1 of each obsolete entry and follows the chain.
   * Returns the final (non-obsolete) entry ID and the full chain of IDs traversed.
   */
  private resolveObsoleteChain(id: string): { finalId: string; chain: string[] } {
    const chain: string[] = [id];
    let currentId = id;
    const visited = new Set<string>();

    for (let i = 0; i < 10; i++) { // max 10 hops
      visited.add(currentId);
      const row = this.db.prepare(
        "SELECT id, level_1, obsolete FROM memories WHERE id = ?"
      ).get(currentId) as any;
      if (!row || !row.obsolete) break; // not obsolete or not found → stop

      // Parse [✓ID] from level_1
      const match = row.level_1?.match(/\[✓([A-Z]\d{4}(?:\.\d+)*)\]/);
      if (!match) break; // no correction reference → stop

      const nextId = match[1];
      if (visited.has(nextId)) break; // cycle detected → stop

      chain.push(nextId);
      currentId = nextId;
    }

    return { finalId: currentId, chain };
  }

  /** Fetch direct children of a node (root or compound), including their grandchild counts. */
  /** Bulk-fetch direct child counts for multiple parent IDs in one query. */
  private bulkChildCount(parentIds: string[]): Map<string, number> {
    if (parentIds.length === 0) return new Map();
    const placeholders = parentIds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT parent_id, COUNT(*) as cnt FROM memory_nodes WHERE parent_id IN (${placeholders}) AND COALESCE(irrelevant, 0) != 1 GROUP BY parent_id`
    ).all(...parentIds) as any[];
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.parent_id, r.cnt);
    return map;
  }

  /**
   * Time-weighted access score: newer entries with fewer accesses can outrank
   * older entries with more accesses. Uses logarithmic age decay:
   *   score = access_count / log2(age_in_days + 2)
   */
  private weightedAccessScore(row: { access_count: number; created_at: string }): number {
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    const ageDays = Math.max(ageMs / 86_400_000, 0);
    return (row.access_count || 0) / Math.log2(ageDays + 2);
  }

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
      title: row.title ?? this.autoExtractTitle(row.content),
      content: row.content,
      created_at: row.created_at,
      access_count: row.access_count || 0,
      last_accessed: row.last_accessed || null,
      favorite: row.favorite === 1 ? true : undefined,
      irrelevant: row.irrelevant === 1 ? true : undefined,
      child_count: childCount,
    };
  }

  private rowToEntry(row: any, children?: MemoryNode[]): MemoryEntry {
    return {
      id: row.id,
      prefix: row.prefix,
      seq: row.seq,
      created_at: row.created_at,
      title: row.title ?? this.autoExtractTitle(row.level_1),
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
      irrelevant: row.irrelevant === 1,
      pinned: row.pinned === 1,
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
      title: node.title,
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
   * Auto-extract a short title from text.
   * Priority: text before " — " > word-boundary truncation > hard truncation.
   */
  private autoExtractTitle(text: string): string {
    const maxLen = Math.floor(this.cfg.maxTitleChars * HmemStore.CHAR_LIMIT_TOLERANCE);
    const dashIdx = text.indexOf(" — ");
    if (dashIdx > 0 && dashIdx <= maxLen) return text.substring(0, dashIdx);
    if (text.length <= maxLen) return text;
    // Truncate at last word boundary before maxLen
    const lastSpace = text.lastIndexOf(" ", maxLen);
    if (lastSpace > maxLen * 0.4) return text.substring(0, lastSpace);
    return text.substring(0, maxLen);
  }

  /**
   * Parse tab-indented content into title + L1 text + a list of tree nodes.
   *
   * Title extraction:
   *   - 2+ non-indented lines: first line = explicit title, rest = level_1
   *   - 1 non-indented line: title = auto-extracted (~30 chars), level_1 = full line
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
    title: string;
    level1: string;
    nodes: Array<{ id: string; parent_id: string; depth: number; seq: number; content: string; title: string }>;
  } {
    const seqAtParent = new Map<string, number>();
    const lastIdAtDepth = new Map<number, string>();
    const nodes: Array<{ id: string; parent_id: string; depth: number; seq: number; content: string; title: string }> = [];

    const l1Lines: string[] = [];

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
        l1Lines.push(text);
        continue;
      }

      // L2+: determine parent and generate compound ID
      const parentId = depth === 2 ? rootId : (lastIdAtDepth.get(depth - 1) ?? rootId);
      const seq = (seqAtParent.get(parentId) ?? 0) + 1;
      seqAtParent.set(parentId, seq);
      const nodeId = `${parentId}.${seq}`;
      lastIdAtDepth.set(depth, nodeId);

      nodes.push({ id: nodeId, parent_id: parentId, depth, seq, content: text, title: this.autoExtractTitle(text) });
    }

    // Title: first L1 line (explicit). Content: remaining L1 lines joined.
    // If only 1 L1 line: title is auto-extracted, level1 = full line.
    let title: string;
    let level1: string;
    if (l1Lines.length >= 2) {
      title = l1Lines[0];
      level1 = l1Lines.slice(1).join(" | ");
    } else {
      level1 = l1Lines[0] ?? "";
      title = this.autoExtractTitle(level1);
    }

    return { title, level1, nodes };
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
 * Open (or create) the shared company knowledge store (company.hmem).
 */
export function openCompanyMemory(projectDir: string, config?: HmemConfig): HmemStore {
  const hmemPath = path.join(projectDir, "company.hmem");
  return new HmemStore(hmemPath, config);
}

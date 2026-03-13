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
  /** True if this entry is actively relevant (root-only). When any entry in a prefix has active=1, only active entries of that prefix are expanded in bulk reads. */
  active?: boolean;
  /** True if this entry was already delivered in a previous bulk read (session cache). */
  suppressed?: boolean;
  /**
   * Set by bulk reads to indicate why this entry received extra depth inline.
   * 'favorite' = favorite flag set, 'access' = top-N by access_count.
   * Rendered as [♥] or [★] in output.
   */
  promoted?: "access" | "favorite" | "subnode";
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
  /** Show entries not accessed in the last N days (stale detection). Sorted oldest-access first. */
  staleDays?: number;
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

CREATE VIRTUAL TABLE IF NOT EXISTS hmem_fts USING fts5(
    level_1,
    node_content,
    content='',
    tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS hmem_fts_rowid_map (
    fts_rowid INTEGER PRIMARY KEY,
    root_id   TEXT NOT NULL,
    node_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_fts_rm_root ON hmem_fts_rowid_map(root_id);
CREATE INDEX IF NOT EXISTS idx_fts_rm_node ON hmem_fts_rowid_map(node_id);

CREATE TRIGGER IF NOT EXISTS hmem_fts_mem_ai
AFTER INSERT ON memories
WHEN new.seq > 0
BEGIN
    INSERT INTO hmem_fts(level_1, node_content) VALUES (coalesce(new.level_1, ''), '');
    INSERT INTO hmem_fts_rowid_map(fts_rowid, root_id, node_id)
        VALUES (last_insert_rowid(), new.id, NULL);
END;

CREATE TRIGGER IF NOT EXISTS hmem_fts_node_ai
AFTER INSERT ON memory_nodes
BEGIN
    INSERT INTO hmem_fts(level_1, node_content) VALUES ('', coalesce(new.content, ''));
    INSERT INTO hmem_fts_rowid_map(fts_rowid, root_id, node_id)
        VALUES (last_insert_rowid(), new.root_id, new.id);
END;

CREATE TRIGGER IF NOT EXISTS hmem_fts_mem_au
AFTER UPDATE OF level_1 ON memories
WHEN new.seq > 0
BEGIN
    INSERT INTO hmem_fts(hmem_fts, rowid, level_1, node_content)
        VALUES ('delete', (SELECT fts_rowid FROM hmem_fts_rowid_map WHERE root_id = old.id AND node_id IS NULL), old.level_1, '');
    INSERT INTO hmem_fts(level_1, node_content) VALUES (coalesce(new.level_1, ''), '');
    UPDATE hmem_fts_rowid_map SET fts_rowid = last_insert_rowid()
        WHERE root_id = new.id AND node_id IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS hmem_fts_mem_bd
BEFORE DELETE ON memories
BEGIN
    INSERT INTO hmem_fts(hmem_fts, rowid, level_1, node_content)
        VALUES ('delete', (SELECT fts_rowid FROM hmem_fts_rowid_map WHERE root_id = old.id AND node_id IS NULL), old.level_1, '');
    DELETE FROM hmem_fts_rowid_map WHERE root_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS hmem_fts_node_bd
BEFORE DELETE ON memory_nodes
BEGIN
    INSERT INTO hmem_fts(hmem_fts, rowid, level_1, node_content)
        VALUES ('delete', (SELECT fts_rowid FROM hmem_fts_rowid_map WHERE node_id = old.id), '', old.content);
    DELETE FROM hmem_fts_rowid_map WHERE node_id = old.id;
END;
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
  // Sync support: track last content modification (separate from last_accessed)
  "ALTER TABLE memories ADD COLUMN updated_at TEXT",
  "ALTER TABLE memory_nodes ADD COLUMN updated_at TEXT",
  // Active flag: marks entries as currently relevant — non-active entries in same prefix shown title-only
  "ALTER TABLE memories ADD COLUMN active INTEGER DEFAULT 0",
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
    this.migrateFts5();
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
      INSERT INTO memories (id, prefix, seq, created_at, updated_at, title, level_1, level_2, level_3, level_4, level_5, links, min_role, favorite, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
    `);

    const insertNode = this.db.prepare(`
      INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Tags are mandatory — at least 1 required for discoverability
    if (!tags || tags.length === 0) {
      throw new Error("Tags are required. Provide at least 1 tag (3+ recommended) for discoverability. Example: tags=['#hmem', '#sqlite', '#bug']");
    }
    const validatedTags = this.validateTags(tags);

    // Run in a transaction
    this.db.transaction(() => {
      insertRoot.run(
        rootId, prefix, seq, timestamp, timestamp,
        title, level1,
        links ? JSON.stringify(links) : null,
        minRole,
        favorite ? 1 : 0,
        pinned ? 1 : 0
      );
      for (const node of nodes) {
        insertNode.run(node.id, node.parent_id, rootId, node.depth, node.seq, node.title, node.content, timestamp, timestamp);
      }
      if (validatedTags.length > 0) {
        if (nodes.length > 0) {
          // Tags go on first child node — L1 is always visible in bulk reads,
          // so root-level tags add no discovery value. Sub-node tags power findRelated.
          this.setTags(nodes[0].id, validatedTags);
        } else {
          // Leaf entry (no children): tags go on root — only place available.
          this.setTags(rootId, validatedTags);
        }
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
        // Related entries: aggregate tags from root + all loaded child nodes,
        // so sub-node tags (set by agents on specific sessions/features) also
        // contribute to related-entry discovery — not just the sparse root tags.
        const aggregatedTags = new Set<string>(entry.tags ?? []);
        for (const id of allIds) {
          const t = tagMap.get(id);
          if (t) t.forEach(tag => aggregatedTags.add(tag));
        }
        if (aggregatedTags.size >= 2) {
          entry.relatedEntries = this.findRelated(opts.id, [...aggregatedTags], 5);
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

    // Full-text search across memories + memory_nodes (FTS5)
    if (opts.search) {
      const searchTerm = opts.search.replace(/"/g, "").trim();
      if (!searchTerm) return [];

      // FTS5 phrase match — all words must appear in the text
      const ftsMatch = `"${searchTerm}"`;
      const ftsRootIds = new Set(
        (this.db.prepare(
          "SELECT DISTINCT root_id FROM hmem_fts_rowid_map WHERE fts_rowid IN (SELECT rowid FROM hmem_fts WHERE hmem_fts MATCH ?)"
        ).all(ftsMatch) as any[]).map(r => r.root_id)
      );

      // Also search tags (e.g. search="#hmem" matches tag "#hmem")
      const tagPattern = `%${opts.search}%`;
      const tagRows = this.db.prepare(
        "SELECT entry_id FROM memory_tags WHERE tag LIKE ?"
      ).all(tagPattern) as any[];
      for (const row of tagRows) {
        const eid = row.entry_id as string;
        ftsRootIds.add(eid.includes(".") ? eid.split(".")[0] : eid);
      }

      if (ftsRootIds.size === 0) return [];

      const idPlaceholders = [...ftsRootIds].map(() => "?").join(", ");
      const baseWhere = `id IN (${idPlaceholders}) AND seq > 0`;
      const where = roleFilter.sql ? `WHERE ${baseWhere} AND ${roleFilter.sql}` : `WHERE ${baseWhere}`;
      const limitClause = limit !== undefined ? ` LIMIT ${limit}` : "";

      const rows = this.db.prepare(
        `SELECT * FROM memories ${where} ORDER BY created_at DESC${limitClause}`
      ).all(...ftsRootIds, ...roleFilter.params) as any[];

      for (const row of rows) this.bumpAccess(row.id);
      return rows.map(r => this.rowToEntry(r));
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

    // Stale detection: entries not accessed in the last N days.
    // Entries with more sub-nodes than average are considered "actively developed"
    // and excluded from stale results (they stay relevant regardless of last access).
    if (opts.staleDays && opts.staleDays > 0) {
      const cutoff = `-${opts.staleDays} days`;
      conditions.push("(last_accessed IS NULL OR last_accessed < datetime('now', ?))");
      params.push(cutoff);
      conditions.push(
        "(SELECT COUNT(*) FROM memory_nodes WHERE root_id = m.id)" +
        " < (SELECT AVG(cnt) FROM (SELECT COUNT(*) AS cnt FROM memory_nodes GROUP BY root_id))"
      );
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Sort by effective_date: the most recent of root created_at OR latest child node created_at.
    // For stale queries: sort by oldest access first (most stale first).
    const staleSort = opts.staleDays
      ? "COALESCE(m.last_accessed, m.created_at) ASC"
      : "effective_date DESC";
    const limitClause = limit !== undefined ? `LIMIT ${limit}` : "";
    const rows = this.db.prepare(`
      SELECT m.*,
        COALESCE(
          (SELECT MAX(n.created_at) FROM memory_nodes n WHERE n.root_id = m.id),
          m.created_at
        ) AS effective_date
      FROM memories m
      ${where}
      ORDER BY ${staleSort}
      ${limitClause}
    `).all(...params) as any[];

    if (opts.prefix || opts.after || opts.before || opts.staleDays) {
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

    // Step 0.5: Detect active-prefixes — prefixes where at least one entry has active=1.
    // Non-active entries in these prefixes are still shown (as compact titles) but don't get expansion slots.
    const activePrefixes = new Set<string>();
    for (const r of activeRows) {
      if (r.active === 1) activePrefixes.add(r.prefix);
    }

    // Step 0.6: Cascading related-suppression — entries in OTHER prefixes that are thematically
    // related ONLY to suppressed (non-active) entries get demoted to title-only too.
    // Logic: collect tags from non-active entries, subtract tags from active entries,
    // then find entries in other prefixes that share ONLY the remaining "suppressed" tags.
    const relatedSuppressed = new Set<string>();
    if (activePrefixes.size > 0) {
      const activeEntryIds: string[] = [];
      const nonActiveEntryIds: string[] = [];
      for (const r of activeRows) {
        if (activePrefixes.has(r.prefix)) {
          if (r.active === 1) activeEntryIds.push(r.id);
          else nonActiveEntryIds.push(r.id);
        }
      }
      if (nonActiveEntryIds.length > 0 && activeEntryIds.length > 0) {
        // Fetch tags for active and non-active entries (root-level tags + child tags)
        const activeTagRows = activeEntryIds.length > 0
          ? this.db.prepare(
              `SELECT DISTINCT tag FROM memory_tags WHERE ${activeEntryIds.map(() => "entry_id = ? OR entry_id LIKE ?").join(" OR ")}`
            ).all(...activeEntryIds.flatMap(id => [id, `${id}.%`])) as { tag: string }[]
          : [];
        const activeTags = new Set(activeTagRows.map(r => r.tag));

        const nonActiveTagRows = this.db.prepare(
          `SELECT DISTINCT tag FROM memory_tags WHERE ${nonActiveEntryIds.map(() => "entry_id = ? OR entry_id LIKE ?").join(" OR ")}`
        ).all(...nonActiveEntryIds.flatMap(id => [id, `${id}.%`])) as { tag: string }[];
        // Suppressed tags = tags that appear in non-active entries but NOT in active entries
        const suppressedTags = nonActiveTagRows.map(r => r.tag).filter(t => !activeTags.has(t));

        if (suppressedTags.length > 0) {
          // Find root entries in OTHER prefixes that have ONLY suppressed tags (no active tags)
          const prefixList = [...activePrefixes];
          const otherEntries = activeRows.filter(r => !activePrefixes.has(r.prefix) && r.obsolete !== 1);
          if (otherEntries.length > 0) {
            const otherIds = otherEntries.map(r => r.id);
            const otherTagMap = this.fetchTagsBulk(otherIds);
            // Also fetch child tags for better coverage
            const otherChildIds = otherIds.flatMap(id => {
              const children = this.db.prepare(
                "SELECT id FROM memory_nodes WHERE root_id = ?"
              ).all(id) as { id: string }[];
              return children.map(c => c.id);
            });
            const childTagMap = otherChildIds.length > 0 ? this.fetchTagsBulk(otherChildIds) : new Map<string, string[]>();
            // Merge child tags into parent
            for (const e of otherEntries) {
              const rootTags = otherTagMap.get(e.id) ?? [];
              const childNodes = this.db.prepare(
                "SELECT id FROM memory_nodes WHERE root_id = ?"
              ).all(e.id) as { id: string }[];
              const allTags = new Set(rootTags);
              for (const cn of childNodes) {
                const ct = childTagMap.get(cn.id);
                if (ct) ct.forEach(t => allTags.add(t));
              }
              if (allTags.size === 0) continue;
              // Check: does this entry have ANY active tags?
              const hasActiveTags = [...allTags].some(t => activeTags.has(t));
              const hasSuppressedTags = [...allTags].some(t => suppressedTags.includes(t));
              // Only suppress if entry shares suppressed tags but NO active tags
              if (hasSuppressedTags && !hasActiveTags) {
                relatedSuppressed.add(e.id);
              }
            }
          }
        }
      }
    }

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
    for (const [prefix, prefixRows] of byPrefix) {
      // In active-prefixes, only active entries compete for expansion slots.
      // Related-suppressed entries in OTHER prefixes also don't compete.
      const candidateRows = activePrefixes.has(prefix)
        ? prefixRows.filter(r => r.active === 1)
        : prefixRows.filter(r => !relatedSuppressed.has(r.id));

      const { newestCount, accessCount } = this.calcV2Slots(candidateRows.length, isEssentials, fraction);

      // Newest: skip cached AND hidden entries, fill from fresh entries only
      const uncachedRows = candidateRows.filter(r => !cached.has(r.id) && !hidden.has(r.id));
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

    // Global: uncached+unhidden favorites/pinned + all active entries
    for (const r of nonObsoleteRows) {
      if ((r.favorite === 1 || r.pinned === 1) && !cached.has(r.id) && !hidden.has(r.id)) {
        // In active-prefixes, only active entries get expansion even if favorite/pinned
        if (!activePrefixes.has(r.prefix) || r.active === 1) {
          // Related-suppressed entries don't get expansion even if favorite/pinned
          if (!relatedSuppressed.has(r.id)) {
            expandedIds.add(r.id);
          }
        }
      }
      if (r.active === 1) {
        expandedIds.add(r.id);
      }
    }

    // Top-subnode: entries with the most sub-nodes (by count) always expanded
    const topSubnodeCount = v2.topSubnodeCount ?? 3;
    const topSubnodeIds = new Set<string>();
    if (topSubnodeCount > 0) {
      const nodeCounts = this.db.prepare(
        "SELECT root_id, COUNT(*) as cnt FROM memory_nodes GROUP BY root_id ORDER BY cnt DESC LIMIT ?"
      ).all(topSubnodeCount) as { root_id: string; cnt: number }[];
      for (const row of nodeCounts) {
        if (!hidden.has(row.root_id)) {
          // In active-prefixes, don't expand non-active entries even if they have many sub-nodes
          const entryRow = nonObsoleteRows.find(r => r.id === row.root_id);
          if (entryRow && activePrefixes.has(entryRow.prefix) && entryRow.active !== 1) continue;
          // Related-suppressed entries don't get topSubnode expansion either
          if (relatedSuppressed.has(row.root_id)) continue;
          expandedIds.add(row.root_id);
          topSubnodeIds.add(row.root_id);
        }
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
    // - Non-active in active-prefixes: title-only
    // - Related-suppressed in other prefixes: title-only
    const expandedNonObsolete = nonObsoleteRows.filter(r => expandedIds.has(r.id));
    const cachedVisible = nonObsoleteRows.filter(r => cached.has(r.id) && !expandedIds.has(r.id) && !hidden.has(r.id));
    const nonActiveVisible = activePrefixes.size > 0
      ? nonObsoleteRows.filter(r => activePrefixes.has(r.prefix) && r.active !== 1 && !expandedIds.has(r.id) && !cached.has(r.id) && !hidden.has(r.id))
      : [];
    const relatedSuppressedVisible = relatedSuppressed.size > 0
      ? nonObsoleteRows.filter(r => relatedSuppressed.has(r.id) && !expandedIds.has(r.id) && !cached.has(r.id) && !hidden.has(r.id))
      : [];
    const visibleRows = [...expandedNonObsolete, ...cachedVisible, ...nonActiveVisible, ...relatedSuppressedVisible, ...visibleObsolete];
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
        else if (topSubnodeIds.has(r.id)) entry.promoted = "subnode";
        if (isExpanded) entry.expanded = true;
        if (hiddenCount !== undefined && hiddenCount > 0) entry.hiddenChildrenCount = hiddenCount;
        return entry;
      });
      this.assignBulkTags(entries);
      return entries;
    }

    const entries = visibleRows.map(r => {
      const isExpanded = expandedIds.has(r.id);
      let promoted: "access" | "favorite" | "subnode" | undefined;
      if (r.favorite === 1) promoted = "favorite";
      else if (topAccess.some(t => t.id === r.id)) promoted = "access";
      else if (topSubnodeIds.has(r.id)) promoted = "subnode";

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
  update(id: string, fields: Partial<Pick<MemoryEntry, "level_1" | "level_2" | "level_3" | "level_4" | "level_5" | "links" | "min_role" | "obsolete" | "favorite" | "irrelevant" | "active">>): boolean {
    this.guardCorrupted();
    const sets: string[] = [];
    const params: any[] = [];

    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      if (key === "links" && Array.isArray(val)) {
        params.push(JSON.stringify(val));
      } else if (key === "obsolete" || key === "favorite" || key === "irrelevant" || key === "active") {
        params.push(val ? 1 : 0);
      } else {
        params.push(val);
      }
    }
    if (sets.length === 0) return false;

    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
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
  updateNode(id: string, newContent: string, links?: string[], obsolete?: boolean, favorite?: boolean, curatorBypass?: boolean, irrelevant?: boolean, tags?: string[], pinned?: boolean, active?: boolean): boolean {
    this.guardCorrupted();
    const trimmed = newContent.trim();
    if (id.includes(".")) {
      // Sub-node in memory_nodes — check char limit for its depth
      const nodeRow = this.db.prepare("SELECT depth, content FROM memory_nodes WHERE id = ?").get(id) as any;
      if (!nodeRow) return false;
      const oldContent = nodeRow.content as string;
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
      if (sets.length === 0) {
        // Only tags to update — no SQL UPDATE needed
        if (tags !== undefined) {
          this.setTags(id, tags.length > 0 ? this.validateTags(tags) : []);
          return true;
        }
        return false;
      }
      const nodeUpdateTs = new Date().toISOString();
      sets.push("updated_at = ?");
      params.push(nodeUpdateTs);
      params.push(id);
      const result = this.db.prepare(`UPDATE memory_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      if (result.changes > 0) {
        // Sync FTS5: delete old row, insert updated content
        const mapRow = this.db.prepare(
          "SELECT fts_rowid FROM hmem_fts_rowid_map WHERE node_id = ?"
        ).get(id) as any;
        if (mapRow) {
          this.db.prepare(
            "INSERT INTO hmem_fts(hmem_fts, rowid, level_1, node_content) VALUES ('delete', ?, '', ?)"
          ).run(mapRow.fts_rowid, oldContent);
          this.db.prepare(
            "INSERT INTO hmem_fts(level_1, node_content) VALUES (?, ?)"
          ).run('', trimmed);
          const newRowId = (this.db.prepare("SELECT last_insert_rowid() as r").get() as any).r;
          this.db.prepare(
            "UPDATE hmem_fts_rowid_map SET fts_rowid = ? WHERE node_id = ?"
          ).run(newRowId, id);
        }
        if (tags !== undefined) {
          this.setTags(id, tags.length > 0 ? this.validateTags(tags) : []);
        }
        // Bubble updated_at to root entry so sync can detect any change
        const rootId = id.split(".")[0];
        this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(nodeUpdateTs, rootId);
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

        // Rewrite all external links that reference the obsolete entry → point to correction
        this.rewriteLinksToObsolete(id, correctionId);

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
      if (active !== undefined) {
        sets.push("active = ?");
        params.push(active ? 1 : 0);
      }
      if (sets.length === 0) {
        // Only tags to update — no SQL UPDATE needed
        if (tags !== undefined) {
          this.setTags(id, tags.length > 0 ? this.validateTags(tags) : []);
          return true;
        }
        return false;
      }
      sets.push("updated_at = ?");
      params.push(new Date().toISOString());
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
      INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const topLevelIds: string[] = [];

    this.db.transaction(() => {
      for (const node of nodes) {
        insertNode.run(node.id, node.parent_id, rootId, node.depth, node.seq, this.autoExtractTitle(node.content), node.content, timestamp, timestamp);
        if (node.parent_id === parentId) topLevelIds.push(node.id);
      }
    })();

    // Mark root entry as updated (content changed)
    this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, rootId);

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
   * One-time migration: build FTS5 index from existing data.
   * Idempotent — tracked via schema_version key 'fts5_v1'.
   * For fresh DBs the triggers handle indexing; this migration covers pre-existing rows.
   */
  private migrateFts5(): void {
    const done = this.db.prepare(
      "SELECT value FROM schema_version WHERE key = 'fts5_v1'"
    ).get();
    if (done) return;

    const insertFts = this.db.prepare(
      "INSERT INTO hmem_fts(level_1, node_content) VALUES (?, ?)"
    );
    const insertMap = this.db.prepare(
      "INSERT INTO hmem_fts_rowid_map(fts_rowid, root_id, node_id) VALUES (?, ?, ?)"
    );
    const lastId = this.db.prepare("SELECT last_insert_rowid() as r");

    this.db.transaction(() => {
      const memRows = this.db.prepare(
        "SELECT id, level_1 FROM memories WHERE seq > 0"
      ).all() as any[];
      for (const row of memRows) {
        insertFts.run(row.level_1 ?? '', '');
        insertMap.run((lastId.get() as any).r, row.id, null);
      }

      const nodeRows = this.db.prepare(
        "SELECT id, root_id, content FROM memory_nodes"
      ).all() as any[];
      for (const row of nodeRows) {
        insertFts.run('', row.content ?? '');
        insertMap.run((lastId.get() as any).r, row.root_id, row.id);
      }

      this.db.prepare(
        "INSERT INTO schema_version (key, value) VALUES ('fts5_v1', 'done')"
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

  /**
   * Rewrite all external links that reference `obsoleteId` to point to `correctionId` instead.
   * Called automatically when an entry is marked obsolete with a [✓ID] correction reference.
   * Skips the obsolete entry itself and its correction (those are handled via addLink).
   */
  private rewriteLinksToObsolete(obsoleteId: string, correctionId: string): void {
    // Scan memories.links
    const memRows = this.db.prepare(
      "SELECT id, links FROM memories WHERE links IS NOT NULL AND links LIKE ?"
    ).all(`%"${obsoleteId}"%`) as { id: string; links: string }[];

    for (const row of memRows) {
      if (row.id === obsoleteId || row.id === correctionId) continue;
      try {
        const arr: string[] = JSON.parse(row.links);
        if (!arr.includes(obsoleteId)) continue;
        const updated = arr.map(l => l === obsoleteId ? correctionId : l);
        // Deduplicate (in case correctionId was already in the list)
        const deduped = [...new Set(updated)];
        this.db.prepare("UPDATE memories SET links = ? WHERE id = ?")
          .run(JSON.stringify(deduped), row.id);
      } catch { /* malformed JSON — skip */ }
    }

    // Scan memory_nodes.links
    const nodeRows = this.db.prepare(
      "SELECT id, links FROM memory_nodes WHERE links IS NOT NULL AND links LIKE ?"
    ).all(`%"${obsoleteId}"%`) as { id: string; links: string }[];

    for (const row of nodeRows) {
      try {
        const arr: string[] = JSON.parse(row.links);
        if (!arr.includes(obsoleteId)) continue;
        const updated = arr.map(l => l === obsoleteId ? correctionId : l);
        const deduped = [...new Set(updated)];
        this.db.prepare("UPDATE memory_nodes SET links = ? WHERE id = ?")
          .run(JSON.stringify(deduped), row.id);
      } catch { /* malformed JSON — skip */ }
    }
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
      active: row.active === 1,
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

  // ---- Stats, Health, Similarity, Bulk-Tags ----

  /** Return a statistical overview of the memory store. */
  getStats(): {
    totalEntries: number;
    byPrefix: Record<string, number>;
    totalNodes: number;
    favorites: number;
    pinned: number;
    mostAccessed: { id: string; title: string; access_count: number }[];
    oldestEntry: { id: string; created_at: string; title: string } | null;
    staleCount: number;
    uniqueTags: number;
    avgDepth: number;
  } {
    const totalEntries = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE seq > 0 AND irrelevant != 1"
    ).get() as any).cnt;

    const byPrefixRows = this.db.prepare(
      "SELECT prefix, COUNT(*) as cnt FROM memories WHERE seq > 0 AND irrelevant != 1 GROUP BY prefix ORDER BY prefix"
    ).all() as any[];
    const byPrefix: Record<string, number> = {};
    for (const r of byPrefixRows) byPrefix[r.prefix] = r.cnt;

    const totalNodes = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM memory_nodes WHERE irrelevant != 1"
    ).get() as any).cnt;

    const favorites = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE seq > 0 AND favorite = 1 AND irrelevant != 1"
    ).get() as any).cnt;

    const pinned = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE seq > 0 AND pinned = 1 AND irrelevant != 1"
    ).get() as any).cnt;

    const mostAccessedRows = this.db.prepare(
      "SELECT id, title, level_1, access_count FROM memories WHERE seq > 0 AND irrelevant != 1 ORDER BY access_count DESC LIMIT 5"
    ).all() as any[];

    const oldestRow = this.db.prepare(
      "SELECT id, title, level_1, created_at FROM memories WHERE seq > 0 AND irrelevant != 1 ORDER BY created_at ASC LIMIT 1"
    ).get() as any;

    const staleCount = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE seq > 0 AND irrelevant != 1 AND (last_accessed IS NULL OR last_accessed < datetime('now', '-30 days'))"
    ).get() as any).cnt;

    const uniqueTags = (this.db.prepare(
      "SELECT COUNT(DISTINCT tag) as cnt FROM memory_tags"
    ).get() as any).cnt;

    const avgDepth = totalEntries > 0 ? parseFloat((totalNodes / totalEntries).toFixed(1)) : 0;

    return {
      totalEntries,
      byPrefix,
      totalNodes,
      favorites,
      pinned,
      mostAccessed: mostAccessedRows.map(r => ({
        id: r.id,
        title: r.title || this.autoExtractTitle(r.level_1),
        access_count: r.access_count,
      })),
      oldestEntry: oldestRow ? {
        id: oldestRow.id,
        created_at: oldestRow.created_at.substring(0, 10),
        title: oldestRow.title || this.autoExtractTitle(oldestRow.level_1),
      } : null,
      staleCount,
      uniqueTags,
      avgDepth,
    };
  }

  /**
   * Find entries similar to the given entry via FTS5 keyword matching.
   * Extracts significant words from level_1, queries FTS5, returns up to `limit` results.
   */
  findRelatedCombined(entryId: string, limit: number = 5): { id: string; title: string; created_at: string; tags: string[]; matchType: "tags" | "fts" }[] {
    const results: { id: string; title: string; created_at: string; tags: string[]; matchType: "tags" | "fts" }[] = [];
    const seen = new Set<string>([entryId]);

    // Phase 1: tag-based matches.
    // Aggregate tags by intra-entry frequency: tags appearing on more sub-nodes of this
    // entry are more representative. Take top 8 to avoid hub entries with 16+ tags.
    const allNodeIds = [entryId, ...(
      this.db.prepare("SELECT id FROM memory_nodes WHERE root_id = ?").all(entryId) as any[]
    ).map((r: any) => r.id)];
    const placeholdersNodes = allNodeIds.map(() => "?").join(", ");
    const intraTags = (this.db.prepare(`
      SELECT tag FROM memory_tags
      WHERE entry_id IN (${placeholdersNodes})
      GROUP BY tag ORDER BY COUNT(*) DESC LIMIT 8
    `).all(...allNodeIds) as any[]).map((r: any) => r.tag as string);
    const aggregatedTags = new Set<string>(intraTags);

    if (aggregatedTags.size >= 1) {
      const tags = [...aggregatedTags];
      const placeholders = tags.map(() => "?").join(", ");
      // Scoring tiers:
      //   ≥2 shared tags → score 1000 + shared_count (always wins over rare singles)
      //   1 shared rare tag (freq ≤5) → score 100 (fills remaining slots)
      //   1 shared common tag → excluded
      const tagRows = this.db.prepare(`
        SELECT mt.entry_id, COUNT(*) as shared,
          MAX(CASE WHEN tf.freq <= 5 THEN 1 ELSE 0 END) as has_rare
        FROM memory_tags mt
        JOIN (SELECT tag, COUNT(DISTINCT entry_id) as freq FROM memory_tags GROUP BY tag) tf
          ON tf.tag = mt.tag
        WHERE mt.tag IN (${placeholders}) AND mt.entry_id != ? AND mt.entry_id NOT LIKE ? || '.%'
        GROUP BY mt.entry_id
        HAVING COUNT(*) >= 2 OR MAX(CASE WHEN tf.freq <= 5 THEN 1 ELSE 0 END) = 1
        ORDER BY (CASE WHEN COUNT(*) >= 2 THEN 1000 + COUNT(*) ELSE 100 END) DESC
        LIMIT ?
      `).all(...tags, entryId, entryId, limit * 4) as any[];

      for (const row of tagRows) {
        if (results.length >= limit) break;
        const eid = row.entry_id as string;
        const rootId = eid.includes(".") ? eid.split(".")[0] : eid;
        if (seen.has(rootId)) continue;
        seen.add(rootId);
        const rootRow = this.db.prepare("SELECT title, level_1, created_at, irrelevant, obsolete FROM memories WHERE id = ?").get(rootId) as any;
        if (!rootRow || rootRow.irrelevant === 1 || rootRow.obsolete === 1) continue;
        results.push({
          id: rootId,
          title: rootRow.title || this.autoExtractTitle(rootRow.level_1),
          created_at: rootRow.created_at.substring(0, 10),
          tags: this.fetchTags(rootId),
          matchType: "tags",
        });
      }
    }

    // Phase 2: FTS5 supplement — fill remaining slots
    if (results.length < limit) {
      const ftsResults = this.findRelatedByFts(entryId, (limit - results.length) * 2);
      for (const r of ftsResults) {
        if (results.length >= limit) break;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        results.push({ ...r, matchType: "fts" });
      }
    }

    return results;
  }

  findRelatedByFts(entryId: string, limit: number = 5): { id: string; title: string; created_at: string; tags: string[] }[] {
    const entry = this.db.prepare("SELECT level_1, title FROM memories WHERE id = ?").get(entryId) as any;
    if (!entry) return [];

    const STOPWORDS = new Set(["the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or", "but", "with", "by", "from", "was", "are", "been", "be", "it", "this", "that", "as", "not", "have", "has", "via", "der", "die", "das", "den", "dem", "des", "ein", "eine", "und", "oder", "mit", "von", "zu", "bei", "auf", "aus", "nach", "über", "für", "ist", "hat", "wird", "wurde"]);

    const words = (entry.level_1 || "")
      .replace(/[^a-zA-Z0-9äöüÄÖÜß\s-]/g, " ")
      .split(/\s+/)
      .filter((w: string) => w.length > 3 && !STOPWORDS.has(w.toLowerCase()))
      .slice(0, 6);

    if (words.length === 0) return [];

    // AND-first: top 3 words must all match → precise. OR fallback if no results.
    const andQuery = words.slice(0, 3).map((w: string) => `"${w.replace(/"/g, "")}"`).join(" ");
    const orQuery  = words.map((w: string) => `"${w.replace(/"/g, "")}"`).join(" OR ");

    const runFts = (query: string) => new Set(
      (this.db.prepare(
        "SELECT DISTINCT root_id FROM hmem_fts_rowid_map WHERE fts_rowid IN (SELECT rowid FROM hmem_fts WHERE hmem_fts MATCH ?)"
      ).all(query) as any[]).map((r: any) => r.root_id)
    );

    try {
      let ftsRootIds = words.length >= 2 ? runFts(andQuery) : runFts(orQuery);
      if (ftsRootIds.size === 0 && words.length >= 2) ftsRootIds = runFts(orQuery); // OR fallback
      ftsRootIds.delete(entryId);
      if (ftsRootIds.size === 0) return [];

      const idPlaceholders = [...ftsRootIds].map(() => "?").join(", ");
      const rows = this.db.prepare(
        `SELECT id, title, level_1, created_at FROM memories WHERE id IN (${idPlaceholders}) AND seq > 0 AND irrelevant != 1 AND obsolete != 1 LIMIT ?`
      ).all(...ftsRootIds, limit) as any[];

      return rows.map((r: any) => ({
        id: r.id,
        title: r.title || this.autoExtractTitle(r.level_1),
        created_at: r.created_at.substring(0, 10),
        tags: this.fetchTags(r.id),
      }));
    } catch {
      return [];
    }
  }

  /** Audit report: broken links, orphaned entries, stale favorites, broken obsolete chains, tag orphans. */
  healthCheck(): {
    brokenLinks: { id: string; title: string; brokenIds: string[] }[];
    orphanedEntries: { id: string; title: string; created_at: string }[];
    staleFavorites: { id: string; title: string; lastAccessed: string | null }[];
    brokenObsoleteChains: { id: string; title: string; badRef: string }[];
    tagOrphans: number;
  } {
    const result = {
      brokenLinks: [] as { id: string; title: string; brokenIds: string[] }[],
      orphanedEntries: [] as { id: string; title: string; created_at: string }[],
      staleFavorites: [] as { id: string; title: string; lastAccessed: string | null }[],
      brokenObsoleteChains: [] as { id: string; title: string; badRef: string }[],
      tagOrphans: 0,
    };

    // 1. Broken links
    const entriesWithLinks = this.db.prepare(
      "SELECT id, title, level_1, links FROM memories WHERE links IS NOT NULL AND links != '[]' AND seq > 0"
    ).all() as any[];
    for (const entry of entriesWithLinks) {
      let links: string[];
      try { links = JSON.parse(entry.links) || []; } catch { links = []; }
      const broken = links.filter((lid: string) => !this.db.prepare("SELECT 1 FROM memories WHERE id = ?").get(lid));
      if (broken.length > 0) {
        result.brokenLinks.push({
          id: entry.id,
          title: entry.title || this.autoExtractTitle(entry.level_1),
          brokenIds: broken,
        });
      }
    }

    // 2. Orphaned entries (no sub-nodes, not a header)
    const noChildRows = this.db.prepare(`
      SELECT m.id, m.title, m.level_1, m.created_at
      FROM memories m
      LEFT JOIN memory_nodes mn ON mn.root_id = m.id
      WHERE m.seq > 0 AND m.irrelevant != 1 AND mn.id IS NULL
      ORDER BY m.created_at ASC
      LIMIT 20
    `).all() as any[];
    result.orphanedEntries = noChildRows.map((r: any) => ({
      id: r.id,
      title: r.title || this.autoExtractTitle(r.level_1),
      created_at: r.created_at.substring(0, 10),
    }));

    // 3. Stale favorites/pinned (not accessed in 60 days)
    const staleFavRows = this.db.prepare(
      "SELECT id, title, level_1, last_accessed FROM memories WHERE seq > 0 AND (favorite = 1 OR pinned = 1) AND (last_accessed IS NULL OR last_accessed < datetime('now', '-60 days')) AND irrelevant != 1"
    ).all() as any[];
    result.staleFavorites = staleFavRows.map((r: any) => ({
      id: r.id,
      title: r.title || this.autoExtractTitle(r.level_1),
      lastAccessed: r.last_accessed ? r.last_accessed.substring(0, 10) : null,
    }));

    // 4. Broken obsolete chains: [✓ID] pointing to non-existent entry
    const obsoleteRows = this.db.prepare(
      "SELECT id, title, level_1 FROM memories WHERE obsolete = 1"
    ).all() as any[];
    for (const entry of obsoleteRows) {
      const match = (entry.level_1 || "").match(/\[✓([A-Z]\d+)\]/);
      if (match) {
        const targetId = match[1];
        if (!this.db.prepare("SELECT 1 FROM memories WHERE id = ?").get(targetId)) {
          result.brokenObsoleteChains.push({
            id: entry.id,
            title: entry.title || this.autoExtractTitle(entry.level_1),
            badRef: targetId,
          });
        }
      }
    }

    // 5. Tag orphans: memory_tags rows pointing to deleted entries/nodes
    result.tagOrphans = (this.db.prepare(`
      SELECT COUNT(*) as cnt FROM memory_tags mt
      WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = mt.entry_id)
      AND NOT EXISTS (SELECT 1 FROM memory_nodes WHERE id = mt.entry_id)
    `).get() as any).cnt;

    return result;
  }

  /**
   * Apply tag changes (add/remove) to all entries matching a filter.
   * Returns the number of entries modified.
   */
  tagBulk(
    filter: { prefix?: string; search?: string; tag?: string },
    addTags?: string[],
    removeTags?: string[]
  ): number {
    if (!addTags?.length && !removeTags?.length) return 0;

    let entryIds: string[] = [];

    if (filter.tag) {
      entryIds = [...this.getRootIdsByTag(filter.tag.toLowerCase())];
    } else {
      const conditions = ["seq > 0", "irrelevant != 1"];
      const params: any[] = [];
      if (filter.prefix) {
        conditions.push("prefix = ?");
        params.push(filter.prefix.toUpperCase());
      }
      if (filter.search) {
        const searchTerm = filter.search.replace(/"/g, "").trim();
        try {
          const ftsRootIds = new Set(
            (this.db.prepare(
              "SELECT DISTINCT root_id FROM hmem_fts_rowid_map WHERE fts_rowid IN (SELECT rowid FROM hmem_fts WHERE hmem_fts MATCH ?)"
            ).all(`"${searchTerm}"`) as any[]).map((r: any) => r.root_id)
          );
          if (ftsRootIds.size === 0) return 0;
          conditions.push(`id IN (${[...ftsRootIds].map(() => "?").join(",")})`);
          params.push(...ftsRootIds);
        } catch {
          return 0;
        }
      }
      const rows = this.db.prepare(
        `SELECT id FROM memories WHERE ${conditions.join(" AND ")}`
      ).all(...params) as any[];
      entryIds = rows.map((r: any) => r.id);
    }

    if (entryIds.length === 0) return 0;

    const insertStmt = this.db.prepare("INSERT OR IGNORE INTO memory_tags(entry_id, tag) VALUES (?, ?)");
    const deleteStmt = this.db.prepare("DELETE FROM memory_tags WHERE entry_id = ? AND tag = ?");

    const applyAll = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        if (addTags) for (const tag of addTags) insertStmt.run(id, tag.toLowerCase());
        if (removeTags) for (const tag of removeTags) deleteStmt.run(id, tag.toLowerCase());
      }
    });
    applyAll(entryIds);

    return entryIds.length;
  }

  /**
   * Rename a tag across all entries and nodes.
   * Returns the number of rows updated.
   */
  tagRename(oldTag: string, newTag: string): number {
    const old = oldTag.toLowerCase();
    const nw = newTag.toLowerCase();
    if (old === nw) return 0;
    // Copy rows with new tag name, then delete the old ones
    this.db.prepare(
      "INSERT OR IGNORE INTO memory_tags(entry_id, tag) SELECT entry_id, ? FROM memory_tags WHERE tag = ?"
    ).run(nw, old);
    const result = this.db.prepare("DELETE FROM memory_tags WHERE tag = ?").run(old);
    return result.changes;
  }

  /**
   * Move a sub-node (and its entire subtree) to a different parent.
   * sourceId must be a sub-node (e.g. "P0029.15"), not a root entry.
   * targetParentId can be a root (e.g. "L0074") or a sub-node (e.g. "P0029.20").
   * All IDs in links and [✓ID] content references are updated automatically.
   */
  moveNode(sourceId: string, targetParentId: string): { moved: number; newId: string; idMap: Record<string, string> } {
    this.guardCorrupted();

    if (!sourceId.includes(".")) {
      throw new Error(`Cannot move root entry "${sourceId}" — only sub-nodes can be moved.`);
    }

    const sourceNode = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(sourceId) as any;
    if (!sourceNode) throw new Error(`Source node "${sourceId}" not found.`);

    const targetIsRoot = !targetParentId.includes(".");
    if (targetIsRoot) {
      if (!this.db.prepare("SELECT id FROM memories WHERE id = ?").get(targetParentId)) {
        throw new Error(`Target parent "${targetParentId}" not found.`);
      }
    } else {
      if (!this.db.prepare("SELECT id FROM memory_nodes WHERE id = ?").get(targetParentId)) {
        throw new Error(`Target parent "${targetParentId}" not found.`);
      }
    }

    if (targetParentId === sourceId || targetParentId.startsWith(sourceId + ".")) {
      throw new Error(`Cannot move "${sourceId}" into its own subtree.`);
    }

    // Collect subtree (source + all descendants), ordered by depth then seq
    const subtree = this.db.prepare(
      "SELECT * FROM memory_nodes WHERE id = ? OR id LIKE ? ORDER BY depth, seq"
    ).all(sourceId, sourceId + ".%") as any[];

    // Compute new root, seq, depth for the source node
    const newRootId = targetIsRoot ? targetParentId : targetParentId.split(".")[0];
    const maxSeqRow = this.db.prepare(
      "SELECT MAX(seq) as maxSeq FROM memory_nodes WHERE parent_id = ?"
    ).get(targetParentId) as any;
    const newSeq = (maxSeqRow?.maxSeq ?? 0) + 1;
    const targetDepth = targetIsRoot ? 1 : (targetParentId.match(/\./g)!.length + 1);
    const newSourceDepth = targetDepth + 1;
    const depthOffset = newSourceDepth - sourceNode.depth;
    const newSourceId = `${targetParentId}.${newSeq}`;

    // Build ID map: replace sourceId prefix with newSourceId for all nodes in subtree
    const idMap = new Map<string, string>();
    for (const node of subtree) {
      idMap.set(node.id, newSourceId + node.id.substring(sourceId.length));
    }

    const remapLinks = (linksJson: string | null): string | null => {
      if (!linksJson) return linksJson;
      try {
        const links: string[] = JSON.parse(linksJson);
        return JSON.stringify(links.map(l => idMap.get(l) ?? l));
      } catch { return linksJson; }
    };

    this.db.transaction(() => {
      const insertNode = this.db.prepare(`
        INSERT INTO memory_nodes
          (id, parent_id, root_id, depth, seq, title, content, created_at,
           access_count, last_accessed, favorite, secret, irrelevant, links, obsolete)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const node of subtree) {
        const newId = idMap.get(node.id)!;
        const newParentId = node.id === sourceId
          ? targetParentId
          : (idMap.get(node.parent_id) ?? node.parent_id);
        const newDepth = node.depth + depthOffset;
        const nodeSeq = node.id === sourceId ? newSeq : node.seq;

        // Remap [✓ID] content references within the subtree
        let newContent = node.content as string | null;
        if (newContent) {
          for (const [oldId, mappedId] of idMap) {
            newContent = newContent.split(oldId).join(mappedId);
          }
        }

        insertNode.run(
          newId, newParentId, newRootId, newDepth, nodeSeq,
          node.title, newContent, node.created_at,
          node.access_count ?? 0, node.last_accessed,
          node.favorite ?? 0, node.secret ?? 0, node.irrelevant ?? 0,
          remapLinks(node.links), node.obsolete ?? 0,
        );
      }

      // Delete old nodes
      const oldIds = subtree.map(n => n.id);
      const ph = oldIds.map(() => "?").join(",");
      (this.db.prepare(`DELETE FROM memory_nodes WHERE id IN (${ph})`) as any).run(...oldIds);

      // Update FTS rowid map
      for (const [oldId, newId] of idMap) {
        this.db.prepare(
          "UPDATE hmem_fts_rowid_map SET node_id = ? WHERE node_id = ?"
        ).run(newId, oldId);
      }

      // Update external references in other nodes (links JSON)
      const extNodes = this.db.prepare(
        "SELECT id, links FROM memory_nodes WHERE links IS NOT NULL"
      ).all() as any[];
      const updNodeLinks = this.db.prepare("UPDATE memory_nodes SET links = ? WHERE id = ?");
      for (const ext of extNodes) {
        const remapped = remapLinks(ext.links);
        if (remapped !== ext.links) updNodeLinks.run(remapped, ext.id);
      }

      // Update external references in root entries (links JSON)
      const extRoots = this.db.prepare(
        "SELECT id, links FROM memories WHERE links IS NOT NULL AND seq > 0"
      ).all() as any[];
      const updRootLinks = this.db.prepare("UPDATE memories SET links = ? WHERE id = ?");
      for (const ext of extRoots) {
        const remapped = remapLinks(ext.links);
        if (remapped !== ext.links) updRootLinks.run(remapped, ext.id);
      }

      // Update [✓ID] references in content of other nodes and roots
      for (const [oldId, newId] of idMap) {
        this.db.prepare(
          "UPDATE memory_nodes SET content = REPLACE(content, ?, ?) WHERE content LIKE ?"
        ).run(oldId, newId, `%${oldId}%`);
        this.db.prepare(
          "UPDATE memories SET level_1 = REPLACE(level_1, ?, ?) WHERE level_1 LIKE ?"
        ).run(oldId, newId, `%${oldId}%`);
      }
    })();

    return { moved: subtree.length, newId: newSourceId, idMap: Object.fromEntries(idMap) };
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

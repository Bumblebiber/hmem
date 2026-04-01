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
 * Each entry has a min_role column (kept in DB, no longer used for filtering).
 *
 * read_memory(id) semantics:
 *   Always returns the node + its DIRECT children only.
 *   To go deeper, call read_memory(id=child_id).
 *   depth parameter is IGNORED for ID-based queries.
 */

import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
  /** ISO timestamp of last modification (write/update/append). Used for sync status. */
  updated_at?: string;
  /** True if this entry was already delivered in a previous bulk read (session cache). */
  suppressed?: boolean;
  /**
   * Set by bulk reads to indicate why this entry received extra depth inline.
   * 'favorite' = favorite flag set, 'access' = top-N by access_count.
   * Rendered as [♥] or [★] in output.
   */
  promoted?: "access" | "favorite" | "subnode" | "task";
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
  updated_at?: string;
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
  /** @deprecated No longer used — role filtering removed. Kept for API compat. */
  agentRole?: AgentRole;
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
  /** Find all entries related to a given entry via per-node tag scoring + direct links. */
  contextFor?: string;
  /** Minimum weighted tag score for context_for matches. Default: 4. Tier weights: rare(<=5)=3, medium(6-20)=2, common(>20)=1. */
  minTagScore?: number;
  /** Bypass V2 selection, project gate, and session cache — return all matching rows directly. Used for explicit filters (after, before, prefix, tag, stale_days). */
  directResults?: boolean;
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

// (limits are now instance-level via this.cfg.maxCharsPerLevel)

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
  // Links: JSON array of related entry IDs (cross-references between entries)
  "ALTER TABLE memories ADD COLUMN links TEXT",
];

// ---- HmemStore class ----

export class HmemStore {
  public db: Database.Database;
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

    // Process any pending exchanges queued by hooks that couldn't open the DB
    // (e.g. Windows WAL locking). Cheap no-op when no pending file exists.
    try { this.processPendingExchanges(); } catch { /* non-critical */ }
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
  write(prefix: string, content: string, links?: string[], _minRole?: AgentRole, favorite?: boolean, tags?: string[], pinned?: boolean, force?: boolean): WriteResult {
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
    // Only check title length for the L1 limit — body lines (>) are stored separately
    // and hidden in listings, so they don't affect display compactness
    if (title.length > l1Limit * t) {
      throw new Error(`Level 1 title exceeds ${l1Limit} character limit (${title.length} chars). Keep the title compact and move detail to body lines (> prefix) or L2 children.`);
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

    // Duplicate detection: check for existing entries with significant tag overlap
    if (prefix !== "O" && !force) { // O-entries are auto-generated, skip check
      const tagPlaceholders = validatedTags.map(() => "?").join(", ");
      const overlapRows = this.db.prepare(`
        SELECT
          CASE WHEN mt.entry_id LIKE '%.%'
          THEN SUBSTR(mt.entry_id, 1, INSTR(mt.entry_id, '.') - 1)
          ELSE mt.entry_id END as root_id,
          COUNT(DISTINCT mt.tag) as shared
        FROM memory_tags mt
        JOIN memories m ON m.id = (
          CASE WHEN mt.entry_id LIKE '%.%'
          THEN SUBSTR(mt.entry_id, 1, INSTR(mt.entry_id, '.') - 1)
          ELSE mt.entry_id END
        )
        WHERE mt.tag IN (${tagPlaceholders})
          AND m.prefix = ?
          AND m.obsolete != 1
          AND m.irrelevant != 1
        GROUP BY root_id
        HAVING shared >= 2
        ORDER BY shared DESC
        LIMIT 3
      `).all(...validatedTags, prefix) as { root_id: string; shared: number }[];

      // Phase 2: FTS5 title similarity (fallback for entries with different tags)
      let ftsMatches: { root_id: string; title: string }[] = [];
      if (overlapRows.length === 0) {
        const words = level1.replace(/[^a-zA-Z0-9äöüÄÖÜß\s-]/g, " ")
          .split(/\s+/)
          .filter(w => w.length > 3)
          .slice(0, 4);
        if (words.length >= 2) {
          try {
            const andQuery = words.join(" AND ");
            const ftsHits = this.db.prepare(`
              SELECT rm.root_id FROM hmem_fts_rowid_map rm
              JOIN hmem_fts f ON f.rowid = rm.fts_rowid
              WHERE hmem_fts MATCH ? LIMIT 5
            `).all(andQuery) as { root_id: string }[];
            const seen = new Set<string>();
            for (const hit of ftsHits) {
              if (seen.has(hit.root_id)) continue;
              seen.add(hit.root_id);
              const row = this.db.prepare(
                "SELECT id, title, prefix FROM memories WHERE id = ? AND prefix = ? AND obsolete != 1 AND irrelevant != 1"
              ).get(hit.root_id, prefix) as any;
              if (row) ftsMatches.push({ root_id: row.id, title: row.title });
            }
          } catch { /* FTS5 might not exist */ }
        }
      }

      if (overlapRows.length > 0 || ftsMatches.length > 0) {
        const parts: string[] = [];
        if (overlapRows.length > 0) {
          const tagHits = overlapRows.map(r => {
            const row = this.db.prepare("SELECT title FROM memories WHERE id = ?").get(r.root_id) as any;
            return `  ${r.root_id} (${r.shared}/${validatedTags.length} shared tags) ${row?.title ?? ""}`;
          }).join("\n");
          parts.push(`Tag overlap:\n${tagHits}`);
        }
        if (ftsMatches.length > 0) {
          const ftsHits = ftsMatches.map(r => `  ${r.root_id} ${r.title}`).join("\n");
          parts.push(`Similar titles:\n${ftsHits}`);
        }
        const bestMatch = overlapRows[0]?.root_id ?? ftsMatches[0]?.root_id;
        throw new Error(
          `Similar ${prefix}-entries already exist:\n${parts.join("\n")}\n\n` +
          `If this belongs to an existing entry, use: append_memory(id="${bestMatch}", content="...")\n` +
          `If this is intentionally a NEW entry, retry with: force=true`
        );
      }
    }

    // Run in a transaction
    this.db.transaction(() => {
      insertRoot.run(
        rootId, prefix, seq, timestamp, timestamp,
        title, level1,
        links ? JSON.stringify(links) : null,
        "worker",
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
      // Auto-activate new P-entries (deactivate others first)
      if (prefix === "P") {
        this.db.prepare("UPDATE memories SET active = 0 WHERE prefix = 'P' AND active = 1").run();
        this.db.prepare("UPDATE memories SET active = 1 WHERE id = ?").run(rootId);
      }
    })();

    return { id: rootId, timestamp };
  }

  /**
   * Write a linear entry with explicit content at each level (no tree branching).
   * Used by flush_context for O-prefix entries. Each level is a single node forming
   * a straight chain: root → .1 → .1.1 → .1.1.1 → .1.1.1.1
   *
   * Recommended usage: L1 (title) + L2 (paragraph summary) + L5 (raw text).
   * L3/L4 are optional intermediate detail levels.
   */
  writeLinear(
    prefix: string,
    levels: { l1: string; l2?: string; l3?: string; l4?: string; l5?: string },
    tags?: string[],
    links?: string[]
  ): WriteResult {
    this.guardCorrupted();
    prefix = prefix.toUpperCase();
    if (!this.cfg.prefixes[prefix]) {
      throw new Error(`Invalid prefix "${prefix}".`);
    }

    if (!levels.l1 || levels.l1.trim().length === 0) {
      throw new Error("L1 content is required.");
    }

    if (!tags || tags.length === 0) {
      throw new Error("Tags are required for linear entries.");
    }
    const validatedTags = this.validateTags(tags);

    const seq = this.nextSeq(prefix);
    const rootId = `${prefix}${String(seq).padStart(4, "0")}`;
    const timestamp = new Date().toISOString();
    const title = this.autoExtractTitle(levels.l1);

    const insertRoot = this.db.prepare(`
      INSERT INTO memories (id, prefix, seq, created_at, updated_at, title, level_1, links, min_role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'worker')
    `);

    const insertNode = this.db.prepare(`
      INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.transaction(() => {
      insertRoot.run(rootId, prefix, seq, timestamp, timestamp, title, levels.l1.trim(),
        links ? JSON.stringify(links) : null);

      // Build linear chain: .1 → .1.1 → .1.1.1 → .1.1.1.1
      let parentId = rootId;
      const levelData = [
        { depth: 2, content: levels.l2 },
        { depth: 3, content: levels.l3 },
        { depth: 4, content: levels.l4 },
        { depth: 5, content: levels.l5 },
      ];

      for (const { depth, content } of levelData) {
        if (!content || content.trim().length === 0) continue; // skip empty levels
        const nodeId = `${parentId}.1`;
        const nodeTitle = this.autoExtractTitle(content.trim());
        insertNode.run(nodeId, parentId, rootId, depth, 1, nodeTitle, content.trim(), timestamp, timestamp);
        parentId = nodeId;
      }

      // Tags on first child node (or root if no children)
      const firstChildId = levels.l2 ? `${rootId}.1` : rootId;
      this.setTags(firstChildId, validatedTags);
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
        const sql = `SELECT * FROM memories WHERE id = ?`;
        const row = this.db.prepare(sql).get(opts.id) as any;
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
                const chainRow = this.db.prepare(sql).get(chainId) as any;
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
              const finalRow = this.db.prepare(sql).get(finalId) as any;
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
      const where = `WHERE ${baseWhere}`;
      const limitClause = limit !== undefined ? ` LIMIT ${limit}` : "";

      const rows = this.db.prepare(
        `SELECT * FROM memories ${where} ORDER BY created_at DESC${limitClause}`
      ).all(...ftsRootIds) as any[];

      for (const row of rows) this.bumpAccess(row.id);
      return rows.map(r => this.rowToEntry(r));
    }

    // Build filtered bulk query (exclude headers: seq > 0)
    const conditions: string[] = ["seq > 0"];
    const params: any[] = [];

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

    // Direct results mode: bypass V2 selection, project gate, session cache.
    // Used for explicit filters (after, before, prefix, tag, stale_days) where the user
    // expects ALL matching rows, not a curated V2 subset.
    if (opts.directResults) {
      const visibleRows = rows.filter(r => r.irrelevant !== 1);
      const entries = visibleRows.map(r => {
        const children = this.fetchChildren(r.id).filter(c => !c.irrelevant);
        const entry = this.rowToEntry(r, children);
        entry.expanded = true;
        return entry;
      });
      this.assignBulkTags(entries);
      return entries;
    }

    // Step 0: Filter out irrelevant entries (never shown in bulk reads)
    // O-prefix excluded from unfiltered bulk reads (but shown when explicitly requested via prefix="O")
    const explicitPrefix = !!opts.prefix;
    const irrelevantCount = rows.filter(r => r.irrelevant === 1).length;
    const activeRows = rows.filter(r => r.irrelevant !== 1 && (explicitPrefix || r.prefix !== "O"));

    // Step 0.5: Detect active-prefixes — prefixes where at least one entry has active=1.
    // Non-active entries in these prefixes are still shown (as compact titles) but don't get expansion slots.
    // P and I prefixes ALWAYS treated as active-prefix — only expand when explicitly activated.
    const activePrefixes = new Set<string>(["P", "I"]);
    for (const r of activeRows) {
      if (r.active === 1) activePrefixes.add(r.prefix);
    }

    // Step 0.6: Project-relevant filtering — when a P-entry is active, L/D/E/T/M/S entries
    // are only expanded if they are relevant to the active project. Relevance is determined by:
    //   1. H, R prefixes → always relevant (user knowledge + rules)
    //   2. Has #universal tag → always relevant (cross-project knowledge)
    //   3. Shares ≥1 tag with the active P-entry (root + children) → project-relevant
    //   4. Everything else → title-only (suppressed)
    const relatedSuppressed = new Set<string>();
    const alwaysRelevantPrefixes = new Set(["H", "R"]);
    {
      // Find active P-entry and collect its tags (root + all children)
      const activePEntries = activeRows.filter(r => r.prefix === "P" && r.active === 1);
      if (activePEntries.length > 0) {
        const projectTagSet = new Set<string>();
        for (const pe of activePEntries) {
          const allIds = [pe.id, ...(this.db.prepare(
            "SELECT id FROM memory_nodes WHERE root_id = ?"
          ).all(pe.id) as { id: string }[]).map(r => r.id)];
          const tagMap = this.fetchTagsBulk(allIds);
          for (const tags of tagMap.values()) {
            if (tags) tags.forEach(t => projectTagSet.add(t));
          }
        }

        // Check each non-P entry: is it relevant?
        const otherEntries = activeRows.filter(r =>
          !activePrefixes.has(r.prefix) && !alwaysRelevantPrefixes.has(r.prefix) && r.obsolete !== 1
        );
        if (otherEntries.length > 0) {
          // Fetch tags for all candidates (root + children)
          const otherIds = otherEntries.map(r => r.id);
          const otherTagMap = this.fetchTagsBulk(otherIds);
          const otherChildIds = otherIds.flatMap(id =>
            (this.db.prepare("SELECT id FROM memory_nodes WHERE root_id = ?").all(id) as { id: string }[]).map(r => r.id)
          );
          const childTagMap = otherChildIds.length > 0 ? this.fetchTagsBulk(otherChildIds) : new Map<string, string[]>();

          for (const e of otherEntries) {
            // Collect all tags (root + children)
            const allTags = new Set(otherTagMap.get(e.id) ?? []);
            const childNodes = this.db.prepare(
              "SELECT id FROM memory_nodes WHERE root_id = ?"
            ).all(e.id) as { id: string }[];
            for (const cn of childNodes) {
              const ct = childTagMap.get(cn.id);
              if (ct) ct.forEach(t => allTags.add(t));
            }

            // #universal tag → always relevant
            if (allTags.has("#universal")) continue;

            // Shares ≥1 tag with active project → relevant
            const hasProjectTag = [...allTags].some(t => projectTagSet.has(t));
            if (hasProjectTag) continue;

            // No relevance found → suppress to title-only
            relatedSuppressed.add(e.id);
          }
        }
      }
    }

    // Step 0.7: Active entry context injection — when a T/P/D-entry is active, find E/L entries
    // with weighted tag overlap and promote them to expanded (title + children visible).
    // Uses same weighted scoring as findRelatedCombined: rare(≤5)=3, medium(6-20)=2, common(>20)=1.
    // Minimum score threshold: 4 (e.g. 2 medium tags, or 1 rare + 1 common).
    // Example: Active D-entry about SQL → agent sees SQL-related errors and lessons automatically.
    const taskPromotedIds = new Set<string>();
    {
      const contextPrefixes = new Set(["T", "P", "D"]);
      const activeTEntries = activeRows.filter(r => contextPrefixes.has(r.prefix) && r.active === 1);
      if (activeTEntries.length > 0) {
        // Collect tags from all active tasks (root + children)
        const taskTags = new Set<string>();
        for (const te of activeTEntries) {
          const allIds = [te.id, ...(this.db.prepare(
            "SELECT id FROM memory_nodes WHERE root_id = ?"
          ).all(te.id) as { id: string }[]).map(r => r.id)];
          const tagMap = this.fetchTagsBulk(allIds);
          for (const tags of tagMap.values()) {
            if (tags) tags.forEach(t => taskTags.add(t));
          }
        }

        if (taskTags.size > 0) {
          // Get global tag frequencies for weighting
          const tagFreqs = new Map<string, number>();
          const freqRows = this.db.prepare(
            "SELECT tag, COUNT(DISTINCT entry_id) as freq FROM memory_tags GROUP BY tag"
          ).all() as { tag: string; freq: number }[];
          for (const r of freqRows) tagFreqs.set(r.tag, r.freq);

          // Score E/L entries by weighted tag overlap
          const targetPrefixes = new Set(["E", "L"]);
          const candidates = activeRows.filter(r =>
            targetPrefixes.has(r.prefix) && r.obsolete !== 1 && r.irrelevant !== 1
          );

          for (const c of candidates) {
            const cTags = new Set(this.fetchTags(c.id));
            // Also include child tags
            const childNodes = this.db.prepare(
              "SELECT id FROM memory_nodes WHERE root_id = ?"
            ).all(c.id) as { id: string }[];
            const childTagMap = childNodes.length > 0 ? this.fetchTagsBulk(childNodes.map(n => n.id)) : new Map<string, string[]>();
            for (const tags of childTagMap.values()) {
              if (tags) tags.forEach(t => cTags.add(t));
            }

            // Calculate weighted score
            let score = 0;
            for (const t of cTags) {
              if (!taskTags.has(t)) continue;
              const freq = tagFreqs.get(t) ?? 999;
              if (freq <= 5) score += 3;       // rare
              else if (freq <= 20) score += 2; // medium
              else score += 1;                 // common
            }

            if (score >= 4) {
              taskPromotedIds.add(c.id);
              // Un-suppress if project filtering suppressed it
              relatedSuppressed.delete(c.id);
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

    // Task-promoted: E/L entries relevant to active tasks (weighted tag scoring)
    for (const id of taskPromotedIds) {
      if (!hidden.has(id)) expandedIds.add(id);
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
      let promoted: "access" | "favorite" | "subnode" | "task" | undefined;
      if (r.favorite === 1) promoted = "favorite";
      else if (topAccess.some(t => t.id === r.id)) promoted = "access";
      else if (topSubnodeIds.has(r.id)) promoted = "subnode";
      else if (taskPromotedIds.has(r.id)) promoted = "task";

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
  getLevel1All(): string {
    const rows = this.db.prepare(
      `SELECT id, created_at, level_1 FROM memories WHERE seq > 0 ORDER BY created_at DESC`
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
      md += `### [${row.id}] ${date}${accessed}\n`;
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
   * Get the most recent O-entries (session logs), optionally filtered by project link.
   * Returns entries ordered by created_at DESC (newest first).
   */
  getRecentOEntries(limit: number, linkedTo?: string): { id: string; title: string; created_at: string }[] {
    if (limit <= 0) return [];
    if (linkedTo) {
      return this.db.prepare(
        `SELECT id, title, created_at FROM memories
         WHERE prefix = 'O' AND seq > 0 AND obsolete != 1 AND irrelevant != 1
           AND links LIKE ?
         ORDER BY created_at DESC LIMIT ?`
      ).all(`%"${linkedTo}"%`, limit) as { id: string; title: string; created_at: string }[];
    }
    return this.db.prepare(
      `SELECT id, title, created_at FROM memories
       WHERE prefix = 'O' AND seq > 0 AND obsolete != 1 AND irrelevant != 1
       ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as { id: string; title: string; created_at: string }[];
  }

  /**
   * Get the last N exchanges (user message + agent response) from an O-entry.
   * Exchange structure: L2 = title, L4 (X.1) = user message, L5 (X.1.1) = agent response.
   * Returns newest first.
   */
  getOEntryExchanges(oEntryId: string, limit: number, skipSkillDialogs = false): { nodeId: string; seq: number; userText: string; agentText: string }[] {
    if (limit <= 0) return [];

    // Check if this O-entry uses the new 5-level format (has L3 nodes at depth=3)
    const hasL3 = this.db.prepare(
      "SELECT 1 FROM memory_nodes WHERE root_id = ? AND depth = 3 LIMIT 1"
    ).get(oEntryId);

    if (hasL3) {
      // New format: delegate to V2
      const opts: { skipIrrelevant?: boolean; titleOnlyTags?: string[] } = {};
      if (skipSkillDialogs) opts.titleOnlyTags = ["#skill-dialog"];
      const v2 = this.getOEntryExchangesV2(oEntryId, limit, opts);
      return v2.map(ex => ({
        nodeId: ex.nodeId,
        seq: 0, // seq not globally meaningful in new format
        userText: ex.userText,
        agentText: ex.agentText,
      }));
    }

    // Legacy format: original logic below
    // Get the last N L2 nodes (exchanges) by seq DESC
    let l2Nodes: { id: string; seq: number }[];
    // Always exclude checkpoint-summary nodes (they're not exchanges)
    const excludeTags = ["'#checkpoint-summary'"];
    if (skipSkillDialogs) excludeTags.push("'#skill-dialog'");
    l2Nodes = this.db.prepare(
      `SELECT id, seq FROM memory_nodes WHERE root_id = ? AND depth = 2
       AND id NOT IN (SELECT entry_id FROM memory_tags WHERE tag IN (${excludeTags.join(",")}))
       ORDER BY seq DESC LIMIT ?`
    ).all(oEntryId, limit) as { id: string; seq: number }[];

    const exchanges: { nodeId: string; seq: number; userText: string; agentText: string }[] = [];
    for (const l2 of l2Nodes) {
      const l4 = this.db.prepare(
        `SELECT content FROM memory_nodes WHERE parent_id = ? AND depth = 4 LIMIT 1`
      ).get(l2.id) as { content: string } | undefined;
      const l5 = this.db.prepare(
        `SELECT content FROM memory_nodes WHERE root_id = ? AND depth = 5 AND parent_id = ? LIMIT 1`
      ).get(oEntryId, l2.id + ".1") as { content: string } | undefined;
      exchanges.push({
        nodeId: l2.id,
        seq: l2.seq,
        userText: l4?.content || "",
        agentText: l5?.content || "",
      });
    }
    // Return in chronological order (oldest first)
    return exchanges.reverse();
  }

  /**
   * Get statistics about the memory store.
   */
  stats(): { total: number; byPrefix: Record<string, number>; totalChars: number; staleCount: number } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE seq > 0 AND prefix != 'O'").get() as any).c;
    const rows = this.db.prepare(
      "SELECT prefix, COUNT(*) as c FROM memories WHERE seq > 0 GROUP BY prefix"
    ).all() as any[];

    const byPrefix: Record<string, number> = {};
    for (const r of rows) byPrefix[r.prefix] = r.c;

    // Total characters across all entries + nodes (for token estimation)
    const memChars = (this.db.prepare("SELECT COALESCE(SUM(LENGTH(level_1)),0) as c FROM memories WHERE seq > 0").get() as any).c;
    const nodeChars = (this.db.prepare("SELECT COALESCE(SUM(LENGTH(content)),0) as c FROM memory_nodes").get() as any).c;

    // Stale: not accessed in 60+ days (non-obsolete, non-irrelevant)
    const staleCount = (this.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE seq > 0 AND prefix != 'O' AND irrelevant != 1 AND obsolete != 1 AND last_accessed < datetime('now', '-60 days')"
    ).get() as any).c;

    return { total, byPrefix, totalChars: memChars + nodeChars, staleCount };
  }

  /**
   * Update specific fields of an existing root entry (curator use only).
   */
  update(id: string, fields: Partial<Pick<MemoryEntry, "level_1" | "level_2" | "level_3" | "level_4" | "level_5" | "links" | "obsolete" | "favorite" | "irrelevant" | "active">>): boolean {
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
  updateNode(id: string, newContent?: string, links?: string[], obsolete?: boolean, favorite?: boolean, curatorBypass?: boolean, irrelevant?: boolean, tags?: string[], pinned?: boolean, active?: boolean): boolean {
    this.guardCorrupted();
    const trimmed = newContent?.trim();
    if (id.includes(".")) {
      // Sub-node in memory_nodes — check char limit for its depth
      const nodeRow = this.db.prepare("SELECT depth, content FROM memory_nodes WHERE id = ?").get(id) as any;
      if (!nodeRow) return false;
      const oldContent = nodeRow.content as string;
      const sets: string[] = [];
      const params: any[] = [];
      if (trimmed) {
        const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(nodeRow.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
        if (trimmed.length > nodeLimit * HmemStore.CHAR_LIMIT_TOLERANCE) {
          throw new Error(`Content exceeds ${nodeLimit} character limit (${trimmed.length} chars) for L${nodeRow.depth}.`);
        }
        // Parse > body lines: first non-> line = title, > lines = body (content)
        const lines = trimmed.split("\n");
        const titleLines: string[] = [];
        const bodyLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("> ") || line === ">") {
            bodyLines.push(line.replace(/^> ?/, ""));
          } else {
            titleLines.push(line);
          }
        }
        if (bodyLines.length > 0) {
          sets.push("content = ?", "title = ?");
          params.push(bodyLines.join("\n"), titleLines.join(" ").trim());
        } else {
          sets.push("content = ?", "title = ?");
          params.push(trimmed, this.autoExtractTitle(trimmed));
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
      // Root entry in memories
      if (trimmed) {
        // Split into title lines, body lines (> prefix), and child lines (indented)
        const lines = trimmed.split("\n");
        const titleLines: string[] = [];
        const bodyLines: string[] = [];
        const childLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("\t") || (line.length > 0 && line[0] === " " && line.trimStart() !== line)) {
            childLines.push(line);
          } else if (line.startsWith("> ") || line === ">") {
            bodyLines.push(line.replace(/^> ?/, ""));
          } else {
            titleLines.push(line);
          }
        }

        const hasBody = bodyLines.length > 0;
        const hasChildren = childLines.length > 0;
        const titleText = titleLines.join(" | ").trim();
        const l1Text = hasBody ? bodyLines.join("\n") : titleText;
        const newTitle = hasBody ? titleText : this.autoExtractTitle(titleText);

        const l1Limit = this.cfg.maxCharsPerLevel[0];
        // For body mode, check body length against a generous limit (L2-level)
        // For non-body mode, check title against L1 limit
        if (!hasBody && l1Text.length > l1Limit * HmemStore.CHAR_LIMIT_TOLERANCE) {
          throw new Error(`Level 1 exceeds ${l1Limit} character limit (${l1Text.length} chars). Keep L1 compact.`);
        }

        // Update L1
        const updateTs = new Date().toISOString();
        this.db.prepare("UPDATE memories SET level_1 = ?, title = ?, updated_at = ? WHERE id = ?")
          .run(l1Text, newTitle, updateTs, id);

        // Append children via appendChildren (handles seq numbering correctly)
        if (hasChildren) {
          this.appendChildren(id, childLines.join("\n"));
        }
      }

      // Obsolete enforcement: require [✓ID] correction reference
      if (obsolete === true && !curatorBypass) {
        const contentToCheck = trimmed ?? (this.db.prepare("SELECT level_1 FROM memories WHERE id = ?").get(id) as any)?.level_1 ?? "";
        const correctionMatch = contentToCheck.match(/\[✓([A-Z]\d{4}(?:\.\d+)*)\]/);
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

      const sets: string[] = [];
      const params: any[] = [];
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
        if (active) {
          const prefix = id.replace(/\d+$/, "");
          // Deactivate all other entries in the same prefix
          this.db.prepare("UPDATE memories SET active = 0 WHERE prefix = ? AND id != ? AND active = 1")
            .run(prefix, id);
          // When activating a P-entry: link all unassigned O-entries to this project
          if (prefix === "P") {
            const unassigned = this.db.prepare(
              "SELECT id, links FROM memories WHERE prefix = 'O' AND obsolete != 1 AND irrelevant != 1 AND (links IS NULL OR links = '[]' OR links = 'null')"
            ).all() as { id: string; links: string | null }[];
            for (const o of unassigned) {
              const existingLinks: string[] = o.links ? (() => { try { return JSON.parse(o.links); } catch { return []; } })() : [];
              if (!existingLinks.includes(id)) {
                existingLinks.push(id);
                this.db.prepare("UPDATE memories SET links = ? WHERE id = ?")
                  .run(JSON.stringify(existingLinks), o.id);
              }
            }
          }
        }
      }
      if (sets.length === 0) {
        // No flag updates — but content may have been updated above (> body parsing)
        if (tags !== undefined) {
          this.setTags(id, tags.length > 0 ? this.validateTags(tags) : []);
        }
        return !!trimmed || tags !== undefined;
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
        insertNode.run(node.id, node.parent_id, rootId, node.depth, node.seq, node.title, node.content, timestamp, timestamp);
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
   * Append a chat exchange (user prompt + agent response) to an O-entry.
   * Inserts 3 nodes as a linear chain WITHOUT content parsing — newlines are preserved.
   *   L2: title (auto-extracted from userText)
   *   L4: user message (raw, newlines intact)
   *   L5: agent response (raw, newlines intact)
   */
  appendExchange(parentId: string, userText: string, agentText: string): { id: string } {
    this.guardCorrupted();
    const parentIsRoot = !parentId.includes(".");
    const rootId = parentIsRoot ? parentId : parentId.split(".")[0];
    const timestamp = new Date().toISOString();

    // Find next available seq — scan ALL nodes under this parent (any depth) to avoid
    // ID collisions with checkpoint summaries or other nodes appended at different depths
    const maxSeqRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
       FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
    ).get(parentId + ".", parentId + ".%", parentId + ".%.%") as any;
    const seq = (maxSeqRow?.m ?? 0) + 1;

    const title = this.autoExtractTitle(userText.split("\n")[0].replace(/[<>\[\]]/g, ""));
    const l2Id = `${parentId}.${seq}`;
    const l4Id = `${l2Id}.1`;
    const l5Id = `${l4Id}.1`;

    const insertNode = this.db.prepare(
      "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    this.db.transaction(() => {
      insertNode.run(l2Id, parentId, rootId, 2, seq, title, title, timestamp, timestamp);
      insertNode.run(l4Id, l2Id, rootId, 4, 1, this.autoExtractTitle(userText), userText, timestamp, timestamp);
      insertNode.run(l5Id, l4Id, rootId, 5, 1, this.autoExtractTitle(agentText), agentText, timestamp, timestamp);
      this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, rootId);
    })();

    return { id: l2Id };
  }

  /**
   * Append a checkpoint summary as a tagged L2 node under an O-entry.
   * The summary sits alongside exchanges in the L2 sequence.
   * Returns the node ID.
   */
  appendCheckpointSummary(oEntryId: string, summaryText: string): string {
    this.guardCorrupted();
    const timestamp = new Date().toISOString();
    // Scan all direct children IDs (any depth) to avoid collisions with exchanges
    const maxSeqRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
       FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
    ).get(oEntryId + ".", oEntryId + ".%", oEntryId + ".%.%") as any;
    const seq = (maxSeqRow?.m ?? 0) + 1;
    const nodeId = `${oEntryId}.${seq}`;
    const title = this.autoExtractTitle(summaryText);

    this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(nodeId, oEntryId, oEntryId, 2, seq, title, summaryText, timestamp, timestamp);
      this.addTag(nodeId, "#checkpoint-summary");
      this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, oEntryId);
    })();

    return nodeId;
  }

  /**
   * Get checkpoint summaries for an O-entry, newest first.
   * Returns the summary content + the seq number (to know which exchanges it covers).
   */
  getCheckpointSummaries(oEntryId: string, limit: number = 2): { nodeId: string; seq: number; content: string; created_at: string }[] {
    return this.db.prepare(
      `SELECT mn.id as nodeId, mn.seq, mn.content, mn.created_at
       FROM memory_nodes mn
       JOIN memory_tags mt ON mt.entry_id = mn.id AND mt.tag = '#checkpoint-summary'
       WHERE mn.root_id = ?
       ORDER BY mn.seq DESC LIMIT ?`
    ).all(oEntryId, limit) as { nodeId: string; seq: number; content: string; created_at: string }[];
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

  /** Add a single tag to an entry/node without removing existing tags. */
  addTag(entryId: string, tag: string): void {
    this.db.prepare("INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)").run(entryId, tag);
  }

  /** Find and tag untagged checkpoint summary nodes ([CP] prefix) under an O-entry. */
  tagNewCheckpointSummaries(oEntryId: string): string[] {
    const nodes = this.db.prepare(
      `SELECT id FROM memory_nodes WHERE root_id = ?
       AND (content LIKE '[CP]%' OR title LIKE '[CP]%')
       AND id NOT IN (SELECT entry_id FROM memory_tags WHERE tag = '#checkpoint-summary')
       ORDER BY seq`
    ).all(oEntryId) as { id: string }[];
    for (const n of nodes) this.addTag(n.id, "#checkpoint-summary");
    return nodes.map(n => n.id);
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
  assignBulkTags(entries: MemoryEntry[]): void {
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


  private nextSeq(prefix: string): number {
    const row = this.db.prepare(
      "SELECT MAX(seq) as maxSeq FROM memories WHERE prefix = ?"
    ).get(prefix) as any;
    return (row?.maxSeq || 0) + 1;
  }

  /** Clear all active markers — called at MCP server start so each session starts neutral. */
  clearAllActive(): void {
    this.db.prepare("UPDATE memories SET active = 0 WHERE active = 1").run();
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

  /** Get child nodes created after a given ISO timestamp (for "new since last session" detection). */
  getNewNodesSince(since: string, limit: number = 20): { id: string; root_id: string; title: string; content: string }[] {
    return this.db.prepare(
      "SELECT mn.id, mn.root_id, mn.title, mn.content FROM memory_nodes mn " +
      "JOIN memories m ON mn.root_id = m.id " +
      "WHERE mn.created_at > ? AND m.obsolete != 1 AND m.irrelevant != 1 AND mn.irrelevant != 1 " +
      "ORDER BY mn.created_at DESC LIMIT ?"
    ).all(since, limit) as { id: string; root_id: string; title: string; content: string }[];
  }

  /** Get or create the active O-entry (for log-exchange hook). */
  /** Count L2 children of a root entry (direct children only). */
  countDirectChildren(rootId: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) as n FROM memory_nodes WHERE root_id = ? AND depth = 2"
    ).get(rootId) as any)?.n ?? 0;
  }

  /** @deprecated Use resolveProjectO() instead. Will be removed in v6.0. */
  getActiveO(): string {
    // Find active project for context
    const activeProject = this.db.prepare(
      "SELECT id, title FROM memories WHERE prefix = 'P' AND active = 1 AND obsolete != 1 LIMIT 1"
    ).get() as { id: string; title: string } | undefined;

    const row = this.db.prepare(
      "SELECT id, links FROM memories WHERE prefix = 'O' AND active = 1 AND obsolete != 1 AND irrelevant != 1 LIMIT 1"
    ).get() as { id: string; links: string | null } | undefined;

    if (row) {
      // Check if the active O-entry matches the active project
      if (activeProject) {
        const links = row.links ? JSON.parse(row.links) as string[] : [];
        if (links.includes(activeProject.id)) return row.id;
        // Project mismatch — deactivate old O-entry, mark irrelevant if ≤1 exchange
        const childCount = this.countDirectChildren(row.id);
        const irrelevant = childCount <= 1 ? 1 : 0;
        this.db.prepare("UPDATE memories SET active = 0, irrelevant = ?, updated_at = ? WHERE id = ?")
          .run(irrelevant, new Date().toISOString(), row.id);
      } else {
        return row.id; // No active project — keep using current O-entry
      }
    }

    const today = new Date().toISOString().substring(0, 10);
    const projectName = activeProject?.title?.split("|")[0]?.trim() ?? "unassigned";
    const tags = ["#session"];
    const links = activeProject ? [activeProject.id] : undefined;

    const result = this.writeLinear("O", { l1: `${projectName} — Session ${today}` }, tags, links);
    this.db.prepare("UPDATE memories SET active = 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), result.id);
    return result.id;
  }

  /** @deprecated Use resolveProjectO() instead. Will be removed in v6.0. Get the active O-entry ID without creating one. Returns null if none active. */
  getActiveOId(): string | null {
    const row = this.db.prepare(
      "SELECT id FROM memories WHERE prefix = 'O' AND active = 1 AND obsolete != 1 AND irrelevant != 1 LIMIT 1"
    ).get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Get the active project entry. Returns null if none active. */
  getActiveProject(): { id: string; title: string } | null {
    return (this.db.prepare(
      "SELECT id, title FROM memories WHERE prefix = 'P' AND active = 1 AND obsolete != 1 LIMIT 1"
    ).get() as { id: string; title: string } | undefined) ?? null;
  }

  /**
   * Get the second-to-last session (L2 node) under an O-entry.
   * Used by the SessionStart hook to check if the previous session needs a summary.
   * Returns null if fewer than 2 sessions exist.
   */
  getPreviousSession(oId: string): { id: string; title: string; content: string } | null {
    return (this.db.prepare(
      `SELECT id, title, content FROM memory_nodes
       WHERE root_id = ? AND depth = 2
       ORDER BY seq DESC LIMIT 1 OFFSET 1`
    ).get(oId) as { id: string; title: string; content: string } | undefined) ?? null;
  }

  /**
   * Read a root entry from the memories table by ID. Returns null if not found.
   */
  readEntry(id: string): { id: string; prefix: string; seq: number; level_1: string; links: string | null } | null {
    return (this.db.prepare(
      "SELECT id, prefix, seq, level_1, links FROM memories WHERE id = ?"
    ).get(id) as { id: string; prefix: string; seq: number; level_1: string; links: string | null } | undefined) ?? null;
  }

  /**
   * Find or create the O-entry for a given project sequence number.
   * O0048 belongs to P0048, O0000 is the non-project catch-all.
   * Does NOT use the active flag — O is derived purely from P's seq.
   */
  resolveProjectO(projectSeq: number): string {
    const oId = `O${String(projectSeq).padStart(4, "0")}`;
    const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(oId) as { id: string } | undefined;
    if (existing) return oId;

    const timestamp = new Date().toISOString();
    const title = projectSeq === 0 ? "Non-project sessions" : `O-entry for P${String(projectSeq).padStart(4, "0")}`;

    // Find linked P-entry if projectSeq > 0
    const pId = projectSeq > 0 ? `P${String(projectSeq).padStart(4, "0")}` : null;
    const pExists = pId ? (this.db.prepare("SELECT id FROM memories WHERE id = ?").get(pId) as { id: string } | undefined) : null;
    const links = pExists ? JSON.stringify([pId]) : null;

    this.db.prepare(
      `INSERT INTO memories (id, prefix, seq, created_at, updated_at, title, level_1, links, min_role)
       VALUES (?, 'O', ?, ?, ?, ?, ?, ?, 'worker')`
    ).run(oId, projectSeq, timestamp, timestamp, title, title, links);

    return oId;
  }

  /**
   * Find or create a session (L2 node) under an O-entry.
   * Sessions are tracked via a temp file keyed by O-entry ID hash.
   * A new transcript_path means a new Claude Code session.
   */
  resolveSession(oId: string, transcriptPath: string): string {
    const hash = crypto.createHash("md5").update(oId).digest("hex").substring(0, 8);
    const stateFile = `/tmp/.hmem_session_${hash}.json`;

    // Check cached state
    let cached: { transcriptPath: string; sessionId: string } | null = null;
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      cached = JSON.parse(raw) as { transcriptPath: string; sessionId: string };
    } catch {
      // File doesn't exist or is invalid — treat as no cache
    }

    if (cached && cached.transcriptPath === transcriptPath) {
      // Verify the session node still exists in the DB
      const nodeExists = this.db.prepare("SELECT id FROM memory_nodes WHERE id = ?").get(cached.sessionId) as { id: string } | undefined;
      if (nodeExists) return cached.sessionId;
    }

    // Create new L2 session node under oId
    const maxSeqRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
       FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
    ).get(oId + ".", oId + ".%", oId + ".%.%") as { m: number | null };
    const seq = (maxSeqRow?.m ?? 0) + 1;
    const sessionId = `${oId}.${seq}`;
    const timestamp = new Date().toISOString();
    const title = `Session ${timestamp.substring(0, 10)}`;

    this.db.prepare(
      "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?)"
    ).run(sessionId, oId, oId, seq, title, title, timestamp, timestamp);
    this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, oId);

    // Write state file
    fs.writeFileSync(stateFile, JSON.stringify({ transcriptPath, sessionId }), "utf8");

    return sessionId;
  }

  /**
   * Find or create a batch (L3 node) under a session.
   * Creates a new batch if the current one is full (has >= batchSize L4 children).
   */
  resolveBatch(sessionId: string, oId: string, batchSize: number): string {
    // Find latest L3 under session
    const latestBatch = this.db.prepare(
      "SELECT id FROM memory_nodes WHERE parent_id = ? AND depth = 3 ORDER BY seq DESC LIMIT 1"
    ).get(sessionId) as { id: string } | undefined;

    if (latestBatch) {
      // Count L4 children in this batch
      const countRow = this.db.prepare(
        "SELECT COUNT(*) as n FROM memory_nodes WHERE parent_id = ? AND depth = 4"
      ).get(latestBatch.id) as { n: number };
      if (countRow.n < batchSize) return latestBatch.id;
    }

    // Create new L3 batch node under session
    const maxSeqRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
       FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
    ).get(sessionId + ".", sessionId + ".%", sessionId + ".%.%") as { m: number | null };
    const seq = (maxSeqRow?.m ?? 0) + 1;
    const batchId = `${sessionId}.${seq}`;
    const timestamp = new Date().toISOString();
    const title = `Batch ${seq}`;

    this.db.prepare(
      "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, 3, ?, ?, ?, ?, ?)"
    ).run(batchId, sessionId, oId, seq, title, title, timestamp, timestamp);
    this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, oId);

    return batchId;
  }

  /**
   * Append a V2 exchange (3-node chain) under a batch (L3 node).
   * Creates:
   *   L4: exchange node — title auto-extracted from userText
   *   L5.1: user message (raw userText)
   *   L5.2: agent message (raw agentText)
   */
  appendExchangeV2(batchId: string, oId: string, userText: string, agentText: string): { id: string } {
    this.guardCorrupted();
    const timestamp = new Date().toISOString();

    // Next seq under batch (direct children only)
    const maxSeqRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
       FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
    ).get(batchId + ".", batchId + ".%", batchId + ".%.%") as any;
    const seq = (maxSeqRow?.m ?? 0) + 1;

    const title = this.autoExtractTitle(userText.split("\n")[0].replace(/[<>\[\]]/g, ""));
    const l4Id = `${batchId}.${seq}`;
    const l5UserId = `${l4Id}.1`;
    const l5AgentId = `${l4Id}.2`;

    const insertNode = this.db.prepare(
      "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    this.db.transaction(() => {
      insertNode.run(l4Id, batchId, oId, 4, seq, title, title, timestamp, timestamp);
      insertNode.run(l5UserId, l4Id, oId, 5, 1, this.autoExtractTitle(userText), userText, timestamp, timestamp);
      insertNode.run(l5AgentId, l4Id, oId, 5, 2, this.autoExtractTitle(agentText), agentText, timestamp, timestamp);
      this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, oId);
    })();

    return { id: l4Id };
  }

  countBatchExchanges(batchId: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) as n FROM memory_nodes WHERE parent_id = ? AND depth = 4"
    ).get(batchId) as any)?.n ?? 0;
  }

  /**
   * Process pending exchanges queued by hooks that couldn't open the DB
   * (e.g. Windows WAL locking when MCP server holds the DB).
   * File: {hmemDir}/pending-exchanges.jsonl — one JSON object per line.
   */
  processPendingExchanges(): number {
    const pendingPath = path.join(path.dirname(this.dbPath), "pending-exchanges.jsonl");
    if (!fs.existsSync(pendingPath)) return 0;

    let raw: string;
    try {
      raw = fs.readFileSync(pendingPath, "utf8").trim();
    } catch { return 0; }
    if (!raw) return 0;

    const lines = raw.split("\n").filter(l => l.trim());
    let processed = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          ts: string;
          userMessage: string;
          agentMessage: string;
          transcriptPath?: string;
        };
        if (!entry.userMessage || !entry.agentMessage) continue;

        // Resolve O-entry and session/batch like log-exchange would
        const activeProject = this.getActiveProject();
        const projectSeq = activeProject ? parseInt(activeProject.id.replace(/\D/g, ""), 10) : 0;
        const oId = this.resolveProjectO(projectSeq);
        const sessionId = entry.transcriptPath
          ? this.resolveSession(oId, entry.transcriptPath)
          : this.resolveSession(oId, `pending-${entry.ts}`);
        const batchSize = this.cfg.checkpointInterval || 5;
        const batchId = this.resolveBatch(sessionId, oId, batchSize);

        this.appendExchangeV2(batchId, oId, entry.userMessage, entry.agentMessage);
        processed++;
      } catch (e) {
        console.error(`[hmem] Failed to process pending exchange: ${e}`);
      }
    }

    // Remove the pending file after processing
    try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }

    if (processed > 0) {
      console.error(`[hmem] Processed ${processed} pending exchanges from queue`);
    }
    return processed;
  }

  getOEntryExchangesV2(
    oId: string,
    limit: number,
    opts?: { skipIrrelevant?: boolean; titleOnlyTags?: string[] }
  ): { nodeId: string; title: string; userText: string; agentText: string; created_at: string }[] {
    if (limit <= 0) return [];

    const excludeTags: string[] = [];
    if (opts?.skipIrrelevant) excludeTags.push("#irrelevant");
    const titleOnlyTags = opts?.titleOnlyTags ?? [];

    // Get L4 exchange nodes, newest first
    let query = `SELECT id, title, created_at FROM memory_nodes WHERE root_id = ? AND depth = 4`;
    if (excludeTags.length > 0) {
      const tagList = excludeTags.map(t => `'${t}'`).join(",");
      query += ` AND id NOT IN (SELECT entry_id FROM memory_tags WHERE tag IN (${tagList}))`;
    }
    query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;

    const l4Nodes = this.db.prepare(query).all(oId, limit) as { id: string; title: string; created_at: string }[];

    const exchanges: { nodeId: string; title: string; userText: string; agentText: string; created_at: string }[] = [];

    for (const l4 of l4Nodes) {
      let isTitleOnly = false;
      if (titleOnlyTags.length > 0) {
        const tagList = titleOnlyTags.map(t => `'${t}'`).join(",");
        const hasTag = this.db.prepare(
          `SELECT 1 FROM memory_tags WHERE entry_id = ? AND tag IN (${tagList}) LIMIT 1`
        ).get(l4.id);
        if (hasTag) isTitleOnly = true;
      }

      if (isTitleOnly) {
        exchanges.push({ nodeId: l4.id, title: l4.title, userText: "", agentText: "", created_at: l4.created_at });
      } else {
        const l5User = this.db.prepare(
          "SELECT content FROM memory_nodes WHERE parent_id = ? AND depth = 5 AND seq = 1 LIMIT 1"
        ).get(l4.id) as { content: string } | undefined;
        const l5Agent = this.db.prepare(
          "SELECT content FROM memory_nodes WHERE parent_id = ? AND depth = 5 AND seq = 2 LIMIT 1"
        ).get(l4.id) as { content: string } | undefined;

        exchanges.push({
          nodeId: l4.id,
          title: l4.title,
          userText: l5User?.content ?? "",
          agentText: l5Agent?.content ?? "",
          created_at: l4.created_at,
        });
      }
    }

    return exchanges.reverse(); // chronological order
  }

  /**
   * Find the latest full batch (L3 node with >= batchSize L4 children)
   * under a given O-entry root. Returns null if no full batch exists.
   */
  getLatestFullBatch(oId: string, batchSize: number): { id: string; sessionId: string } | null {
    return (this.db.prepare(
      `SELECT mn.id, mn.parent_id as sessionId FROM memory_nodes mn
       WHERE mn.root_id = ? AND mn.depth = 3
       AND (SELECT COUNT(*) FROM memory_nodes c WHERE c.parent_id = mn.id AND c.depth = 4) >= ?
       ORDER BY mn.created_at DESC LIMIT 1`
    ).get(oId, batchSize) as { id: string; sessionId: string } | undefined) ?? null;
  }

  /**
   * Get the previous batch (L3) sibling within the same session, excluding a given batch.
   * Returns the batch's id, content, and title.
   */
  getPreviousBatch(sessionId: string, excludeBatchId: string): { id: string; content: string; title: string } | null {
    return (this.db.prepare(
      `SELECT id, content, title FROM memory_nodes
       WHERE parent_id = ? AND depth = 3 AND id != ? ORDER BY seq DESC LIMIT 1`
    ).get(sessionId, excludeBatchId) as { id: string; content: string; title: string } | undefined) ?? null;
  }

  /** Read a single memory_nodes row by ID. Returns null if not found. */
  readNode(id: string): MemoryNode | null {
    return (this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) as MemoryNode) ?? null;
  }

  /** Return all direct children of a node, ordered by seq. */
  getChildNodes(parentId: string): MemoryNode[] {
    return this.db.prepare(
      "SELECT * FROM memory_nodes WHERE parent_id = ? ORDER BY seq"
    ).all(parentId) as MemoryNode[];
  }

  /** Find a child node by content/title pattern. Returns node ID or null. */
  findChildNode(parentId: string, pattern: string, depth?: number): string | null {
    const depthClause = depth != null ? " AND depth = ?" : "";
    const params: unknown[] = [parentId, `%${pattern}%`, `%${pattern}%`];
    if (depth != null) params.push(depth);
    const row = this.db.prepare(
      `SELECT id FROM memory_nodes WHERE parent_id = ?
       AND (LOWER(content) LIKE ? OR LOWER(title) LIKE ?)${depthClause}
       LIMIT 1`
    ).get(...params) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Find a child node of a root entry by content/title pattern. */
  findRootChildNode(rootId: string, pattern: string, depth: number): string | null {
    const row = this.db.prepare(
      `SELECT id FROM memory_nodes WHERE root_id = ? AND depth = ?
       AND (LOWER(content) LIKE ? OR LOWER(title) LIKE ?)
       LIMIT 1`
    ).get(rootId, depth, `%${pattern}%`, `%${pattern}%`) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Return all non-obsolete P-entries with just id + title.
   */
  listProjects(): { id: string; title: string }[] {
    return this.db.prepare(
      "SELECT id, title FROM memories WHERE prefix = 'P' AND seq > 0 AND obsolete != 1 ORDER BY seq"
    ).all() as { id: string; title: string }[];
  }

  /**
   * Move L2 (sessions), L3 (batches), or L4 (exchanges) between O-entries.
   * Rewrites all IDs in the subtree (node + children + tags + FTS).
   */
  moveNodes(nodeIds: string[], targetOId: string): { moved: number; errors: string[] } {
    let moved = 0;
    const errors: string[] = [];

    // Validate target exists
    const targetExists = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(targetOId);
    if (!targetExists) {
      return { moved: 0, errors: [`Target ${targetOId} does not exist`] };
    }

    const doMove = this.db.transaction(() => {
      for (const nodeId of nodeIds) {
        const node = this.readNode(nodeId);
        if (!node) {
          errors.push(`Node ${nodeId} not found`);
          continue;
        }

        const sourceOId = node.root_id;
        if (sourceOId === targetOId) {
          errors.push(`Node ${nodeId} already belongs to ${targetOId}`);
          continue;
        }

        // Determine the depth and figure out the new parent
        if (node.depth === 2) {
          // L2 session — re-parent directly under target O
          this._moveSubtree(nodeId, sourceOId, targetOId, targetOId, 2);
        } else if (node.depth === 3) {
          // L3 batch — find/create session in target O
          const sessionId = this._findOrCreateSessionForDate(targetOId, node.created_at.substring(0, 10));
          this._moveSubtree(nodeId, sourceOId, targetOId, sessionId, 3);
        } else if (node.depth === 4) {
          // L4 exchange — find/create session + batch in target O
          const sessionId = this._findOrCreateSessionForDate(targetOId, node.created_at.substring(0, 10));
          const batchId = this._findOrCreateBatchForDate(sessionId, targetOId, node.created_at.substring(0, 10));
          this._moveSubtree(nodeId, sourceOId, targetOId, batchId, 4);
        } else {
          errors.push(`Cannot move node ${nodeId} at depth ${node.depth} — only L2-L4 supported`);
          continue;
        }

        // Clean up empty parents in the source O-entry
        this._cleanupEmptyParents(sourceOId);
        moved++;
      }
    });

    doMove();
    return { moved, errors };
  }

  /**
   * Find an existing L2 session created on the given date, or create a new one.
   */
  private _findOrCreateSessionForDate(oId: string, dateIso: string): string {
    // Look for existing session created on this date
    const existing = this.db.prepare(
      `SELECT id FROM memory_nodes WHERE parent_id = ? AND depth = 2
       AND created_at LIKE ? ORDER BY seq DESC LIMIT 1`
    ).get(oId, `${dateIso}%`) as { id: string } | undefined;

    if (existing) return existing.id;

    // Create new session
    const maxSeqRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
       FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
    ).get(oId + ".", oId + ".%", oId + ".%.%") as { m: number | null };
    const seq = (maxSeqRow?.m ?? 0) + 1;
    const sessionId = `${oId}.${seq}`;
    const timestamp = new Date().toISOString();
    const title = `Session ${dateIso}`;

    this.db.prepare(
      "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?)"
    ).run(sessionId, oId, oId, seq, title, title, timestamp, timestamp);
    this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, oId);

    return sessionId;
  }

  /**
   * Find a batch under the session with room, or create a new one.
   */
  private _findOrCreateBatchForDate(sessionId: string, oId: string, _dateIso: string): string {
    const batchSize = this.cfg.checkpointInterval || 5;

    // Find latest batch with room
    const latestBatch = this.db.prepare(
      "SELECT id FROM memory_nodes WHERE parent_id = ? AND depth = 3 ORDER BY seq DESC LIMIT 1"
    ).get(sessionId) as { id: string } | undefined;

    if (latestBatch) {
      const countRow = this.db.prepare(
        "SELECT COUNT(*) as n FROM memory_nodes WHERE parent_id = ? AND depth = 4"
      ).get(latestBatch.id) as { n: number };
      if (countRow.n < batchSize) return latestBatch.id;
    }

    // Create new batch
    const maxSeqRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
       FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
    ).get(sessionId + ".", sessionId + ".%", sessionId + ".%.%") as { m: number | null };
    const seq = (maxSeqRow?.m ?? 0) + 1;
    const batchId = `${sessionId}.${seq}`;
    const timestamp = new Date().toISOString();
    const title = `Batch ${seq}`;

    this.db.prepare(
      "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, 3, ?, ?, ?, ?, ?)"
    ).run(batchId, sessionId, oId, seq, title, title, timestamp, timestamp);
    this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, oId);

    return batchId;
  }

  /**
   * Move a subtree (node + all descendants) to a new parent in the target O-entry.
   * Rewrites all IDs, parent_ids, root_ids, tags, and FTS rowid map entries.
   */
  private _moveSubtree(nodeId: string, sourceOId: string, targetOId: string, newParentId: string, depth: number): void {
    // 1. Get all nodes in subtree (nodeId itself + all descendants)
    const subtreeNodes = this.db.prepare(
      "SELECT id, parent_id, root_id, depth, seq, title, content, created_at, updated_at, access_count, last_accessed FROM memory_nodes WHERE id = ? OR id LIKE ?"
    ).all(nodeId, `${nodeId}.%`) as MemoryNode[];

    // 2. Calculate next seq under new parent (direct children only)
    const maxSeqRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
       FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
    ).get(newParentId + ".", newParentId + ".%", newParentId + ".%.%") as { m: number | null };
    const newSeq = (maxSeqRow?.m ?? 0) + 1;

    // 3. Build old prefix -> new prefix mapping
    const newNodeId = `${newParentId}.${newSeq}`;
    const oldPrefix = nodeId;
    const newPrefix = newNodeId;

    // 4. For each node in the subtree: delete old, insert new
    const deleteStmt = this.db.prepare("DELETE FROM memory_nodes WHERE id = ?");
    const insertStmt = this.db.prepare(
      "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at, access_count, last_accessed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    for (const n of subtreeNodes) {
      const nNewId = n.id === oldPrefix ? newPrefix : n.id.replace(oldPrefix, newPrefix);
      const nNewParentId = n.id === oldPrefix ? newParentId : n.parent_id.replace(oldPrefix, newPrefix);
      const nNewDepth = n.depth + (depth - (subtreeNodes.find(s => s.id === nodeId)!.depth));

      // Delete old node
      deleteStmt.run(n.id);

      // Insert new node
      insertStmt.run(
        nNewId, nNewParentId, targetOId,
        nNewDepth, n.id === oldPrefix ? newSeq : n.seq,
        n.title, n.content, n.created_at, n.updated_at ?? n.created_at,
        n.access_count ?? 0, n.last_accessed ?? null
      );

      // 5. Update tags: DELETE old + INSERT new
      const tags = this.db.prepare(
        "SELECT tag FROM memory_tags WHERE entry_id = ?"
      ).all(n.id) as { tag: string }[];

      if (tags.length > 0) {
        this.db.prepare("DELETE FROM memory_tags WHERE entry_id = ?").run(n.id);
        for (const t of tags) {
          this.db.prepare("INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)").run(nNewId, t.tag);
        }
      }

      // 6. Update FTS rowid map
      this.db.prepare(
        "UPDATE hmem_fts_rowid_map SET root_id = ?, node_id = ? WHERE node_id = ?"
      ).run(targetOId, nNewId, n.id);
    }

    // Update target O-entry updated_at
    const timestamp = new Date().toISOString();
    this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, targetOId);
  }

  /**
   * Remove empty L2 (sessions) and L3 (batches) nodes in an O-entry.
   */
  private _cleanupEmptyParents(oId: string): void {
    // Clean up empty L3 batches (no L4 children)
    const emptyBatches = this.db.prepare(
      `SELECT n.id FROM memory_nodes n
       WHERE n.root_id = ? AND n.depth = 3
       AND NOT EXISTS (SELECT 1 FROM memory_nodes c WHERE c.parent_id = n.id)`
    ).all(oId) as { id: string }[];

    for (const b of emptyBatches) {
      this.db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(b.id);
      this.db.prepare("DELETE FROM memory_tags WHERE entry_id = ?").run(b.id);
      this.db.prepare("DELETE FROM hmem_fts_rowid_map WHERE node_id = ?").run(b.id);
    }

    // Clean up empty L2 sessions (no L3 children)
    const emptySessions = this.db.prepare(
      `SELECT n.id FROM memory_nodes n
       WHERE n.root_id = ? AND n.depth = 2
       AND NOT EXISTS (SELECT 1 FROM memory_nodes c WHERE c.parent_id = n.id)`
    ).all(oId) as { id: string }[];

    for (const s of emptySessions) {
      this.db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(s.id);
      this.db.prepare("DELETE FROM memory_tags WHERE entry_id = ?").run(s.id);
      this.db.prepare("DELETE FROM hmem_fts_rowid_map WHERE node_id = ?").run(s.id);
    }
  }

  bumpAccess(id: string): void {
    // Clear irrelevant flag on explicit read — if someone reads it, it matters
    this.db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed = ?, irrelevant = 0 WHERE id = ?"
    ).run(new Date().toISOString(), id);
  }

  /**
   * Auto-purge: physically delete irrelevant entries older than maxAgeDays.
   * Only deletes entries where irrelevant=1 — entries rescued by bumpAccess survive.
   * Returns the number of deleted entries.
   */
  purgeIrrelevant(maxAgeDays = 30): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
    const rows = this.db.prepare(
      "SELECT id FROM memories WHERE irrelevant = 1 AND updated_at < ?"
    ).all(cutoff) as { id: string }[];

    if (rows.length === 0) return 0;

    const deleteNodes = this.db.prepare("DELETE FROM memory_nodes WHERE root_id = ?");
    const deleteRoot = this.db.prepare("DELETE FROM memories WHERE id = ?");
    const deleteTags = this.db.prepare("DELETE FROM memory_tags WHERE entry_id LIKE ? || '%'");

    const purge = this.db.transaction(() => {
      for (const { id } of rows) {
        deleteNodes.run(id);
        deleteTags.run(id);
        deleteRoot.run(id);
      }
    });
    purge();
    return rows.length;
  }

  /**
   * Atomically rename an entry ID and update all references across the database.
   * Used to resolve ID conflicts after sync-push detects a collision.
   *
   * Updates: memories.id, memory_nodes (id, parent_id, root_id),
   * memory_tags.entry_id, hmem_fts_rowid_map (root_id, node_id),
   * memories.links (JSON arrays in other entries), level_1 obsolete markers [✓ID].
   *
   * Returns the number of affected rows (nodes + link rewrites + tag rewrites).
   */
  renameId(oldId: string, newId: string): { ok: boolean; affected: number; error?: string } {
    // Validate
    if (oldId === newId) return { ok: false, affected: 0, error: "old and new ID are identical" };

    const oldEntry = this.db.prepare("SELECT id, prefix FROM memories WHERE id = ?").get(oldId) as any;
    if (!oldEntry) return { ok: false, affected: 0, error: `entry ${oldId} not found` };

    const newExists = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(newId) as any;
    if (newExists) return { ok: false, affected: 0, error: `target ID ${newId} already exists` };

    // Ensure same prefix
    const oldPrefix = oldId.match(/^[A-Z]+/)?.[0];
    const newPrefix = newId.match(/^[A-Z]+/)?.[0];
    if (oldPrefix !== newPrefix) return { ok: false, affected: 0, error: `prefix mismatch: ${oldPrefix} vs ${newPrefix}` };

    let affected = 0;

    const doRename = this.db.transaction(() => {
      // 1. Rename all child nodes: P0048.1.2 → P0052.1.2
      const nodes = this.db.prepare(
        "SELECT id, parent_id FROM memory_nodes WHERE root_id = ?"
      ).all(oldId) as { id: string; parent_id: string }[];

      for (const node of nodes) {
        const newNodeId = node.id.replace(oldId, newId);
        const newParentId = node.parent_id.replace(oldId, newId);
        this.db.prepare(
          "UPDATE memory_nodes SET id = ?, parent_id = ?, root_id = ? WHERE id = ?"
        ).run(newNodeId, newParentId, newId, node.id);
        affected++;
      }

      // 2. Rename root entry
      this.db.prepare("UPDATE memories SET id = ? WHERE id = ?").run(newId, oldId);
      affected++;

      // 3. Rename tags (root + node tags)
      const tags = this.db.prepare(
        "SELECT entry_id, tag FROM memory_tags WHERE entry_id = ? OR entry_id LIKE ?"
      ).all(oldId, `${oldId}.%`) as { entry_id: string; tag: string }[];

      for (const t of tags) {
        const newEntryId = t.entry_id === oldId ? newId : t.entry_id.replace(oldId, newId);
        this.db.prepare("DELETE FROM memory_tags WHERE entry_id = ? AND tag = ?").run(t.entry_id, t.tag);
        this.db.prepare("INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)").run(newEntryId, t.tag);
        affected++;
      }

      // 4. Rename FTS rowid-map
      this.db.prepare(
        "UPDATE hmem_fts_rowid_map SET root_id = ? WHERE root_id = ?"
      ).run(newId, oldId);

      const ftsNodes = this.db.prepare(
        "SELECT fts_rowid, node_id FROM hmem_fts_rowid_map WHERE node_id LIKE ?"
      ).all(`${oldId}.%`) as { fts_rowid: number; node_id: string }[];

      for (const fn of ftsNodes) {
        const newNodeId = fn.node_id.replace(oldId, newId);
        this.db.prepare(
          "UPDATE hmem_fts_rowid_map SET node_id = ? WHERE fts_rowid = ?"
        ).run(newNodeId, fn.fts_rowid);
      }

      // 5. Rewrite links in OTHER entries that reference oldId
      const linkRows = this.db.prepare(
        "SELECT id, links FROM memories WHERE links IS NOT NULL AND links LIKE ?"
      ).all(`%${oldId}%`) as { id: string; links: string }[];

      for (const lr of linkRows) {
        try {
          const links = JSON.parse(lr.links) as string[];
          const updated = links.map(l => l === oldId ? newId : l);
          if (JSON.stringify(links) !== JSON.stringify(updated)) {
            this.db.prepare("UPDATE memories SET links = ? WHERE id = ?")
              .run(JSON.stringify(updated), lr.id === oldId ? newId : lr.id);
            affected++;
          }
        } catch { /* skip malformed links */ }
      }

      // 6. Rewrite obsolete markers [✓oldId] in level_1 text
      const obsoleteRows = this.db.prepare(
        "SELECT id, level_1 FROM memories WHERE level_1 LIKE ?"
      ).all(`%[✓${oldId}]%`) as { id: string; level_1: string }[];

      for (const or_ of obsoleteRows) {
        const newL1 = or_.level_1.replace(`[✓${oldId}]`, `[✓${newId}]`);
        this.db.prepare("UPDATE memories SET level_1 = ? WHERE id = ?")
          .run(newL1, or_.id === oldId ? newId : or_.id);
        affected++;
      }
    });

    doRename();
    return { ok: true, affected };
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
      updated_at: row.updated_at ?? undefined,
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
    text = text.replace(/[\t\r\n]/g, " ").replace(/  +/g, " ").trim();
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

    const l1Title: string[] = [];
    const l1Body: string[] = [];

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

      // Body line detection: "> " prefix marks body text for the preceding node
      const isBodyLine = text.startsWith("> ") || text === ">";
      const bodyText = isBodyLine ? text.replace(/^> ?/, "") : "";

      if (depth === 1) {
        if (isBodyLine) {
          l1Body.push(bodyText);
        } else {
          l1Title.push(text);
        }
        continue;
      }

      if (isBodyLine) {
        // Append body to the last node at this depth
        const lastNode = nodes.length > 0 ? nodes[nodes.length - 1] : null;
        if (lastNode && lastNode.depth === depth) {
          // If content was just the title (no body yet), start fresh body
          if (lastNode.content === lastNode.title) {
            lastNode.content = bodyText;
          } else {
            lastNode.content += "\n" + bodyText;
          }
        }
        continue;
      }

      // L2+: determine parent and generate compound ID
      const parentId = depth === 2 ? rootId : (lastIdAtDepth.get(depth - 1) ?? rootId);
      const seq = (seqAtParent.get(parentId) ?? 0) + 1;
      seqAtParent.set(parentId, seq);
      const nodeId = `${parentId}.${seq}`;
      lastIdAtDepth.set(depth, nodeId);

      const sanitizedTitle = text.replace(/[\t\r\n]/g, " ").replace(/  +/g, " ").trim();
      nodes.push({ id: nodeId, parent_id: parentId, depth, seq, content: text, title: sanitizedTitle });
    }

    // Backward-compatible: nodes without body lines get autoExtractTitle fallback
    for (const node of nodes) {
      if (node.content === node.title || node.content.replace(/[\t\r\n]/g, " ").replace(/  +/g, " ").trim() === node.title) {
        // No body was added — old format: content = full text, title = auto-extracted
        node.title = this.autoExtractTitle(node.content);
      }
      // else: body was added — title stays as explicit title text
    }

    // L1: first non-body line = title, body lines = level1
    let title: string;
    let level1: string;
    if (l1Body.length > 0) {
      title = (l1Title[0] ?? "").replace(/[\t\r\n]/g, " ").replace(/  +/g, " ").trim();
      level1 = l1Body.join("\n");
    } else if (l1Title.length >= 2) {
      title = l1Title[0].replace(/[\t\r\n]/g, " ").replace(/  +/g, " ").trim();
      level1 = l1Title.slice(1).join(" | ");
    } else {
      level1 = l1Title[0] ?? "";
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
  ): Array<{ id: string; parent_id: string; depth: number; seq: number; content: string; title: string }> {
    const seqAtParent = new Map<string, number>();
    // Pre-seed parent so first direct child gets startSeq
    seqAtParent.set(parentId, startSeq - 1);
    const lastIdAtRelDepth = new Map<number, string>();
    const nodes: Array<{ id: string; parent_id: string; depth: number; seq: number; content: string; title: string }> = [];

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

      // Body line detection: "> " prefix marks body text for the preceding node
      const isBodyLine = text.startsWith("> ") || text === ">";
      if (isBodyLine) {
        const bodyText = text.replace(/^> ?/, "");
        const lastNode = nodes.length > 0 ? nodes[nodes.length - 1] : null;
        if (lastNode && lastNode.depth === absDepth) {
          if (lastNode.content === lastNode.title) {
            lastNode.content = bodyText;
          } else {
            lastNode.content += "\n" + bodyText;
          }
        }
        continue;
      }

      const myParentId = relDepth === 0
        ? parentId
        : (lastIdAtRelDepth.get(relDepth - 1) ?? parentId);

      const seq = (seqAtParent.get(myParentId) ?? 0) + 1;
      seqAtParent.set(myParentId, seq);
      const nodeId = `${myParentId}.${seq}`;
      lastIdAtRelDepth.set(relDepth, nodeId);

      const sanitizedTitle = text.replace(/[\t\r\n]/g, " ").replace(/  +/g, " ").trim();
      nodes.push({ id: nodeId, parent_id: myParentId, depth: absDepth, seq, content: text, title: sanitizedTitle });
    }

    // Backward-compatible: nodes without body lines get autoExtractTitle fallback
    for (const node of nodes) {
      if (node.content === node.title || node.content.replace(/[\t\r\n]/g, " ").replace(/  +/g, " ").trim() === node.title) {
        node.title = this.autoExtractTitle(node.content);
      }
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
        const rootRow = this.db.prepare("SELECT prefix, title, level_1, created_at, irrelevant, obsolete FROM memories WHERE id = ?").get(rootId) as any;
        if (!rootRow || rootRow.irrelevant === 1 || rootRow.obsolete === 1) continue;
        if (rootRow.prefix === "O") continue; // O-entries excluded from related discovery
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
        `SELECT id, title, level_1, created_at FROM memories WHERE id IN (${idPlaceholders}) AND seq > 0 AND prefix != 'O' AND irrelevant != 1 AND obsolete != 1 LIMIT ?`
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

  /**
   * Find all entries contextually related to a given entry.
   * Uses per-node weighted tag scoring: for each node of the source entry,
   * compute weighted overlap with each candidate entry's full tag set.
   * Tier weights: rare (<=5 entries) = 3, medium (6-20) = 2, common (>20) = 1.
   * A candidate matches if ANY source node scores >= minTagScore against it.
   * Bidirectional direct links are always included.
   */
  findContext(
    entryId: string,
    minTagScore: number = 5,
    limit: number = 30
  ): { linked: MemoryEntry[]; tagRelated: { entry: MemoryEntry; score: number; matchNode: string }[] } {
    this.guardCorrupted();

    // 1. Source node IDs
    const childRows = this.db.prepare(
      "SELECT id FROM memory_nodes WHERE root_id = ?"
    ).all(entryId) as { id: string }[];
    const nodeIds = [entryId, ...childRows.map(r => r.id)];

    // 2. Tags per source node
    const nodeTagMap = this.fetchTagsBulk(nodeIds);

    // 3. All unique source tags
    const allSourceTags = new Set<string>();
    for (const tags of nodeTagMap.values()) {
      if (tags) tags.forEach(t => allSourceTags.add(t));
    }
    if (allSourceTags.size === 0) {
      return { linked: this.resolveDirectLinks(entryId), tagRelated: [] };
    }

    // 4. Global tag frequencies (count distinct root entries per tag)
    const freqRows = this.db.prepare(`
      SELECT tag, COUNT(DISTINCT
        CASE WHEN entry_id LIKE '%.%'
        THEN SUBSTR(entry_id, 1, INSTR(entry_id, '.') - 1)
        ELSE entry_id END
      ) as freq
      FROM memory_tags GROUP BY tag
    `).all() as { tag: string; freq: number }[];
    const tagFreq = new Map<string, number>();
    for (const r of freqRows) tagFreq.set(r.tag, r.freq);

    // 5. Find candidate entries sharing any source tag
    const srcTagArr = [...allSourceTags];
    const placeholders = srcTagArr.map(() => "?").join(", ");
    const candidateRows = this.db.prepare(`
      SELECT
        CASE WHEN entry_id LIKE '%.%'
        THEN SUBSTR(entry_id, 1, INSTR(entry_id, '.') - 1)
        ELSE entry_id END as root_id,
        tag
      FROM memory_tags
      WHERE tag IN (${placeholders})
    `).all(...srcTagArr) as { root_id: string; tag: string }[];

    // 6. Group candidate tags by root_id (skip self)
    const candidateTagMap = new Map<string, Set<string>>();
    for (const r of candidateRows) {
      if (r.root_id === entryId) continue;
      let set = candidateTagMap.get(r.root_id);
      if (!set) { set = new Set(); candidateTagMap.set(r.root_id, set); }
      set.add(r.tag);
    }

    // 7. Score each candidate per source node
    const scored: { id: string; score: number; matchNode: string }[] = [];
    for (const [candidateId, candidateTags] of candidateTagMap) {
      let bestScore = 0;
      let bestNode = "";
      for (const [nodeId, nodeTags] of nodeTagMap) {
        if (!nodeTags) continue;
        let score = 0;
        for (const tag of nodeTags) {
          if (candidateTags.has(tag)) {
            const freq = tagFreq.get(tag) ?? 999;
            if (freq <= 5) score += 3;
            else if (freq <= 20) score += 2;
            else score += 1;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestNode = nodeId;
        }
      }
      if (bestScore >= minTagScore) {
        scored.push({ id: candidateId, score: bestScore, matchNode: bestNode });
      }
    }

    // Sort by score DESC
    scored.sort((a, b) => b.score - a.score);
    const topScored = scored.slice(0, limit);

    // 8. Fetch full entries, filter obsolete + irrelevant
    const tagRelated: { entry: MemoryEntry; score: number; matchNode: string }[] = [];
    for (const s of topScored) {
      const row = this.db.prepare(
        "SELECT * FROM memories WHERE id = ? AND prefix != 'O' AND obsolete != 1 AND irrelevant != 1"
      ).get(s.id) as any;
      if (!row) continue;
      const children = this.fetchChildren(row.id);
      const entry = this.rowToEntry(row, children);
      entry.tags = this.fetchTags(row.id);
      tagRelated.push({ entry, score: s.score, matchNode: s.matchNode });
    }

    // 9. Direct links (bidirectional)
    const linked = this.resolveDirectLinks(entryId);

    return { linked, tagRelated };
  }

  /** Resolve bidirectional direct links for an entry + all subnodes, filtering obsolete/irrelevant. */
  private resolveDirectLinks(entryId: string): MemoryEntry[] {
    const linkedRootIds = new Set<string>();

    // All IDs in this entry's tree (root + subnodes)
    const nodeRows = this.db.prepare(
      "SELECT id FROM memory_nodes WHERE root_id = ?"
    ).all(entryId) as { id: string }[];
    const allIds = [entryId, ...nodeRows.map(r => r.id)];

    // Forward links: from root entry
    const rootRow = this.db.prepare("SELECT links FROM memories WHERE id = ?").get(entryId) as any;
    if (rootRow?.links) {
      try {
        for (const lid of JSON.parse(rootRow.links)) {
          const rootId = lid.includes(".") ? lid.split(".")[0] : lid;
          if (rootId !== entryId) linkedRootIds.add(rootId);
        }
      } catch {}
    }

    // Forward links: from subnodes (memory_nodes.links)
    for (const nodeId of allIds) {
      if (nodeId === entryId) continue; // root already handled above
      const nodeRow = this.db.prepare("SELECT links FROM memory_nodes WHERE id = ?").get(nodeId) as any;
      if (nodeRow?.links) {
        try {
          for (const lid of JSON.parse(nodeRow.links)) {
            const rootId = lid.includes(".") ? lid.split(".")[0] : lid;
            if (rootId !== entryId) linkedRootIds.add(rootId);
          }
        } catch {}
      }
    }

    // Reverse links: other root entries linking to any of our IDs
    // Use LIKE '%entryId%' which catches both "P0029" and "P0029.14" etc.
    const reverseRows = this.db.prepare(
      "SELECT id, links FROM memories WHERE links LIKE ? AND id != ?"
    ).all(`%${entryId}%`, entryId) as { id: string; links: string }[];
    for (const r of reverseRows) {
      try {
        const links = JSON.parse(r.links) as string[];
        // Check if any link points to our root or any subnode
        if (links.some(lid => lid === entryId || lid.startsWith(entryId + "."))) {
          linkedRootIds.add(r.id);
        }
      } catch {}
    }

    // Reverse links: other subnodes linking to any of our IDs
    const reverseNodeRows = this.db.prepare(
      "SELECT root_id, links FROM memory_nodes WHERE links LIKE ? AND root_id != ?"
    ).all(`%${entryId}%`, entryId) as { root_id: string; links: string }[];
    for (const r of reverseNodeRows) {
      try {
        const links = JSON.parse(r.links) as string[];
        if (links.some(lid => lid === entryId || lid.startsWith(entryId + "."))) {
          linkedRootIds.add(r.root_id);
        }
      } catch {}
    }

    // Fetch full entries, filter obsolete + irrelevant
    const results: MemoryEntry[] = [];
    for (const rid of linkedRootIds) {
      const lr = this.db.prepare(
        "SELECT * FROM memories WHERE id = ? AND obsolete != 1 AND irrelevant != 1"
      ).get(rid) as any;
      if (!lr) continue;
      const children = this.fetchChildren(lr.id);
      const entry = this.rowToEntry(lr, children);
      entry.tags = this.fetchTags(lr.id);
      results.push(entry);
    }
    return results;
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

/**
 * @deprecated Use resolveHmemPath() (no args) instead. Will be removed in v7.0.
 */
export function resolveHmemPathLegacy(projectDir: string, templateName: string): string {
  console.error("[hmem] DEPRECATED: resolveHmemPathLegacy(projectDir, templateName) — use HMEM_PATH env var instead");
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
 * Resolve the path to the personal .hmem database file.
 * Priority: HMEM_PATH env var > CWD discovery > ~/.hmem/memory.hmem
 */
/** Reliable home directory — on Windows, prefer USERPROFILE over os.homedir()
 *  because os.homedir() respects HOME env which may point to a network drive (H:\). */
function safeHomedir(): string {
  if (process.platform === "win32" && process.env.USERPROFILE) {
    return process.env.USERPROFILE;
  }
  return os.homedir();
}

export function resolveHmemPath(cwdOverride?: string): string {
  // Priority 1: HMEM_PATH env var
  const hmemPath = process.env.HMEM_PATH;
  if (hmemPath) {
    const expanded = hmemPath.startsWith("~")
      ? path.join(safeHomedir(), hmemPath.slice(1))
      : hmemPath;
    return path.resolve(expanded);
  }

  // Priority 2: CWD discovery
  const cwd = cwdOverride || process.cwd();
  try {
    const files = fs.readdirSync(cwd).filter(f => f.endsWith(".hmem"));
    if (files.length === 1) return path.resolve(cwd, files[0]);
    if (files.length > 1) {
      throw new Error(`Multiple .hmem files in ${cwd}: ${files.join(", ")}. Set HMEM_PATH to pick one.`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Multiple")) throw e;
  }

  // Priority 3: default
  return path.resolve(safeHomedir(), ".hmem", "memory.hmem");
}

/**
 * @deprecated Use `new HmemStore(resolveHmemPath(), config)` instead.
 */
export function openAgentMemory(projectDir: string, templateName: string, config?: HmemConfig): HmemStore {
  console.error("[hmem] DEPRECATED: openAgentMemory() — use new HmemStore(resolveHmemPath(), config)");
  const hmemPath = resolveHmemPathLegacy(projectDir, templateName);
  return new HmemStore(hmemPath, config);
}

/**
 * Open (or create) the shared company knowledge store (company.hmem).
 */
export function openCompanyMemory(projectDir: string, config?: HmemConfig): HmemStore {
  const hmemPath = path.join(projectDir, "company.hmem");
  return new HmemStore(hmemPath, config);
}

export interface AgentRouteResult {
  agent: string;
  score: number;
  entryCount: number;
  topEntries: { id: string; title: string; score: number }[];
}

/**
 * Route a task to the best-matching agent based on memory content.
 * @deprecated This function scans the Agents/ directory structure which is being phased out.
 * Future versions will use a config-based file list instead.
 *
 * Scans all agent .hmem files in the project directory and scores them
 * against the provided tags and/or search keywords.
 *
 * Scoring: for each agent store, find entries sharing the given tags
 * with tier-weighted scoring (rare=3, medium=2, common=1).
 * FTS5 keyword matching supplements tag scoring.
 */
export function routeTask(
  projectDir: string,
  tags: string[],
  keywords?: string,
  limit: number = 5,
  config?: HmemConfig,
): AgentRouteResult[] {
  // Discover all agent .hmem files — requires multi-agent setup
  const agentsDir = path.join(projectDir, "Agents");
  if (!fs.existsSync(agentsDir)) return [];

  const agentDirs = fs.readdirSync(agentsDir).filter(name => {
    const agentPath = path.join(agentsDir, name);
    return fs.statSync(agentPath).isDirectory() &&
      fs.existsSync(path.join(agentPath, `${name}.hmem`));
  });

  const results: AgentRouteResult[] = [];

  for (const agentName of agentDirs) {
    const hmemPath = path.join(agentsDir, agentName, `${agentName}.hmem`);
    let db: Database.Database;
    try {
      db = new Database(hmemPath, { readonly: true });
    } catch { continue; }

    try {
      let agentScore = 0;
      const topEntries: { id: string; title: string; score: number }[] = [];

      // Phase 1: Tag-based scoring
      if (tags.length > 0) {
        // Get global tag frequencies for THIS store
        const freqRows = db.prepare(`
          SELECT tag, COUNT(DISTINCT
            CASE WHEN entry_id LIKE '%.%'
            THEN SUBSTR(entry_id, 1, INSTR(entry_id, '.') - 1)
            ELSE entry_id END
          ) as freq FROM memory_tags GROUP BY tag
        `).all() as { tag: string; freq: number }[];
        const tagFreq = new Map<string, number>();
        for (const r of freqRows) tagFreq.set(r.tag, r.freq);

        // Find entries sharing any of the given tags
        const normalizedTags = tags.map(t => t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`);
        const placeholders = normalizedTags.map(() => "?").join(", ");
        const matchRows = db.prepare(`
          SELECT
            CASE WHEN entry_id LIKE '%.%'
            THEN SUBSTR(entry_id, 1, INSTR(entry_id, '.') - 1)
            ELSE entry_id END as root_id,
            tag
          FROM memory_tags WHERE tag IN (${placeholders})
        `).all(...normalizedTags) as { root_id: string; tag: string }[];

        // Group by root and score
        const byRoot = new Map<string, Set<string>>();
        for (const r of matchRows) {
          if (r.root_id.startsWith("O")) continue; // skip O-entries
          let set = byRoot.get(r.root_id);
          if (!set) { set = new Set(); byRoot.set(r.root_id, set); }
          set.add(r.tag);
        }

        for (const [rootId, matchedTags] of byRoot) {
          let entryScore = 0;
          for (const tag of matchedTags) {
            const freq = tagFreq.get(tag) ?? 999;
            if (freq <= 5) entryScore += 3;
            else if (freq <= 20) entryScore += 2;
            else entryScore += 1;
          }
          agentScore += entryScore;

          // Get entry title
          const row = db.prepare(
            "SELECT title, level_1 FROM memories WHERE id = ? AND obsolete != 1 AND irrelevant != 1"
          ).get(rootId) as any;
          if (row) {
            topEntries.push({
              id: rootId,
              title: row.title || row.level_1?.substring(0, 50) || rootId,
              score: entryScore,
            });
          }
        }
      }

      // Phase 2: FTS5 keyword supplement
      if (keywords && keywords.trim().length > 0) {
        try {
          const words = keywords.trim().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
          if (words.length > 0) {
            const orQuery = words.join(" OR ");
            const ftsRows = db.prepare(`
              SELECT rm.root_id, rm.node_id FROM hmem_fts_rowid_map rm
              JOIN hmem_fts f ON f.rowid = rm.fts_rowid
              WHERE hmem_fts MATCH ? LIMIT 20
            `).all(orQuery) as { root_id: string; node_id: string }[];

            const ftsRoots = new Set(ftsRows.map(r => r.root_id).filter(id => !id.startsWith("O")));
            for (const rootId of ftsRoots) {
              if (topEntries.some(e => e.id === rootId)) continue; // already scored via tags
              const row = db.prepare(
                "SELECT title, level_1 FROM memories WHERE id = ? AND obsolete != 1 AND irrelevant != 1"
              ).get(rootId) as any;
              if (row) {
                agentScore += 1; // FTS matches get 1 point each
                topEntries.push({
                  id: rootId,
                  title: row.title || row.level_1?.substring(0, 50) || rootId,
                  score: 1,
                });
              }
            }
          }
        } catch { /* FTS5 may not exist in all stores */ }
      }

      if (agentScore > 0) {
        // Sort entries by score, keep top 5
        topEntries.sort((a, b) => b.score - a.score);
        results.push({
          agent: agentName,
          score: agentScore,
          entryCount: topEntries.length,
          topEntries: topEntries.slice(0, 5),
        });
      }
    } finally {
      db.close();
    }
  }

  // Sort agents by score
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

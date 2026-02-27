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
import { DEFAULT_CONFIG, DEFAULT_PREFIX_DESCRIPTIONS } from "./hmem-config.js";
// Prefixes are now loaded from config — see this.cfg.prefixes
const ROLE_LEVEL = {
    worker: 0, al: 1, pl: 2, ceo: 3,
};
// (limits are now instance-level via this.cfg.maxCharsPerLevel)
/** All roles that a given role may see (itself + below). */
function allowedRoles(role) {
    const level = ROLE_LEVEL[role];
    return Object.keys(ROLE_LEVEL).filter(r => ROLE_LEVEL[r] <= level);
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
];
// ---- HmemStore class ----
export class HmemStore {
    db;
    dbPath;
    cfg;
    /** True if integrity_check found errors on open (read-only mode recommended). */
    corrupted;
    constructor(hmemPath, config) {
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
            const result = this.db.pragma("integrity_check");
            const status = result[0]?.integrity_check ?? "unknown";
            if (status !== "ok") {
                this.corrupted = true;
                const backupPath = hmemPath + ".corrupt";
                console.error(`[hmem] WARNING: Database corrupted! integrity_check: ${status}`);
                if (!fs.existsSync(backupPath)) {
                    fs.copyFileSync(hmemPath, backupPath);
                    console.error(`[hmem] Backup saved to ${backupPath}`);
                }
                console.error(`[hmem] Attempting to continue — reads may be incomplete.`);
            }
        }
        catch (e) {
            this.corrupted = true;
            console.error(`[hmem] WARNING: integrity_check failed: ${e}`);
        }
        this.db.exec(SCHEMA);
        this.migrate();
        this.migrateToTree();
        this.migrateHeaders();
        this.migrateObsoleteAccessCount();
    }
    /** Throw if the database is corrupted — prevents silent data loss on write operations. */
    guardCorrupted() {
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
    write(prefix, content, links, minRole = "worker", favorite) {
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
        if (level1.length > l1Limit) {
            throw new Error(`Level 1 exceeds ${l1Limit} character limit (${level1.length} chars). Keep L1 compact.`);
        }
        for (const node of nodes) {
            // depth 2-5 → index 1-4
            const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(node.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
            if (node.content.length > nodeLimit) {
                throw new Error(`L${node.depth} content exceeds ${nodeLimit} character limit ` +
                    `(${node.content.length} chars). Split into multiple write_memory calls or use file references.`);
            }
        }
        const insertRoot = this.db.prepare(`
      INSERT INTO memories (id, prefix, seq, created_at, title, level_1, level_2, level_3, level_4, level_5, links, min_role, favorite)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
    `);
        const insertNode = this.db.prepare(`
      INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
        // Run in a transaction
        this.db.transaction(() => {
            insertRoot.run(rootId, prefix, seq, timestamp, title, level1, links ? JSON.stringify(links) : null, minRole, favorite ? 1 : 0);
            for (const node of nodes) {
                insertNode.run(node.id, node.parent_id, rootId, node.depth, node.seq, node.title, node.content, timestamp);
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
    read(opts = {}) {
        const limit = opts.limit; // undefined = no limit (all entries)
        const roleFilter = this.buildRoleFilter(opts.agentRole);
        // Single entry by ID (root or compound node)
        if (opts.id) {
            const isNode = opts.id.includes(".");
            if (isNode) {
                // Compound node ID — fetch from memory_nodes
                const row = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(opts.id);
                if (!row)
                    return [];
                this.bumpNodeAccess(opts.id);
                const nodeDepth = row.depth ?? 2;
                // expand: fetch requested depth + 1 extra level (for boundary titles)
                const expandDepth = opts.expand ? (opts.depth || 5) + 1 : nodeDepth + 1;
                const children = this.fetchChildrenDeep(opts.id, nodeDepth + 1, expandDepth);
                const entry = this.nodeToEntry(this.rowToNode(row), children);
                if (opts.expand)
                    entry.expanded = true;
                return [entry];
            }
            else {
                // Root ID — fetch from memories
                const sql = `SELECT * FROM memories WHERE id = ?${roleFilter.sql ? ` AND ${roleFilter.sql}` : ""}`;
                const row = this.db.prepare(sql).get(opts.id, ...roleFilter.params);
                if (!row)
                    return [];
                // ── Obsolete chain resolution ──
                const shouldFollow = opts.followObsolete !== false; // default: true
                if (shouldFollow && row.obsolete === 1) {
                    const { finalId, chain } = this.resolveObsoleteChain(opts.id);
                    if (chain.length > 1) {
                        // Chain resolved — return final entry (or full path)
                        if (opts.showObsoletePath) {
                            // Return ALL entries in the chain
                            const entries = [];
                            for (const chainId of chain) {
                                const chainRow = this.db.prepare(sql).get(chainId, ...roleFilter.params);
                                if (!chainRow)
                                    continue;
                                const children = this.fetchChildren(chainId);
                                const entry = this.rowToEntry(chainRow, children);
                                entry.obsoleteChain = chain;
                                entries.push(entry);
                            }
                            // Bump access on the final (valid) entry only
                            this.bumpAccess(finalId);
                            return entries;
                        }
                        else {
                            // Return ONLY the final valid entry
                            this.bumpAccess(finalId);
                            const finalRow = this.db.prepare(sql).get(finalId, ...roleFilter.params);
                            if (!finalRow)
                                return []; // correction target inaccessible
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
                if (opts.expand)
                    entry.expanded = true;
                // Auto-resolve links
                this.resolveEntryLinks(entry, opts);
                return [entry];
            }
        }
        // Time-around: find entries created around the same time as a reference entry
        if (opts.timeAround) {
            const refId = opts.timeAround;
            const isRefNode = refId.includes(".");
            let refTime = null;
            if (isRefNode) {
                const refRow = this.db.prepare("SELECT created_at FROM memory_nodes WHERE id = ?").get(refId);
                refTime = refRow?.created_at ?? null;
            }
            else {
                const refRow = this.db.prepare("SELECT created_at FROM memories WHERE id = ?").get(refId);
                refTime = refRow?.created_at ?? null;
            }
            if (!refTime)
                return [];
            const refDate = new Date(refTime);
            const { start, end } = this.parseTimeWindow(refDate, opts.period ?? "both");
            const conditions = ["seq > 0", "created_at >= ?", "created_at <= ?"];
            const params = [start.toISOString(), end.toISOString()];
            if (roleFilter.sql) {
                conditions.push(roleFilter.sql);
                params.push(...roleFilter.params);
            }
            const where = `WHERE ${conditions.join(" AND ")}`;
            const rows = this.db.prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC`).all(...params);
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
            const nodeRows = this.db.prepare(`SELECT DISTINCT root_id FROM memory_nodes WHERE content LIKE ?${nodeLimitClause}`).all(pattern);
            const nodeRootIds = new Set(nodeRows.map(r => r.root_id));
            const memLimitClause = limit !== undefined ? ` LIMIT ${limit}` : "";
            const memRows = this.db.prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC${memLimitClause}`).all(pattern, ...roleFilter.params);
            // Merge: include any roots found in node search too
            const allIds = new Set(memRows.map((r) => r.id));
            const extraIds = [...nodeRootIds].filter(id => !allIds.has(id));
            let extraRows = [];
            if (extraIds.length > 0) {
                const placeholders = extraIds.map(() => "?").join(", ");
                const extraWhere = roleFilter.sql
                    ? `WHERE id IN (${placeholders}) AND seq > 0 AND ${roleFilter.sql}`
                    : `WHERE id IN (${placeholders}) AND seq > 0`;
                extraRows = this.db.prepare(`SELECT * FROM memories ${extraWhere} ORDER BY created_at DESC`).all(...extraIds, ...roleFilter.params);
            }
            const allRows = [...memRows, ...extraRows];
            for (const row of allRows)
                this.bumpAccess(row.id);
            return allRows.map(r => this.rowToEntry(r));
        }
        // Build filtered bulk query (exclude headers: seq > 0)
        const conditions = ["seq > 0"];
        const params = [];
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
    `).all(...params);
        if (opts.prefix || opts.after || opts.before) {
            for (const row of rows)
                this.bumpAccess(row.id);
        }
        return this.readBulkV2(rows, opts);
    }
    /**
     * V2 bulk-read algorithm: per-prefix expansion, smart obsolete filtering,
     * expanded entries with all L2 children + links.
     */
    readBulkV2(rows, opts) {
        const v2 = this.cfg.bulkReadV2;
        // Step 0: Filter out irrelevant entries (never shown in bulk reads)
        const irrelevantCount = rows.filter(r => r.irrelevant === 1).length;
        const activeRows = rows.filter(r => r.irrelevant !== 1);
        // Step 1: Separate obsolete from non-obsolete FIRST
        const obsoleteRows = activeRows.filter(r => r.obsolete === 1);
        const nonObsoleteRows = activeRows.filter(r => r.obsolete !== 1);
        // Step 2: Group NON-OBSOLETE by prefix (obsolete must not steal expansion slots)
        const byPrefix = new Map();
        for (const r of nonObsoleteRows) {
            const arr = byPrefix.get(r.prefix);
            if (arr)
                arr.push(r);
            else
                byPrefix.set(r.prefix, [r]);
        }
        // Session cache: filter out already-seen entries completely
        const suppressed = opts.suppressedIds ?? new Set();
        const hasCacheActive = suppressed.size > 0;
        // Step 3: Build expansion set from non-obsolete rows
        const expandedIds = new Set();
        // Mode-based ratios: essentials shifts weight from newest to most-accessed
        const isEssentials = opts.mode === "essentials";
        const totalSlots = v2.topNewestCount + v2.topAccessCount; // 8 by default
        const baseNewest = isEssentials ? Math.max(1, Math.floor(v2.topNewestCount * 0.4)) : v2.topNewestCount;
        const baseAccess = isEssentials ? totalSlots - baseNewest : v2.topAccessCount;
        // Fibonacci-limited counts (when cache is active, use separate Fibonacci values)
        const newestCount = (hasCacheActive && opts.maxNewNewest !== undefined)
            ? opts.maxNewNewest : baseNewest;
        const accessCount = (hasCacheActive && opts.maxNewAccess !== undefined)
            ? opts.maxNewAccess : baseAccess;
        // Per prefix: top N newest (sliding window) + top M most-accessed (backfill)
        for (const [, prefixRows] of byPrefix) {
            // Newest: sliding window — only from unseen entries
            const unseenRows = hasCacheActive
                ? prefixRows.filter(r => !suppressed.has(r.id))
                : prefixRows;
            for (const r of unseenRows.slice(0, newestCount)) {
                expandedIds.add(r.id);
            }
            // Most-accessed: from unseen entries, excluding those already picked as newest.
            // Minimum threshold: access_count >= 2 — a single access can be noise.
            const mostAccessed = [...unseenRows]
                .filter(r => r.access_count >= 2 && !expandedIds.has(r.id))
                .sort((a, b) => this.weightedAccessScore(b) - this.weightedAccessScore(a))
                .slice(0, accessCount);
            for (const r of mostAccessed)
                expandedIds.add(r.id);
        }
        // Global: all unseen favorites
        for (const r of nonObsoleteRows) {
            if (r.favorite === 1 && !suppressed.has(r.id)) {
                expandedIds.add(r.id);
            }
        }
        // topAccess reference for promoted marker (time-weighted, min 2 accesses)
        const topAccess = [...nonObsoleteRows]
            .filter(r => r.access_count >= 2)
            .sort((a, b) => this.weightedAccessScore(b) - this.weightedAccessScore(a))
            .slice(0, v2.topAccessCount);
        // Obsolete entries: only shown when explicitly requested
        const visibleObsolete = opts.showObsolete ? obsoleteRows : [];
        // Step 4: Show expanded entries + visible obsolete (cached entries completely hidden)
        const expandedNonObsolete = nonObsoleteRows.filter(r => expandedIds.has(r.id));
        const visibleRows = [...expandedNonObsolete, ...visibleObsolete];
        const visibleIds = new Set(visibleRows.map(r => r.id));
        // titles_only: V2 selection applies, but skip link resolution
        if (opts.titlesOnly) {
            // Bulk-fetch L2 child counts (one query for all visible entries)
            const allIds = visibleRows.map(r => r.id);
            const childCounts = this.bulkChildCount(allIds);
            return visibleRows.map(r => {
                const isExpanded = expandedIds.has(r.id);
                const totalChildren = childCounts.get(r.id) ?? 0;
                let children;
                let hiddenCount;
                if (isExpanded && totalChildren > 0) {
                    // Fetch L2 children with V2 selection (top newest + accessed), no links
                    const allChildren = this.fetchChildren(r.id);
                    if (allChildren.length > v2.topNewestCount) {
                        const newestSet = new Set([...allChildren]
                            .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
                            .slice(0, v2.topNewestCount)
                            .map(c => c.id));
                        const accessSet = new Set([...allChildren]
                            .filter(c => c.access_count >= 2)
                            .sort((a, b) => this.weightedAccessScore(b) - this.weightedAccessScore(a))
                            .slice(0, v2.topAccessCount)
                            .map(c => c.id));
                        const selectedIds = new Set([...newestSet, ...accessSet]);
                        children = allChildren.filter(c => selectedIds.has(c.id));
                        hiddenCount = allChildren.length - children.length;
                    }
                    else {
                        children = allChildren;
                    }
                }
                else if (totalChildren > 0) {
                    hiddenCount = totalChildren;
                }
                const entry = this.rowToEntry(r, children);
                if (r.favorite === 1)
                    entry.promoted = "favorite";
                else if (topAccess.some(t => t.id === r.id))
                    entry.promoted = "access";
                if (isExpanded)
                    entry.expanded = true;
                if (hiddenCount !== undefined && hiddenCount > 0)
                    entry.hiddenChildrenCount = hiddenCount;
                return entry;
            });
        }
        return visibleRows.map(r => {
            const isExpanded = expandedIds.has(r.id);
            let promoted;
            if (r.favorite === 1)
                promoted = "favorite";
            else if (topAccess.some(t => t.id === r.id))
                promoted = "access";
            let children;
            let linkedEntries;
            let hiddenChildrenCount;
            let hiddenObsoleteLinks = 0;
            let hiddenIrrelevantLinks = 0;
            if (isExpanded) {
                // Fetch all L2 children, then apply V2 selection (same params as L1)
                const allChildren = this.fetchChildren(r.id);
                if (allChildren.length > v2.topNewestCount) {
                    const newestSet = new Set([...allChildren]
                        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
                        .slice(0, v2.topNewestCount)
                        .map(c => c.id));
                    const accessSet = new Set([...allChildren]
                        .filter(c => c.access_count > 0)
                        .sort((a, b) => this.weightedAccessScore(b) - this.weightedAccessScore(a))
                        .slice(0, v2.topAccessCount)
                        .map(c => c.id));
                    const selectedIds = new Set([...newestSet, ...accessSet]);
                    children = allChildren.filter(c => selectedIds.has(c.id));
                    if (children.length < allChildren.length) {
                        hiddenChildrenCount = allChildren.length - children.length;
                    }
                }
                else {
                    children = allChildren;
                }
                // Resolve links — skip entries already visible in bulk read
                const links = r.links ? JSON.parse(r.links) : [];
                if (links.length > 0) {
                    const allLinked = links.flatMap(linkId => {
                        if (visibleIds.has(linkId))
                            return []; // already shown in bulk read
                        try {
                            return this.read({ id: linkId, resolveLinks: false, linkDepth: 0 });
                        }
                        catch {
                            return [];
                        }
                    });
                    for (const e of allLinked) {
                        if (e.obsolete)
                            hiddenObsoleteLinks++;
                        else if (e.irrelevant)
                            hiddenIrrelevantLinks++;
                    }
                    linkedEntries = allLinked.filter(e => !e.obsolete && !e.irrelevant);
                }
            }
            const entry = this.rowToEntry(r, children);
            entry.promoted = promoted;
            entry.expanded = isExpanded;
            if (hiddenChildrenCount !== undefined)
                entry.hiddenChildrenCount = hiddenChildrenCount;
            if (linkedEntries && linkedEntries.length > 0)
                entry.linkedEntries = linkedEntries;
            if (hiddenObsoleteLinks > 0)
                entry.hiddenObsoleteLinks = hiddenObsoleteLinks;
            if (hiddenIrrelevantLinks > 0)
                entry.hiddenIrrelevantLinks = hiddenIrrelevantLinks;
            return entry;
        });
    }
    /**
     * Get all Level 1 entries for injection at agent startup.
     * Does NOT bump access_count (routine injection).
     */
    getLevel1All(agentRole) {
        const roleFilter = this.buildRoleFilter(agentRole);
        const where = roleFilter.sql ? `WHERE seq > 0 AND ${roleFilter.sql}` : "WHERE seq > 0";
        const rows = this.db.prepare(`SELECT id, created_at, level_1 FROM memories ${where} ORDER BY created_at DESC`).all(...roleFilter.params);
        if (rows.length === 0)
            return "";
        return rows.map(r => {
            const date = r.created_at.substring(0, 10);
            return `[${r.id}] ${date} — ${r.level_1}`;
        }).join("\n");
    }
    /**
     * Export entire memory to Markdown for git tracking.
     */
    exportMarkdown() {
        const rows = this.db.prepare("SELECT * FROM memories WHERE seq > 0 ORDER BY prefix, seq").all();
        if (rows.length === 0)
            return "# Memory Export\n\n(empty)\n";
        // Fetch ALL nodes in a single query, group by root_id (avoids N+1)
        const allNodes = this.db.prepare("SELECT * FROM memory_nodes ORDER BY root_id, depth, seq").all();
        const nodesByRoot = new Map();
        for (const n of allNodes) {
            const arr = nodesByRoot.get(n.root_id);
            if (arr)
                arr.push(n);
            else
                nodesByRoot.set(n.root_id, [n]);
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
                const links = JSON.parse(row.links);
                if (links.length > 0)
                    md += `  Links: ${links.join(", ")}\n`;
            }
            md += "\n";
        }
        return md;
    }
    /**
     * Get statistics about the memory store.
     */
    stats() {
        const total = this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE seq > 0").get().c;
        const rows = this.db.prepare("SELECT prefix, COUNT(*) as c FROM memories WHERE seq > 0 GROUP BY prefix").all();
        const byPrefix = {};
        for (const r of rows)
            byPrefix[r.prefix] = r.c;
        return { total, byPrefix };
    }
    /**
     * Update specific fields of an existing root entry (curator use only).
     */
    update(id, fields) {
        this.guardCorrupted();
        const sets = [];
        const params = [];
        for (const [key, val] of Object.entries(fields)) {
            sets.push(`${key} = ?`);
            if (key === "links" && Array.isArray(val)) {
                params.push(JSON.stringify(val));
            }
            else if (key === "obsolete" || key === "favorite" || key === "irrelevant") {
                params.push(val ? 1 : 0);
            }
            else {
                params.push(val);
            }
        }
        if (sets.length === 0)
            return false;
        params.push(id);
        const result = this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
        return result.changes > 0;
    }
    /**
     * Delete an entry by ID (curator use only).
     * Also deletes all associated memory_nodes.
     */
    delete(id) {
        this.guardCorrupted();
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
    updateNode(id, newContent, links, obsolete, favorite, curatorBypass, irrelevant) {
        this.guardCorrupted();
        const trimmed = newContent.trim();
        if (id.includes(".")) {
            // Sub-node in memory_nodes — check char limit for its depth
            const nodeRow = this.db.prepare("SELECT depth FROM memory_nodes WHERE id = ?").get(id);
            if (!nodeRow)
                return false;
            const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(nodeRow.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
            if (trimmed.length > nodeLimit) {
                throw new Error(`Content exceeds ${nodeLimit} character limit (${trimmed.length} chars) for L${nodeRow.depth}.`);
            }
            const sets = ["content = ?", "title = ?"];
            const params = [trimmed, this.autoExtractTitle(trimmed)];
            if (favorite !== undefined) {
                sets.push("favorite = ?");
                params.push(favorite ? 1 : 0);
            }
            params.push(id);
            const result = this.db.prepare(`UPDATE memory_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...params);
            return result.changes > 0;
        }
        else {
            // Root entry in memories — check L1 char limit
            const l1Limit = this.cfg.maxCharsPerLevel[0];
            if (trimmed.length > l1Limit) {
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
                const oldEntry = this.db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id);
                if (oldEntry && oldEntry.access_count > 0) {
                    const now = new Date().toISOString();
                    if (existsInMemories) {
                        this.db.prepare("UPDATE memories SET access_count = access_count + ?, last_accessed = ? WHERE id = ?")
                            .run(oldEntry.access_count, now, correctionId);
                    }
                    else {
                        this.db.prepare("UPDATE memory_nodes SET access_count = access_count + ?, last_accessed = ? WHERE id = ?")
                            .run(oldEntry.access_count, now, correctionId);
                    }
                }
            }
            const sets = ["level_1 = ?", "title = ?"];
            const params = [trimmed, this.autoExtractTitle(trimmed)];
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
    appendChildren(parentId, content) {
        this.guardCorrupted();
        const parentIsRoot = !parentId.includes(".");
        // Verify parent exists
        if (parentIsRoot) {
            if (!this.db.prepare("SELECT id FROM memories WHERE id = ?").get(parentId)) {
                throw new Error(`Root entry "${parentId}" not found.`);
            }
        }
        else {
            if (!this.db.prepare("SELECT id FROM memory_nodes WHERE id = ?").get(parentId)) {
                throw new Error(`Node "${parentId}" not found.`);
            }
        }
        const parentDepth = parentIsRoot ? 1 : (parentId.match(/\./g).length + 1);
        const rootId = parentIsRoot ? parentId : parentId.split(".")[0];
        // Find next available seq for direct children of parent
        const maxSeqRow = this.db.prepare("SELECT MAX(seq) as maxSeq FROM memory_nodes WHERE parent_id = ?").get(parentId);
        const startSeq = (maxSeqRow?.maxSeq ?? 0) + 1;
        const nodes = this.parseRelativeTree(content, parentId, parentDepth, startSeq);
        if (nodes.length === 0)
            return { count: 0, ids: [] };
        // Validate char limits before writing
        for (const node of nodes) {
            const nodeLimit = this.cfg.maxCharsPerLevel[Math.min(node.depth - 1, this.cfg.maxCharsPerLevel.length - 1)];
            if (node.content.length > nodeLimit) {
                throw new Error(`L${node.depth} content exceeds ${nodeLimit} character limit ` +
                    `(${node.content.length} chars). Split into multiple calls or use file references.`);
            }
        }
        const timestamp = new Date().toISOString();
        const insertNode = this.db.prepare(`
      INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const topLevelIds = [];
        this.db.transaction(() => {
            for (const node of nodes) {
                insertNode.run(node.id, node.parent_id, rootId, node.depth, node.seq, this.autoExtractTitle(node.content), node.content, timestamp);
                if (node.parent_id === parentId)
                    topLevelIds.push(node.id);
            }
        })();
        // Bubble-up: bump access on the direct parent and root entry
        if (parentId.includes(".")) {
            // Parent is a node → bump the node + bump the root
            this.bumpNodeAccess(parentId);
            this.bumpAccess(rootId);
        }
        else {
            // Parent is root → bump the root
            this.bumpAccess(parentId);
        }
        return { count: nodes.length, ids: topLevelIds };
    }
    /**
     * Bump access_count on a root entry or node.
     * Returns true if the entry was found and bumped.
     */
    bump(id, increment = 1) {
        this.guardCorrupted();
        const now = new Date().toISOString();
        if (id.includes(".")) {
            const r = this.db.prepare("UPDATE memory_nodes SET access_count = access_count + ?, last_accessed = ? WHERE id = ?").run(increment, now, id);
            return r.changes > 0;
        }
        else {
            const r = this.db.prepare("UPDATE memories SET access_count = access_count + ?, last_accessed = ? WHERE id = ?").run(increment, now, id);
            return r.changes > 0;
        }
    }
    /**
     * Get all header entries (seq=0) for grouped output formatting.
     */
    getHeaders() {
        const rows = this.db.prepare("SELECT * FROM memories WHERE seq = 0 ORDER BY prefix").all();
        return rows.map(r => {
            const entry = this.rowToEntry(r);
            entry.isHeader = true;
            return entry;
        });
    }
    close() {
        // Flush WAL to main database file before closing — prevents WAL bloat
        // that can lead to corruption on unclean shutdown
        try {
            this.db.pragma("wal_checkpoint(PASSIVE)");
        }
        catch {
            // Best-effort — don't fail close() if checkpoint fails
        }
        this.db.close();
    }
    // ---- Private helpers ----
    migrate() {
        for (const sql of MIGRATIONS) {
            try {
                this.db.exec(sql);
            }
            catch {
                // Column already exists — ignore
            }
        }
    }
    /**
     * One-time migration: move level_2..level_5 data to memory_nodes tree.
     * Idempotent — tracked via schema_version table.
     */
    migrateToTree() {
        const done = this.db.prepare("SELECT value FROM schema_version WHERE key = 'tree_v1'").get();
        if (done)
            return;
        this.db.transaction(() => {
            const insertNode = this.db.prepare(`
        INSERT OR IGNORE INTO memory_nodes (id, parent_id, root_id, depth, seq, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
            // Fetch all rows with at least level_2
            const rows = this.db.prepare("SELECT id, created_at, level_2, level_3, level_4, level_5 FROM memories WHERE level_2 IS NOT NULL").all();
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
            this.db.prepare("UPDATE memories SET level_2=NULL, level_3=NULL, level_4=NULL, level_5=NULL").run();
            // Mark done
            this.db.prepare("INSERT INTO schema_version (key, value) VALUES ('tree_v1', 'done')").run();
        })();
    }
    /**
     * One-time migration: create abstract header entries (X0000) for each prefix.
     * Headers have seq=0 and serve as group separators in bulk reads.
     * Idempotent — tracked via schema_version table.
     */
    migrateHeaders() {
        const done = this.db.prepare("SELECT value FROM schema_version WHERE key = 'headers_v1'").get();
        if (done)
            return;
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
            this.db.prepare("INSERT INTO schema_version (key, value) VALUES ('headers_v1', 'done')").run();
        })();
    }
    /**
     * One-time migration: reset access_count to 0 for all obsolete entries.
     * Entries marked obsolete before the access_count transfer feature was deployed
     * may still have stale access counts. This ensures obsolete entries don't
     * artificially surface in "top most-accessed" rankings.
     */
    migrateObsoleteAccessCount() {
        const done = this.db.prepare("SELECT value FROM schema_version WHERE key = 'obsolete_access_reset_v1'").get();
        if (done)
            return;
        this.db.transaction(() => {
            this.db.prepare("UPDATE memories SET access_count = 0 WHERE obsolete = 1 AND access_count > 0").run();
            // memory_nodes has no obsolete column — only root entries can be obsolete
            this.db.prepare("INSERT INTO schema_version (key, value) VALUES ('obsolete_access_reset_v1', 'done')").run();
        })();
    }
    /**
     * Add a link from sourceId to targetId (idempotent).
     * Only works for root entries (not nodes).
     */
    addLink(sourceId, targetId) {
        if (sourceId.includes(".") || targetId.includes("."))
            return; // nodes don't have links
        const row = this.db.prepare("SELECT links FROM memories WHERE id = ?").get(sourceId);
        if (!row)
            return;
        const links = row.links ? JSON.parse(row.links) : [];
        if (!links.includes(targetId)) {
            links.push(targetId);
            this.db.prepare("UPDATE memories SET links = ? WHERE id = ?").run(JSON.stringify(links), sourceId);
        }
    }
    /**
     * Parse time filter "HH:MM" + date + period into start/end window.
     */
    parseTimeFilter(time, date, period) {
        const [hours, minutes] = time.split(":").map(Number);
        const baseDate = new Date(date);
        baseDate.setHours(hours, minutes, 0, 0);
        return this.parseTimeWindow(baseDate, period ?? "+2h");
    }
    /**
     * Parse a time window around a reference date.
     * period: "+4h" (4h future), "-2h" (2h past), "4h" (±4h symmetric), "both" (±2h default)
     */
    parseTimeWindow(refDate, period) {
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
        }
        else if (direction === "+") {
            return { start: refDate, end: new Date(refDate.getTime() + windowMs) };
        }
        else {
            // No sign = symmetric ±Nh
            return {
                start: new Date(refDate.getTime() - windowMs),
                end: new Date(refDate.getTime() + windowMs),
            };
        }
    }
    buildRoleFilter(agentRole) {
        if (!agentRole)
            return { sql: "", params: [] };
        const roles = allowedRoles(agentRole);
        const placeholders = roles.map(() => "?").join(", ");
        return { sql: `min_role IN (${placeholders})`, params: roles };
    }
    nextSeq(prefix) {
        const row = this.db.prepare("SELECT MAX(seq) as maxSeq FROM memories WHERE prefix = ?").get(prefix);
        return (row?.maxSeq || 0) + 1;
    }
    /** Auto-resolve linked entries on an entry (extracted for reuse in chain resolution). */
    resolveEntryLinks(entry, opts) {
        const linkDepth = opts.resolveLinks === false ? 0 : (opts.linkDepth ?? 1);
        if (linkDepth > 0 && entry.links && entry.links.length > 0) {
            const visited = opts._visitedLinks ?? new Set();
            visited.add(entry.id);
            const allLinked = entry.links.flatMap(linkId => {
                if (visited.has(linkId))
                    return []; // cycle detected — skip
                try {
                    return this.read({
                        id: linkId,
                        agentRole: opts.agentRole,
                        linkDepth: linkDepth - 1,
                        _visitedLinks: visited,
                        followObsolete: false, // don't chain-resolve inside link resolution
                    });
                }
                catch {
                    return [];
                }
            });
            let hiddenObsolete = 0;
            let hiddenIrrelevant = 0;
            for (const e of allLinked) {
                if (e.obsolete)
                    hiddenObsolete++;
                else if (e.irrelevant)
                    hiddenIrrelevant++;
            }
            entry.linkedEntries = allLinked.filter(e => !e.obsolete && !e.irrelevant);
            if (hiddenObsolete > 0)
                entry.hiddenObsoleteLinks = hiddenObsolete;
            if (hiddenIrrelevant > 0)
                entry.hiddenIrrelevantLinks = hiddenIrrelevant;
        }
    }
    bumpAccess(id) {
        this.db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?").run(new Date().toISOString(), id);
    }
    bumpNodeAccess(id) {
        this.db.prepare("UPDATE memory_nodes SET access_count = access_count + 1, last_accessed = ? WHERE id = ?").run(new Date().toISOString(), id);
    }
    /**
     * Follow the obsolete chain from an entry to its final valid correction.
     * Parses [✓ID] from level_1 of each obsolete entry and follows the chain.
     * Returns the final (non-obsolete) entry ID and the full chain of IDs traversed.
     */
    resolveObsoleteChain(id) {
        const chain = [id];
        let currentId = id;
        const visited = new Set();
        for (let i = 0; i < 10; i++) { // max 10 hops
            visited.add(currentId);
            const row = this.db.prepare("SELECT id, level_1, obsolete FROM memories WHERE id = ?").get(currentId);
            if (!row || !row.obsolete)
                break; // not obsolete or not found → stop
            // Parse [✓ID] from level_1
            const match = row.level_1?.match(/\[✓([A-Z]\d{4}(?:\.\d+)*)\]/);
            if (!match)
                break; // no correction reference → stop
            const nextId = match[1];
            if (visited.has(nextId))
                break; // cycle detected → stop
            chain.push(nextId);
            currentId = nextId;
        }
        return { finalId: currentId, chain };
    }
    /** Fetch direct children of a node (root or compound), including their grandchild counts. */
    /** Bulk-fetch direct child counts for multiple parent IDs in one query. */
    bulkChildCount(parentIds) {
        if (parentIds.length === 0)
            return new Map();
        const placeholders = parentIds.map(() => "?").join(", ");
        const rows = this.db.prepare(`SELECT parent_id, COUNT(*) as cnt FROM memory_nodes WHERE parent_id IN (${placeholders}) GROUP BY parent_id`).all(...parentIds);
        const map = new Map();
        for (const r of rows)
            map.set(r.parent_id, r.cnt);
        return map;
    }
    /**
     * Time-weighted access score: newer entries with fewer accesses can outrank
     * older entries with more accesses. Uses logarithmic age decay:
     *   score = access_count / log2(age_in_days + 2)
     */
    weightedAccessScore(row) {
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        const ageDays = Math.max(ageMs / 86_400_000, 0);
        return (row.access_count || 0) / Math.log2(ageDays + 2);
    }
    fetchChildren(parentId) {
        return this.fetchChildrenDeep(parentId, 2, 2);
    }
    /**
     * Fetch only the single most recently created direct child of a parent,
     * along with the total sibling count. Used for token-efficient bulk reads.
     * Returns null if no children exist.
     */
    fetchLatestChild(parentId, maxDepth) {
        const rows = this.db.prepare("SELECT * FROM memory_nodes WHERE parent_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1").all(parentId);
        if (rows.length === 0)
            return null;
        const totalRow = this.db.prepare("SELECT COUNT(*) as c FROM memory_nodes WHERE parent_id = ?").get(parentId);
        const grandchildCount = this.db.prepare("SELECT COUNT(*) as c FROM memory_nodes WHERE parent_id = ?").get(rows[0].id).c;
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
    fetchChildrenDeep(parentId, currentDepth, maxDepth) {
        const rows = this.db.prepare("SELECT * FROM memory_nodes WHERE parent_id = ? ORDER BY seq").all(parentId);
        return rows.map(r => {
            const childCount = this.db.prepare("SELECT COUNT(*) as c FROM memory_nodes WHERE parent_id = ?").get(r.id).c;
            const node = this.rowToNode(r, childCount);
            if (currentDepth < maxDepth && childCount > 0) {
                node.children = this.fetchChildrenDeep(r.id, currentDepth + 1, maxDepth);
            }
            return node;
        });
    }
    rowToNode(row, childCount) {
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
            child_count: childCount,
        };
    }
    rowToEntry(row, children) {
        return {
            id: row.id,
            prefix: row.prefix,
            seq: row.seq,
            created_at: row.created_at,
            title: row.title ?? this.autoExtractTitle(row.level_1),
            level_1: row.level_1,
            level_2: null, // always null post-migration
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
            children,
        };
    }
    /**
     * Wrap a MemoryNode as a MemoryEntry for uniform API return.
     * The formatter detects node entries by checking e.id.includes(".").
     * level_1 is repurposed to carry the node content.
     */
    nodeToEntry(node, children) {
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
    autoExtractTitle(text) {
        const maxLen = this.cfg.maxTitleChars;
        const dashIdx = text.indexOf(" — ");
        if (dashIdx > 0 && dashIdx <= maxLen)
            return text.substring(0, dashIdx);
        if (text.length <= maxLen)
            return text;
        // Truncate at last word boundary before maxLen
        const lastSpace = text.lastIndexOf(" ", maxLen);
        if (lastSpace > maxLen * 0.4)
            return text.substring(0, lastSpace);
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
    parseTree(content, rootId) {
        const seqAtParent = new Map();
        const lastIdAtDepth = new Map();
        const nodes = [];
        const l1Lines = [];
        // Auto-detect space indentation unit: use first indented line (if no tabs present)
        const rawLines = content.split("\n").map(l => l.trimEnd()).filter(Boolean);
        let spaceUnit = 4;
        if (!rawLines.some(l => l.startsWith("\t"))) {
            for (const l of rawLines) {
                const leading = l.length - l.trimStart().length;
                if (leading > 0) {
                    spaceUnit = leading;
                    break;
                }
            }
        }
        for (const line of rawLines) {
            const trimmedEnd = line;
            if (!trimmedEnd)
                continue;
            // Count leading tabs; fall back to auto-detected space unit
            const tabMatch = trimmedEnd.match(/^\t*/);
            const leadingTabs = tabMatch ? tabMatch[0].length : 0;
            let depth;
            if (leadingTabs > 0) {
                depth = Math.min(leadingTabs, 4) + 1; // 1 tab = L2, 2 tabs = L3, etc.
            }
            else {
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
        let title;
        let level1;
        if (l1Lines.length >= 2) {
            title = l1Lines[0];
            level1 = l1Lines.slice(1).join(" | ");
        }
        else {
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
    parseRelativeTree(content, parentId, parentDepth, startSeq) {
        const seqAtParent = new Map();
        // Pre-seed parent so first direct child gets startSeq
        seqAtParent.set(parentId, startSeq - 1);
        const lastIdAtRelDepth = new Map();
        const nodes = [];
        const rawLines = content.split("\n").map(l => l.trimEnd()).filter(Boolean);
        // Auto-detect space unit if no tabs used
        let spaceUnit = 4;
        if (!rawLines.some(l => l.startsWith("\t"))) {
            for (const l of rawLines) {
                const leading = l.length - l.trimStart().length;
                if (leading > 0) {
                    spaceUnit = leading;
                    break;
                }
            }
        }
        const maxAbsDepth = this.cfg.maxDepth;
        for (const line of rawLines) {
            const text = line.trim();
            if (!text)
                continue;
            // Count leading tabs; fall back to space-based detection
            const tabMatch = line.match(/^\t*/);
            const leadingTabs = tabMatch ? tabMatch[0].length : 0;
            let relDepth;
            if (leadingTabs > 0) {
                relDepth = leadingTabs;
            }
            else {
                const leading = line.length - line.trimStart().length;
                relDepth = leading > 0 ? Math.floor(leading / spaceUnit) : 0;
            }
            const absDepth = parentDepth + 1 + relDepth;
            if (absDepth > maxAbsDepth)
                continue; // silently skip beyond max depth
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
export function resolveHmemPath(projectDir, templateName) {
    // No agent name configured → use memory.hmem directly in project root
    if (!templateName || templateName === "UNKNOWN") {
        return path.join(projectDir, "memory.hmem");
    }
    // Named agent → Agents/NAME/NAME.hmem (check Assistenten/ as fallback)
    let agentDir = path.join(projectDir, "Agents", templateName);
    if (!fs.existsSync(agentDir)) {
        const alt = path.join(projectDir, "Assistenten", templateName);
        if (fs.existsSync(alt))
            agentDir = alt;
    }
    return path.join(agentDir, `${templateName}.hmem`);
}
/**
 * Open (or create) an HmemStore for an agent's personal memory.
 */
export function openAgentMemory(projectDir, templateName, config) {
    const hmemPath = resolveHmemPath(projectDir, templateName);
    return new HmemStore(hmemPath, config);
}
/**
 * Open (or create) the shared company knowledge store (company.hmem).
 */
export function openCompanyMemory(projectDir, config) {
    const hmemPath = path.join(projectDir, "company.hmem");
    return new HmemStore(hmemPath, config);
}
//# sourceMappingURL=hmem-store.js.map
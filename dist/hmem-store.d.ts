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
import type { HmemConfig } from "./hmem-config.js";
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
    children?: MemoryNode[];
    linkedEntries?: MemoryEntry[];
    /** If this entry was reached via obsolete chain resolution, the chain of IDs traversed. */
    obsoleteChain?: string[];
}
export interface MemoryNode {
    id: string;
    parent_id: string;
    root_id: string;
    depth: number;
    seq: number;
    /** Short label for navigation (~30 chars). Auto-extracted from content. */
    title: string;
    content: string;
    created_at: string;
    access_count: number;
    last_accessed: string | null;
    child_count?: number;
    children?: MemoryNode[];
}
export interface ReadOptions {
    id?: string;
    depth?: number;
    prefix?: string;
    after?: string;
    before?: string;
    search?: string;
    limit?: number;
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
}
export interface WriteResult {
    id: string;
    timestamp: string;
}
export declare class HmemStore {
    private db;
    private readonly dbPath;
    private readonly cfg;
    /** True if integrity_check found errors on open (read-only mode recommended). */
    readonly corrupted: boolean;
    constructor(hmemPath: string, config?: HmemConfig);
    /** Throw if the database is corrupted — prevents silent data loss on write operations. */
    private guardCorrupted;
    /**
     * Write a new memory entry.
     * Content uses tab indentation to define the tree:
     *   "Project X: built a dashboard\n\tMy role was frontend\n\t\tUsed React + Vite"
     * L1 (no tabs) → memories.level_1
     * Each indented line → its own memory_nodes row with compound ID
     * Multiple lines at the same indent depth → siblings (new capability)
     */
    write(prefix: string, content: string, links?: string[], minRole?: AgentRole, favorite?: boolean): WriteResult;
    /**
     * Read memories with flexible querying.
     *
     * For ID-based queries: always returns the node + its DIRECT children.
     * depth parameter is ignored for ID queries (one level at a time).
     *
     * For bulk queries: returns L1 summaries (depth=1 default).
     */
    read(opts?: ReadOptions): MemoryEntry[];
    /**
     * V2 bulk-read algorithm: per-prefix expansion, smart obsolete filtering,
     * expanded entries with all L2 children + links.
     */
    private readBulkV2;
    /**
     * Get all Level 1 entries for injection at agent startup.
     * Does NOT bump access_count (routine injection).
     */
    getLevel1All(agentRole?: AgentRole): string;
    /**
     * Export entire memory to Markdown for git tracking.
     */
    exportMarkdown(): string;
    /**
     * Get statistics about the memory store.
     */
    stats(): {
        total: number;
        byPrefix: Record<string, number>;
    };
    /**
     * Update specific fields of an existing root entry (curator use only).
     */
    update(id: string, fields: Partial<Pick<MemoryEntry, "level_1" | "level_2" | "level_3" | "level_4" | "level_5" | "links" | "min_role" | "obsolete" | "favorite">>): boolean;
    /**
     * Delete an entry by ID (curator use only).
     * Also deletes all associated memory_nodes.
     */
    delete(id: string): boolean;
    /**
     * Update the text content of an existing root entry or sub-node.
     * For root entries: updates level_1, optionally updates links.
     * For sub-nodes: updates node content only.
     * Does NOT modify children — use appendChildren to extend the tree.
     */
    updateNode(id: string, newContent: string, links?: string[], obsolete?: boolean, favorite?: boolean, curatorBypass?: boolean): boolean;
    /**
     * Append new child nodes under an existing entry (root or node).
     * Content is tab-indented relative to the parent:
     *   0 tabs = direct child of parentId (L_parent+1)
     *   1 tab  = grandchild (L_parent+2), etc.
     * Existing children are preserved; new nodes are added after them.
     * Returns the IDs of newly created top-level children.
     */
    appendChildren(parentId: string, content: string): {
        count: number;
        ids: string[];
    };
    /**
     * Bump access_count on a root entry or node.
     * Returns true if the entry was found and bumped.
     */
    bump(id: string, increment?: number): boolean;
    /**
     * Get all header entries (seq=0) for grouped output formatting.
     */
    getHeaders(): MemoryEntry[];
    close(): void;
    private migrate;
    /**
     * One-time migration: move level_2..level_5 data to memory_nodes tree.
     * Idempotent — tracked via schema_version table.
     */
    private migrateToTree;
    /**
     * One-time migration: create abstract header entries (X0000) for each prefix.
     * Headers have seq=0 and serve as group separators in bulk reads.
     * Idempotent — tracked via schema_version table.
     */
    private migrateHeaders;
    /**
     * One-time migration: reset access_count to 0 for all obsolete entries.
     * Entries marked obsolete before the access_count transfer feature was deployed
     * may still have stale access counts. This ensures obsolete entries don't
     * artificially surface in "top most-accessed" rankings.
     */
    private migrateObsoleteAccessCount;
    /**
     * Add a link from sourceId to targetId (idempotent).
     * Only works for root entries (not nodes).
     */
    private addLink;
    /**
     * Parse time filter "HH:MM" + date + period into start/end window.
     */
    private parseTimeFilter;
    /**
     * Parse a time window around a reference date.
     * period: "+4h" (4h future), "-2h" (2h past), "4h" (±4h symmetric), "both" (±2h default)
     */
    private parseTimeWindow;
    private buildRoleFilter;
    private nextSeq;
    /** Auto-resolve linked entries on an entry (extracted for reuse in chain resolution). */
    private resolveEntryLinks;
    private bumpAccess;
    private bumpNodeAccess;
    /**
     * Follow the obsolete chain from an entry to its final valid correction.
     * Parses [✓ID] from level_1 of each obsolete entry and follows the chain.
     * Returns the final (non-obsolete) entry ID and the full chain of IDs traversed.
     */
    private resolveObsoleteChain;
    /** Fetch direct children of a node (root or compound), including their grandchild counts. */
    /** Bulk-fetch direct child counts for multiple parent IDs in one query. */
    private bulkChildCount;
    /**
     * Time-weighted access score: newer entries with fewer accesses can outrank
     * older entries with more accesses. Uses logarithmic age decay:
     *   score = access_count / log2(age_in_days + 2)
     */
    private weightedAccessScore;
    private fetchChildren;
    /**
     * Fetch only the single most recently created direct child of a parent,
     * along with the total sibling count. Used for token-efficient bulk reads.
     * Returns null if no children exist.
     */
    private fetchLatestChild;
    /**
     * Fetch children recursively up to maxDepth.
     * currentDepth: the depth level of the children being fetched (2 = L2, 3 = L3, …)
     * maxDepth: stop recursing when currentDepth > maxDepth
     */
    private fetchChildrenDeep;
    private rowToNode;
    private rowToEntry;
    /**
     * Wrap a MemoryNode as a MemoryEntry for uniform API return.
     * The formatter detects node entries by checking e.id.includes(".").
     * level_1 is repurposed to carry the node content.
     */
    private nodeToEntry;
    /**
     * Auto-extract a short title from text.
     * Priority: text before " — " > word-boundary truncation > hard truncation.
     */
    private autoExtractTitle;
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
    private parseTree;
    /**
     * Parse tab-indented content relative to a parent node.
     * relDepth 0 = direct child of parent (absDepth = parentDepth + 1).
     * startSeq: the first seq number to assign to direct children (continuing after existing siblings).
     */
    private parseRelativeTree;
}
export declare function resolveHmemPath(projectDir: string, templateName: string): string;
/**
 * Open (or create) an HmemStore for an agent's personal memory.
 */
export declare function openAgentMemory(projectDir: string, templateName: string, config?: HmemConfig): HmemStore;
/**
 * Open (or create) the shared company knowledge store (company.hmem).
 */
export declare function openCompanyMemory(projectDir: string, config?: HmemConfig): HmemStore;

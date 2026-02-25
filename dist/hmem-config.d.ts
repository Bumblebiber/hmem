/**
 * hmem configuration — loaded from hmem.config.json in the project directory.
 * All values have sensible defaults; the config file is optional.
 *
 * Place hmem.config.json in HMEM_PROJECT_DIR (next to your .hmem files).
 *
 * ## Character limits
 *
 * Option A — just set the two endpoints, levels in between are interpolated linearly:
 * {
 *   "maxL1Chars": 500,
 *   "maxLnChars": 50000
 * }
 *
 * Option B — specify all levels explicitly:
 * {
 *   "maxCharsPerLevel": [500, 5000, 15000, 30000, 50000]
 * }
 *
 * Option A and B can be combined; explicit array takes precedence.
 *
 */
export interface HmemConfig {
    /**
     * Max characters per level, indexed by depth (0=L1, 1=L2, …, maxDepth-1=Ln).
     * Computed from maxL1Chars + maxLnChars via linear interpolation if not set explicitly.
     */
    maxCharsPerLevel: number[];
    /** Max tree depth (1 = L1 only, 5 = full depth). Default: 5 */
    maxDepth: number;
    /** Max entries returned by a default bulk read(). Default: 100 */
    defaultReadLimit: number;
    /**
     * Memory category prefixes. Keys are single uppercase letters, values are human-readable names.
     * Default: P=Project, L=Lesson, T=Task, E=Error, D=Decision, M=Milestone, S=Skill, N=Navigator.
     * Users can add custom prefixes (e.g. "R": "Research") in hmem.config.json.
     */
    prefixes: Record<string, string>;
    /**
     * Number of top-accessed entries that are automatically promoted to L2 depth in bulk reads.
     * These are entries with the highest access_count (excluding zero) — "organic favorites".
     * Set to 0 to disable. Default: 5.
     */
    accessCountTopN: number;
    /**
     * Descriptions for prefix category headers (X0000 entries).
     * Used as L1 text for abstract header entries in grouped bulk reads.
     * Users can override or add descriptions in hmem.config.json.
     */
    prefixDescriptions: Record<string, string>;
    /**
     * Max characters for auto-extracted titles. Default: 30.
     * Titles are short labels for navigation (like chapter titles in a book).
     */
    maxTitleChars: number;
    /**
     * V2 bulk-read algorithm tuning parameters.
     * Controls how many entries receive expanded treatment in default reads.
     */
    bulkReadV2: {
        /** Number of top-accessed entries to expand (default: 3) */
        topAccessCount: number;
        /** Number of newest entries to expand (default: 5) */
        topNewestCount: number;
        /** Number of obsolete entries to keep visible (default: 3) */
        topObsoleteCount: number;
    };
}
export declare const DEFAULT_PREFIXES: Record<string, string>;
/**
 * Default descriptions for prefix category headers (X0000 entries).
 * These are used as L1 text for abstract header entries that group
 * entries by category in bulk reads.
 */
export declare const DEFAULT_PREFIX_DESCRIPTIONS: Record<string, string>;
export declare const DEFAULT_CONFIG: HmemConfig;
/**
 * Format prefix map as "P=Project, L=Lesson, ..." for tool descriptions.
 */
export declare function formatPrefixList(prefixes: Record<string, string>): string;
/**
 * Compute a linearly interpolated char-limit array between l1 and ln for `depth` levels.
 * depth=1 → [l1], depth=2 → [l1, ln], depth=5 → [l1, …, ln]
 */
export declare function linearLimits(l1: number, ln: number, depth: number): number[];
/**
 * Load hmem.config.json from projectDir.
 * Unknown keys are ignored. Missing keys fall back to defaults.
 */
export declare function loadHmemConfig(projectDir: string): HmemConfig;

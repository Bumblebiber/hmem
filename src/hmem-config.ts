import fs from "node:fs";
import path from "node:path";

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

export const DEFAULT_PREFIXES: Record<string, string> = {
  P: "Project",
  L: "Lesson",
  T: "Task",
  E: "Error",
  D: "Decision",
  M: "Milestone",
  S: "Skill",
  N: "Navigator",
  H: "Human",
  R: "Rule",
};

/**
 * Default descriptions for prefix category headers (X0000 entries).
 * These are used as L1 text for abstract header entries that group
 * entries by category in bulk reads.
 */
export const DEFAULT_PREFIX_DESCRIPTIONS: Record<string, string> = {
  P: "(P)roject experiences and summaries",
  L: "(L)essons learned and best practices",
  T: "(T)asks and work items",
  E: "(E)rrors encountered and their fixes",
  D: "(D)ecisions and their rationale",
  M: "(M)ilestones and achievements",
  S: "(S)kills and technical knowledge",
  N: "(N)avigation and context notes",
  H: "(H)uman — knowledge about the user",
  R: "(R)ules — user-defined rules and constraints",
};

export const DEFAULT_CONFIG: HmemConfig = {
  maxCharsPerLevel: [120, 2_500, 10_000, 25_000, 50_000],
  maxDepth: 5,
  defaultReadLimit: 100,
  prefixes: { ...DEFAULT_PREFIXES },
  accessCountTopN: 5,
  prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS },
  bulkReadV2: {
    topAccessCount: 3,
    topNewestCount: 5,
    topObsoleteCount: 3,
  },
};

/**
 * Format prefix map as "P=Project, L=Lesson, ..." for tool descriptions.
 */
export function formatPrefixList(prefixes: Record<string, string>): string {
  return Object.entries(prefixes).map(([k, v]) => `${k}=${v}`).join(", ");
}

/**
 * Compute a linearly interpolated char-limit array between l1 and ln for `depth` levels.
 * depth=1 → [l1], depth=2 → [l1, ln], depth=5 → [l1, …, ln]
 */
export function linearLimits(l1: number, ln: number, depth: number): number[] {
  if (depth <= 1) return [l1];
  return Array.from({ length: depth }, (_, i) =>
    Math.round(l1 + (ln - l1) * (i / (depth - 1)))
  );
}

/**
 * Load hmem.config.json from projectDir.
 * Unknown keys are ignored. Missing keys fall back to defaults.
 */
export function loadHmemConfig(projectDir: string): HmemConfig {
  const configPath = path.join(projectDir, "hmem.config.json");
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, prefixes: { ...DEFAULT_PREFIXES }, prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS }, bulkReadV2: { ...DEFAULT_CONFIG.bulkReadV2 } };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const cfg: HmemConfig = {
      ...DEFAULT_CONFIG,
      prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS },
      bulkReadV2: { ...DEFAULT_CONFIG.bulkReadV2 },
    };

    if (typeof raw.maxDepth === "number" && raw.maxDepth >= 1 && raw.maxDepth <= 10) cfg.maxDepth = raw.maxDepth;
    if (typeof raw.defaultReadLimit === "number" && raw.defaultReadLimit > 0) cfg.defaultReadLimit = raw.defaultReadLimit;
    if (typeof raw.accessCountTopN === "number" && raw.accessCountTopN >= 0) cfg.accessCountTopN = raw.accessCountTopN;

    // Prefixes: merge user-defined with defaults (user can override or add)
    if (raw.prefixes && typeof raw.prefixes === "object" && !Array.isArray(raw.prefixes)) {
      const merged = { ...DEFAULT_PREFIXES };
      for (const [key, val] of Object.entries(raw.prefixes)) {
        if (typeof key === "string" && /^[A-Z]$/.test(key) && typeof val === "string" && val.length > 0) {
          merged[key] = val;
        }
      }
      cfg.prefixes = merged;
    }

    // Prefix descriptions: merge user-defined with defaults
    if (raw.prefixDescriptions && typeof raw.prefixDescriptions === "object" && !Array.isArray(raw.prefixDescriptions)) {
      for (const [key, val] of Object.entries(raw.prefixDescriptions)) {
        if (typeof key === "string" && /^[A-Z]$/.test(key) && typeof val === "string" && val.length > 0) {
          cfg.prefixDescriptions[key] = val;
        }
      }
    }
    // Also generate descriptions for any new user prefixes that lack descriptions
    for (const key of Object.keys(cfg.prefixes)) {
      if (!cfg.prefixDescriptions[key]) {
        cfg.prefixDescriptions[key] = cfg.prefixes[key];
      }
    }

    // V2 bulk-read tuning
    if (raw.bulkReadV2 && typeof raw.bulkReadV2 === "object") {
      const v2 = raw.bulkReadV2;
      if (typeof v2.topAccessCount === "number" && v2.topAccessCount >= 0) cfg.bulkReadV2.topAccessCount = v2.topAccessCount;
      if (typeof v2.topNewestCount === "number" && v2.topNewestCount >= 0) cfg.bulkReadV2.topNewestCount = v2.topNewestCount;
      if (typeof v2.topObsoleteCount === "number" && v2.topObsoleteCount >= 0) cfg.bulkReadV2.topObsoleteCount = v2.topObsoleteCount;
    }

    // Resolve char limits: explicit array > linear endpoints > default
    if (Array.isArray(raw.maxCharsPerLevel) && raw.maxCharsPerLevel.length >= 1) {
      const levels = raw.maxCharsPerLevel as number[];
      if (levels.every((n: unknown) => typeof n === "number" && n > 0)) {
        const padded = [...levels];
        while (padded.length < cfg.maxDepth) padded.push(padded[padded.length - 1]);
        cfg.maxCharsPerLevel = padded.slice(0, cfg.maxDepth);
      }
    } else if (typeof raw.maxL1Chars === "number" || typeof raw.maxLnChars === "number") {
      const l1 = typeof raw.maxL1Chars === "number" ? raw.maxL1Chars : DEFAULT_CONFIG.maxCharsPerLevel[0];
      const ln = typeof raw.maxLnChars === "number" ? raw.maxLnChars : DEFAULT_CONFIG.maxCharsPerLevel[DEFAULT_CONFIG.maxCharsPerLevel.length - 1];
      cfg.maxCharsPerLevel = linearLimits(l1, ln, cfg.maxDepth);
    } else {
      cfg.maxCharsPerLevel = linearLimits(
        DEFAULT_CONFIG.maxCharsPerLevel[0],
        DEFAULT_CONFIG.maxCharsPerLevel[DEFAULT_CONFIG.maxCharsPerLevel.length - 1],
        cfg.maxDepth
      );
    }

    return cfg;
  } catch (e) {
    console.error(`[hmem] Failed to parse hmem.config.json: ${e}. Using defaults.`);
    return { ...DEFAULT_CONFIG, prefixes: { ...DEFAULT_PREFIXES }, prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS }, bulkReadV2: { ...DEFAULT_CONFIG.bulkReadV2 } };
  }
}

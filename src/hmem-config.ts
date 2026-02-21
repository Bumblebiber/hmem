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
 * ## Recency gradient (recentDepthTiers)
 *
 * Controls how many child levels are inlined for the N most recent entries
 * in a default read() call. Each tier adds depth for the freshest entries:
 *
 * {
 *   "recentDepthTiers": [
 *     { "count": 3,  "depth": 3 },   // last 3 entries  → L1 + L2 + L3
 *     { "count": 10, "depth": 2 }    // last 10 entries → L1 + L2
 *   ]
 * }
 *
 * Tiers are evaluated per-entry: the highest applicable depth wins.
 * Backward compat: legacy "recentChildrenCount": N is treated as
 * [{ "count": N, "depth": 2 }].
 */

export interface DepthTier {
  /** How many of the most recent entries this tier applies to */
  count: number;
  /** Max depth to inline (2 = L2, 3 = L2+L3, etc.) */
  depth: number;
}

export interface HmemConfig {
  /**
   * Max characters per level, indexed by depth (0=L1, 1=L2, …, maxDepth-1=Ln).
   * Computed from maxL1Chars + maxLnChars via linear interpolation if not set explicitly.
   */
  maxCharsPerLevel: number[];
  /** Max tree depth (1 = L1 only, 5 = full depth). Default: 5 */
  maxDepth: number;
  /**
   * Recency gradient: each tier defines how deep to inline children for the N most recent entries.
   * Tiers are cumulative — the highest applicable depth wins for each entry position.
   * Default: last 10 entries show L2, last 3 entries also show L3.
   */
  recentDepthTiers: DepthTier[];
  /** Max entries returned by a default bulk read(). Default: 100 */
  defaultReadLimit: number;
  /**
   * Memory category prefixes. Keys are single uppercase letters, values are human-readable names.
   * Default: P=Project, L=Lesson, T=Task, E=Error, D=Decision, M=Milestone, S=Skill, F=Favorite.
   * Users can add custom prefixes (e.g. "R": "Research") in hmem.config.json.
   */
  prefixes: Record<string, string>;
}

export const DEFAULT_PREFIXES: Record<string, string> = {
  P: "Project",
  L: "Lesson",
  T: "Task",
  E: "Error",
  D: "Decision",
  M: "Milestone",
  S: "Skill",
  F: "Favorite",
};

export const DEFAULT_CONFIG: HmemConfig = {
  maxCharsPerLevel: [120, 2_500, 10_000, 25_000, 50_000],
  maxDepth: 5,
  recentDepthTiers: [
    { count: 10, depth: 2 },
    { count: 3,  depth: 3 },
  ],
  defaultReadLimit: 100,
  prefixes: { ...DEFAULT_PREFIXES },
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
 * Resolve the inline depth for the entry at position `i` (0 = most recent)
 * given the configured tiers. Returns 1 if no tier applies (L1 only).
 */
export function resolveDepthForPosition(i: number, tiers: DepthTier[]): number {
  let maxDepth = 1;
  for (const tier of tiers) {
    if (i < tier.count && tier.depth > maxDepth) {
      maxDepth = tier.depth;
    }
  }
  return maxDepth;
}

/**
 * Load hmem.config.json from projectDir.
 * Unknown keys are ignored. Missing keys fall back to defaults.
 */
export function loadHmemConfig(projectDir: string): HmemConfig {
  const configPath = path.join(projectDir, "hmem.config.json");
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, recentDepthTiers: [...DEFAULT_CONFIG.recentDepthTiers], prefixes: { ...DEFAULT_PREFIXES } };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const cfg: HmemConfig = {
      ...DEFAULT_CONFIG,
      recentDepthTiers: [...DEFAULT_CONFIG.recentDepthTiers],
    };

    if (typeof raw.maxDepth === "number" && raw.maxDepth >= 1 && raw.maxDepth <= 10) cfg.maxDepth = raw.maxDepth;
    if (typeof raw.defaultReadLimit === "number" && raw.defaultReadLimit > 0) cfg.defaultReadLimit = raw.defaultReadLimit;

    // Recency tiers: explicit array > legacy recentChildrenCount > default
    if (Array.isArray(raw.recentDepthTiers)) {
      const tiers = (raw.recentDepthTiers as unknown[]).filter(
        (t): t is DepthTier =>
          typeof (t as DepthTier).count === "number" &&
          typeof (t as DepthTier).depth === "number" &&
          (t as DepthTier).count > 0 &&
          (t as DepthTier).depth >= 1
      );
      if (tiers.length > 0) cfg.recentDepthTiers = tiers;
    } else if (typeof raw.recentChildrenCount === "number" && raw.recentChildrenCount >= 0) {
      // Backward compat: treat as single tier with depth 2
      cfg.recentDepthTiers = raw.recentChildrenCount > 0
        ? [{ count: raw.recentChildrenCount, depth: 2 }]
        : [];
    }

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
    return { ...DEFAULT_CONFIG, recentDepthTiers: [...DEFAULT_CONFIG.recentDepthTiers], prefixes: { ...DEFAULT_PREFIXES } };
  }
}

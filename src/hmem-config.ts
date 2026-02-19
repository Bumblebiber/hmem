import fs from "node:fs";
import path from "node:path";

/**
 * hmem configuration — loaded from hmem.config.json in the project directory.
 * All values have sensible defaults; the config file is optional.
 *
 * Place hmem.config.json in HMEM_PROJECT_DIR (next to your .hmem files).
 *
 * Two ways to set character limits:
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
 */
export interface HmemConfig {
  /**
   * Max characters per level, indexed by depth (0=L1, 1=L2, …, maxDepth-1=Ln).
   * Computed from maxL1Chars + maxLnChars via linear interpolation if not set explicitly.
   */
  maxCharsPerLevel: number[];
  /** Max tree depth (1 = L1 only, 5 = full depth). Default: 5 */
  maxDepth: number;
  /** How many of the most recent entries also show L2 children in a default read(). Default: 10 */
  recentChildrenCount: number;
  /** Max entries returned by a default bulk read(). Default: 100 */
  defaultReadLimit: number;
}

export const DEFAULT_CONFIG: HmemConfig = {
  maxCharsPerLevel: [500, 2_500, 10_000, 25_000, 50_000],
  maxDepth: 5,
  recentChildrenCount: 10,
  defaultReadLimit: 100,
};

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
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const cfg: HmemConfig = { ...DEFAULT_CONFIG };

    if (typeof raw.maxDepth === "number" && raw.maxDepth >= 1 && raw.maxDepth <= 10) cfg.maxDepth = raw.maxDepth;
    if (typeof raw.recentChildrenCount === "number" && raw.recentChildrenCount >= 0) cfg.recentChildrenCount = raw.recentChildrenCount;
    if (typeof raw.defaultReadLimit === "number" && raw.defaultReadLimit > 0) cfg.defaultReadLimit = raw.defaultReadLimit;

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
      // Re-compute default array to match potentially updated maxDepth
      cfg.maxCharsPerLevel = linearLimits(
        DEFAULT_CONFIG.maxCharsPerLevel[0],
        DEFAULT_CONFIG.maxCharsPerLevel[DEFAULT_CONFIG.maxCharsPerLevel.length - 1],
        cfg.maxDepth
      );
    }

    return cfg;
  } catch (e) {
    console.error(`[hmem] Failed to parse hmem.config.json: ${e}. Using defaults.`);
    return { ...DEFAULT_CONFIG };
  }
}

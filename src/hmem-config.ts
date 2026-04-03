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
   * Max characters for auto-extracted titles. Default: 30.
   * Titles are short labels for navigation (like chapter titles in a book).
   */
  maxTitleChars: number;
  /**
   * V2 bulk-read algorithm tuning parameters.
   * Controls how many entries receive expanded treatment in default reads.
   */
  bulkReadV2: {
    /** Number of top-accessed entries to expand — legacy fixed fallback (default: 3) */
    topAccessCount: number;
    /** Number of newest entries to expand — legacy fixed fallback (default: 5) */
    topNewestCount: number;
    /** Number of obsolete entries to keep visible (default: 3) */
    topObsoleteCount: number;
    /** Number of entries with the most sub-nodes to always expand (default: 3) */
    topSubnodeCount: number;
    /** Percentage-based selection (overrides fixed counts when set) */
    newestPercent?: number;
    newestMin?: number;
    newestMax?: number;
    accessPercent?: number;
    accessMin?: number;
    accessMax?: number;
  };
  /**
   * Number of messages between automatic save reminders (checkpoint hook).
   * Set to 0 to disable. Default: 20.
   */
  checkpointInterval: number;
  /**
   * Checkpoint mode: "remind" = inject additionalContext reminder (default),
   * "auto" = spawn a Haiku subagent that saves directly (no user interaction).
   */
  checkpointMode: "remind" | "auto";
  /**
   * Number of recent O-entries (session logs) to inject at startup and on load_project.
   * Set to 0 to disable. Default: 10.
   */
  recentOEntries: number;
  /**
   * Token threshold for context clear recommendation.
   * When cumulative hmem output exceeds this, the agent is told to flush + /clear.
   * Set to 0 to disable. Default: 100000.
   */
  contextTokenThreshold: number;
  /**
   * load_project display configuration: which L2 sections to expand.
   * withBody: L2 seq numbers whose L3 children show title + body (e.g. Overview)
   * withChildren: L2 seq numbers whose L3 children are all listed as titles (e.g. Bugs, Open Tasks)
   * Default: withBody=[1], withChildren=[6,8]
   */
  loadProjectExpand: {
    withBody: number[];
    withChildren: number[];
  };
  /** Sync configuration — single server or array for multi-server redundancy. */
  sync?: SyncConfigBlock | SyncConfigBlock[];
}

export interface SyncConfigBlock {
  /** Display name for this server (optional, for multi-server identification) */
  name?: string;
  serverUrl: string;
  userId: string;
  salt: string;
  token?: string;
  syncSecrets?: boolean;
  lastPushAt?: string | null;
  lastPullAt?: string | null;
}

/** Normalize sync config to always return an array. */
export function getSyncServers(config: HmemConfig): SyncConfigBlock[] {
  if (!config.sync) return [];
  return Array.isArray(config.sync) ? config.sync : [config.sync];
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
  O: "Original",
  I: "Infrastructure",
  C: "Convention",
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
  O: "(O)riginal context — raw session history with progressive summarization (auto-generated by flush_context)",
  I: "(I)nfrastructure — devices, servers, deployments, network. Active device = the one the agent runs on.",
  C: "(C)onventions — reusable patterns, coding standards, and workflows. Entries tagged #universal are loaded with every project.",
};

export const DEFAULT_CONFIG: HmemConfig = {
  maxCharsPerLevel: [200, 2_500, 10_000, 25_000, 50_000],
  maxDepth: 5,
  defaultReadLimit: 100,
  prefixes: { ...DEFAULT_PREFIXES },
  maxTitleChars: 50,
  accessCountTopN: 5,
  prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS },
  checkpointInterval: 5,
  checkpointMode: "remind" as const,
  recentOEntries: 10,
  contextTokenThreshold: 100_000,
  loadProjectExpand: {
    withBody: [1],       // .1 Overview: show L3 title + body
    withChildren: [6, 8], // .6 Bugs, .8 Open Tasks: list all L3 children as titles
  },
  bulkReadV2: {
    topAccessCount: 3,
    topNewestCount: 5,
    topObsoleteCount: 3,
    topSubnodeCount: 3,
    newestPercent: 20,
    newestMin: 5,
    newestMax: 15,
    accessPercent: 10,
    accessMin: 3,
    accessMax: 8,
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
 * Save hmem.config.json in the unified format.
 * Writes maxCharsPerLevel directly (no reverse-computing maxL1Chars/maxLnChars).
 * If a sync token is present, the file is chmod 600 for security.
 */
export function saveHmemConfig(projectDir: string, config: HmemConfig): void {
  const configPath = path.join(projectDir, "hmem.config.json");

  const output: Record<string, unknown> = {
    memory: {
      maxCharsPerLevel: config.maxCharsPerLevel,
      maxDepth: config.maxDepth,
      defaultReadLimit: config.defaultReadLimit,
      maxTitleChars: config.maxTitleChars,
      accessCountTopN: config.accessCountTopN,
      prefixes: config.prefixes,
      prefixDescriptions: config.prefixDescriptions,
      bulkReadV2: config.bulkReadV2,
      recentOEntries: config.recentOEntries,
      contextTokenThreshold: config.contextTokenThreshold,
    },
  };

  if (config.sync) {
    output.sync = config.sync;
  }

  fs.writeFileSync(configPath, JSON.stringify(output, null, 2), "utf-8");

  // Secure file if any sync token is present
  const servers = getSyncServers(config);
  if (servers.some(s => s.token)) {
    try { fs.chmodSync(configPath, 0o600); } catch (e) {
      console.error(`[hmem] WARNING: Could not restrict permissions on ${configPath} — sync token may be exposed: ${e}`);
    }
  }
}

/** Known memory config keys — used to detect unified vs flat format. */
const MEMORY_KEYS = new Set(["maxL1Chars", "maxLnChars", "maxCharsPerLevel", "maxDepth",
  "defaultReadLimit", "prefixes", "prefixDescriptions", "bulkReadV2", "maxTitleChars", "accessCountTopN", "recentOEntries", "contextTokenThreshold", "loadProjectExpand"]);

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

    // Detect unified vs legacy (flat) format.
    // Unified: { memory: { <known keys> }, sync?: { ... } }
    // Legacy:  { maxL1Chars: 200, ... } (memory settings at top level)
    const isUnified = raw.memory && typeof raw.memory === "object"
      && !Array.isArray(raw.memory)
      && Object.keys(raw.memory).some((k: string) => MEMORY_KEYS.has(k));
    const memoryRaw = isUnified ? raw.memory : raw;
    const syncRaw = raw.sync ?? undefined;

    const cfg: HmemConfig = {
      ...DEFAULT_CONFIG,
      prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS },
      bulkReadV2: { ...DEFAULT_CONFIG.bulkReadV2 },
    };

    if (typeof memoryRaw.maxDepth === "number" && memoryRaw.maxDepth >= 1 && memoryRaw.maxDepth <= 10) cfg.maxDepth = memoryRaw.maxDepth;
    if (typeof memoryRaw.defaultReadLimit === "number" && memoryRaw.defaultReadLimit > 0) cfg.defaultReadLimit = memoryRaw.defaultReadLimit;
    if (typeof memoryRaw.accessCountTopN === "number" && memoryRaw.accessCountTopN >= 0) cfg.accessCountTopN = memoryRaw.accessCountTopN;
    if (typeof memoryRaw.maxTitleChars === "number" && memoryRaw.maxTitleChars >= 10 && memoryRaw.maxTitleChars <= 120) cfg.maxTitleChars = memoryRaw.maxTitleChars;
    if (typeof memoryRaw.checkpointInterval === "number" && memoryRaw.checkpointInterval >= 0) cfg.checkpointInterval = memoryRaw.checkpointInterval;
    if (memoryRaw.checkpointMode === "remind" || memoryRaw.checkpointMode === "auto") cfg.checkpointMode = memoryRaw.checkpointMode;
    if (typeof memoryRaw.recentOEntries === "number" && memoryRaw.recentOEntries >= 0) cfg.recentOEntries = memoryRaw.recentOEntries;
    if (typeof memoryRaw.contextTokenThreshold === "number" && memoryRaw.contextTokenThreshold >= 0) cfg.contextTokenThreshold = memoryRaw.contextTokenThreshold;

    // load_project expand config
    if (memoryRaw.loadProjectExpand && typeof memoryRaw.loadProjectExpand === "object") {
      const lpe = memoryRaw.loadProjectExpand;
      if (Array.isArray(lpe.withBody) && lpe.withBody.every((n: unknown) => typeof n === "number")) cfg.loadProjectExpand.withBody = lpe.withBody;
      if (Array.isArray(lpe.withChildren) && lpe.withChildren.every((n: unknown) => typeof n === "number")) cfg.loadProjectExpand.withChildren = lpe.withChildren;
    }

    // Prefixes: merge user-defined with defaults (user can override or add)
    if (memoryRaw.prefixes && typeof memoryRaw.prefixes === "object" && !Array.isArray(memoryRaw.prefixes)) {
      const merged = { ...DEFAULT_PREFIXES };
      for (const [key, val] of Object.entries(memoryRaw.prefixes)) {
        if (typeof key === "string" && /^[A-Z]$/.test(key) && typeof val === "string" && val.length > 0) {
          merged[key] = val;
        }
      }
      cfg.prefixes = merged;
    }

    // Prefix descriptions: merge user-defined with defaults
    if (memoryRaw.prefixDescriptions && typeof memoryRaw.prefixDescriptions === "object" && !Array.isArray(memoryRaw.prefixDescriptions)) {
      for (const [key, val] of Object.entries(memoryRaw.prefixDescriptions)) {
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
    if (memoryRaw.bulkReadV2 && typeof memoryRaw.bulkReadV2 === "object") {
      const v2 = memoryRaw.bulkReadV2;
      if (typeof v2.topAccessCount === "number" && v2.topAccessCount >= 0) cfg.bulkReadV2.topAccessCount = v2.topAccessCount;
      if (typeof v2.topNewestCount === "number" && v2.topNewestCount >= 0) cfg.bulkReadV2.topNewestCount = v2.topNewestCount;
      if (typeof v2.topObsoleteCount === "number" && v2.topObsoleteCount >= 0) cfg.bulkReadV2.topObsoleteCount = v2.topObsoleteCount;
      if (typeof v2.topSubnodeCount === "number" && v2.topSubnodeCount >= 0) cfg.bulkReadV2.topSubnodeCount = v2.topSubnodeCount;
      // Percentage-based selection
      if (typeof v2.newestPercent === "number" && v2.newestPercent > 0) cfg.bulkReadV2.newestPercent = v2.newestPercent;
      if (typeof v2.newestMin === "number" && v2.newestMin >= 0) cfg.bulkReadV2.newestMin = v2.newestMin;
      if (typeof v2.newestMax === "number" && v2.newestMax > 0) cfg.bulkReadV2.newestMax = v2.newestMax;
      if (typeof v2.accessPercent === "number" && v2.accessPercent > 0) cfg.bulkReadV2.accessPercent = v2.accessPercent;
      if (typeof v2.accessMin === "number" && v2.accessMin >= 0) cfg.bulkReadV2.accessMin = v2.accessMin;
      if (typeof v2.accessMax === "number" && v2.accessMax > 0) cfg.bulkReadV2.accessMax = v2.accessMax;
    }

    // Resolve char limits: explicit array > linear endpoints > default
    if (Array.isArray(memoryRaw.maxCharsPerLevel) && memoryRaw.maxCharsPerLevel.length >= 1) {
      const levels = memoryRaw.maxCharsPerLevel as number[];
      if (levels.every((n: unknown) => typeof n === "number" && n > 0)) {
        const padded = [...levels];
        while (padded.length < cfg.maxDepth) padded.push(padded[padded.length - 1]);
        cfg.maxCharsPerLevel = padded.slice(0, cfg.maxDepth);
      }
    } else if (typeof memoryRaw.maxL1Chars === "number" || typeof memoryRaw.maxLnChars === "number") {
      const l1 = typeof memoryRaw.maxL1Chars === "number" ? memoryRaw.maxL1Chars : DEFAULT_CONFIG.maxCharsPerLevel[0];
      const ln = typeof memoryRaw.maxLnChars === "number" ? memoryRaw.maxLnChars : DEFAULT_CONFIG.maxCharsPerLevel[DEFAULT_CONFIG.maxCharsPerLevel.length - 1];
      cfg.maxCharsPerLevel = linearLimits(l1, ln, cfg.maxDepth);
    } else {
      cfg.maxCharsPerLevel = linearLimits(
        DEFAULT_CONFIG.maxCharsPerLevel[0],
        DEFAULT_CONFIG.maxCharsPerLevel[DEFAULT_CONFIG.maxCharsPerLevel.length - 1],
        cfg.maxDepth
      );
    }

    // Parse sync section — supports single object or array (multi-server)
    if (syncRaw) {
      const parseSyncBlock = (s: any): SyncConfigBlock | null => {
        if (!s || typeof s !== "object" || !s.serverUrl || !s.userId || !s.salt) return null;
        return {
          serverUrl: s.serverUrl, userId: s.userId, salt: s.salt,
          token: s.token, syncSecrets: s.syncSecrets !== undefined ? s.syncSecrets : true,
          lastPushAt: s.lastPushAt ?? null, lastPullAt: s.lastPullAt ?? null,
          ...(s.name ? { name: s.name } : {}),
        };
      };
      if (Array.isArray(syncRaw)) {
        const blocks = syncRaw.map(parseSyncBlock).filter((b): b is SyncConfigBlock => b !== null);
        if (blocks.length > 0) cfg.sync = blocks;
      } else {
        const block = parseSyncBlock(syncRaw);
        if (block) cfg.sync = block;
      }
    }

    // Auto-migrate legacy (flat) config to unified { memory: { ... } } format
    if (!isUnified) {
      try {
        // Preserve any extra keys (sync, lastSeenVersion, etc.)
        const migrated: Record<string, unknown> = {};
        migrated.memory = {
          maxCharsPerLevel: cfg.maxCharsPerLevel,
          maxDepth: cfg.maxDepth,
          defaultReadLimit: cfg.defaultReadLimit,
          maxTitleChars: cfg.maxTitleChars,
          accessCountTopN: cfg.accessCountTopN,
          checkpointInterval: cfg.checkpointInterval,
          checkpointMode: cfg.checkpointMode,
          recentOEntries: cfg.recentOEntries,
          contextTokenThreshold: cfg.contextTokenThreshold,
        };
        if (raw.sync) migrated.sync = raw.sync;
        fs.writeFileSync(configPath, JSON.stringify(migrated, null, 2) + "\n", "utf-8");
        console.error(`[hmem] Config auto-migrated to v5 format → hmem.config.json updated`);
      } catch (migErr) {
        console.error(`[hmem] Config migration failed: ${migErr}`);
      }
    }

    return cfg;
  } catch (e) {
    console.error(`[hmem] Failed to parse hmem.config.json: ${e}. Using defaults.`);
    return { ...DEFAULT_CONFIG, prefixes: { ...DEFAULT_PREFIXES }, prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS }, bulkReadV2: { ...DEFAULT_CONFIG.bulkReadV2 } };
  }
}

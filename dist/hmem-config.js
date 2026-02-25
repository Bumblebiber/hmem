import fs from "node:fs";
import path from "node:path";
export const DEFAULT_PREFIXES = {
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
export const DEFAULT_PREFIX_DESCRIPTIONS = {
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
export const DEFAULT_CONFIG = {
    maxCharsPerLevel: [120, 2_500, 10_000, 25_000, 50_000],
    maxDepth: 5,
    defaultReadLimit: 100,
    prefixes: { ...DEFAULT_PREFIXES },
    maxTitleChars: 50,
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
export function formatPrefixList(prefixes) {
    return Object.entries(prefixes).map(([k, v]) => `${k}=${v}`).join(", ");
}
/**
 * Compute a linearly interpolated char-limit array between l1 and ln for `depth` levels.
 * depth=1 → [l1], depth=2 → [l1, ln], depth=5 → [l1, …, ln]
 */
export function linearLimits(l1, ln, depth) {
    if (depth <= 1)
        return [l1];
    return Array.from({ length: depth }, (_, i) => Math.round(l1 + (ln - l1) * (i / (depth - 1))));
}
/**
 * Load hmem.config.json from projectDir.
 * Unknown keys are ignored. Missing keys fall back to defaults.
 */
export function loadHmemConfig(projectDir) {
    const configPath = path.join(projectDir, "hmem.config.json");
    if (!fs.existsSync(configPath)) {
        return { ...DEFAULT_CONFIG, prefixes: { ...DEFAULT_PREFIXES }, prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS }, bulkReadV2: { ...DEFAULT_CONFIG.bulkReadV2 } };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const cfg = {
            ...DEFAULT_CONFIG,
            prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS },
            bulkReadV2: { ...DEFAULT_CONFIG.bulkReadV2 },
        };
        if (typeof raw.maxDepth === "number" && raw.maxDepth >= 1 && raw.maxDepth <= 10)
            cfg.maxDepth = raw.maxDepth;
        if (typeof raw.defaultReadLimit === "number" && raw.defaultReadLimit > 0)
            cfg.defaultReadLimit = raw.defaultReadLimit;
        if (typeof raw.accessCountTopN === "number" && raw.accessCountTopN >= 0)
            cfg.accessCountTopN = raw.accessCountTopN;
        if (typeof raw.maxTitleChars === "number" && raw.maxTitleChars >= 10 && raw.maxTitleChars <= 120)
            cfg.maxTitleChars = raw.maxTitleChars;
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
            if (typeof v2.topAccessCount === "number" && v2.topAccessCount >= 0)
                cfg.bulkReadV2.topAccessCount = v2.topAccessCount;
            if (typeof v2.topNewestCount === "number" && v2.topNewestCount >= 0)
                cfg.bulkReadV2.topNewestCount = v2.topNewestCount;
            if (typeof v2.topObsoleteCount === "number" && v2.topObsoleteCount >= 0)
                cfg.bulkReadV2.topObsoleteCount = v2.topObsoleteCount;
        }
        // Resolve char limits: explicit array > linear endpoints > default
        if (Array.isArray(raw.maxCharsPerLevel) && raw.maxCharsPerLevel.length >= 1) {
            const levels = raw.maxCharsPerLevel;
            if (levels.every((n) => typeof n === "number" && n > 0)) {
                const padded = [...levels];
                while (padded.length < cfg.maxDepth)
                    padded.push(padded[padded.length - 1]);
                cfg.maxCharsPerLevel = padded.slice(0, cfg.maxDepth);
            }
        }
        else if (typeof raw.maxL1Chars === "number" || typeof raw.maxLnChars === "number") {
            const l1 = typeof raw.maxL1Chars === "number" ? raw.maxL1Chars : DEFAULT_CONFIG.maxCharsPerLevel[0];
            const ln = typeof raw.maxLnChars === "number" ? raw.maxLnChars : DEFAULT_CONFIG.maxCharsPerLevel[DEFAULT_CONFIG.maxCharsPerLevel.length - 1];
            cfg.maxCharsPerLevel = linearLimits(l1, ln, cfg.maxDepth);
        }
        else {
            cfg.maxCharsPerLevel = linearLimits(DEFAULT_CONFIG.maxCharsPerLevel[0], DEFAULT_CONFIG.maxCharsPerLevel[DEFAULT_CONFIG.maxCharsPerLevel.length - 1], cfg.maxDepth);
        }
        return cfg;
    }
    catch (e) {
        console.error(`[hmem] Failed to parse hmem.config.json: ${e}. Using defaults.`);
        return { ...DEFAULT_CONFIG, prefixes: { ...DEFAULT_PREFIXES }, prefixDescriptions: { ...DEFAULT_PREFIX_DESCRIPTIONS }, bulkReadV2: { ...DEFAULT_CONFIG.bulkReadV2 } };
    }
}
//# sourceMappingURL=hmem-config.js.map
/**
 * hmem v2 — single config source.
 *
 * One discovery path only: `hmem.config.json` co-located with the `.hmem` store.
 * This deliberately replaces v1's dual-config discovery (env-var path + cwd walk),
 * which caused E0151 / L0180 (two configs disagreeing). User keys deep-merge over
 * DEFAULT_CONFIG; defaults fill any gaps.
 *
 * The per-prefix schema model is generic: `schemas` is keyed by prefix letter, and
 * every prefix is treated identically (no P-hardcoding — kills E0150). The P/E/H/I
 * schemas below are ported verbatim from v1 `hmem-config.ts` (proven conventions).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SchemaSection {
  name: string;
  loadDepth: number; // 0-4
  defaultChildren?: string[];
  /** Short convention describing what belongs in this section. Consumed by the
   *  checkpoint agent and shown as placeholder body in empty sections. ~100 chars. */
  description?: string;
  /** What the checkpoint agent may write here: readonly | pointer | append (default). */
  checkpointPolicy?: 'readonly' | 'pointer' | 'append';
}

export interface EntrySchema {
  sections: SchemaSection[];
  createLinkedO?: boolean;
}

export interface HmemConfig {
  /** Per-prefix entry schemas. Keys are prefix letters ("P", "E", …). Generic. */
  schemas?: Record<string, EntrySchema>;
  prefixes?: Record<string, string>;
  maxTitleChars?: number;
  maxNodeChars?: number;
}

export const DEFAULT_PREFIXES: Record<string, string> = {
  P: 'Project',
  L: 'Lesson',
  T: 'Task',
  E: 'Error',
  D: 'Decision',
  M: 'Milestone',
  S: 'Skill',
  N: 'Navigator',
  H: 'Human',
  R: 'Rule',
  O: 'Original',
  I: 'Infrastructure',
  C: 'Convention',
};

export const DEFAULT_CONFIG: HmemConfig = {
  prefixes: { ...DEFAULT_PREFIXES },
  maxTitleChars: 50,
  maxNodeChars: 100_000,
  schemas: {
    P: {
      sections: [
        { name: 'Overview', loadDepth: 2, description: 'Current state / Goals / Architecture / Environment as L3 (≤4 lines each). L1 body: Name | Status | Tech | Repo' },
        { name: 'Codebase', loadDepth: 1, description: "L3.0 = Pipeline (data flow overview, auto-created). L3.N = Module (title: filename, body: purpose). L4 = exported function/class (title: full signature, body: description + src/file.ts).", defaultChildren: ['Pipeline'] },
        { name: 'Usage', loadDepth: 1, description: 'Installation, CLI/API, common workflows. No code — commands only' },
        { name: 'Context', loadDepth: 1, description: 'Initiator, audience, business context, dependencies as L3' },
        { name: 'Deployment', loadDepth: 1, description: 'Only if relevant. Server, build, CI/CD, release process' },
        { name: 'Bugs', loadDepth: 1, description: 'Open first, fixed marked [✓] or moved to .History. L3 = bug title or pointer → E-entry.' },
        { name: 'History', loadDepth: 0, description: 'Chronological session log. One-liner + pointer to O-entries. No copy-paste snapshots', defaultChildren: ['Tests', 'Code Style', 'Commits'] },
        { name: 'Roadmap', loadDepth: 2, description: '5–8 milestones as L3, main tasks as L4, subtasks as L5. Non-project-specific work → T-entry' },
        { name: 'Ideas', loadDepth: 1, description: 'Brainstorming. L3 = one-liner, L4 = details. Concrete ideas → promote to .Roadmap' },
      ],
    },
    E: {
      sections: [
        { name: 'Reproduction', loadDepth: 1, description: 'Exact steps to trigger. Environment + minimal repro' },
        { name: 'Analysis', loadDepth: 1, description: 'Root cause investigation. What was checked, what was found' },
        { name: 'Possible Fixes', loadDepth: 1, description: 'Candidate approaches with tradeoffs' },
        { name: 'Fixing Attempts', loadDepth: 1, description: "What was tried, what worked, what didn't" },
        { name: 'Solution', loadDepth: 1, description: 'The fix that shipped. Commit hash + one-line summary' },
        { name: 'Cause', loadDepth: 1, description: 'Why the bug existed — the underlying mistake or gap' },
        { name: 'Key Learnings', loadDepth: 1, description: 'Generalizable insight for future work. Tag #open / #solved' },
      ],
    },
    H: {
      sections: [
        { name: 'Identity', loadDepth: 1, description: 'Who the user is — name, contact, GitHub, roles, background. Flat L2 sub-nodes, one fact per node.' },
        { name: 'Work Style', loadDepth: 1, description: 'How the user works — communication style, decision-making, iteration preferences, agent behavior expectations.' },
        { name: 'Priorities', loadDepth: 1, description: 'Current goals, focus areas, what to optimize for.' },
        { name: 'Preferences', loadDepth: 1, description: "Likes and dislikes — what works, what doesn't, what to avoid. Directly actionable for agent behavior." },
      ],
    },
    I: {
      sections: [
        { name: 'Specs', loadDepth: 2, description: 'Hardware or service description. L1 body: Name | Status | Type | Host' },
        { name: 'Access', loadDepth: 1, description: 'Connection methods, ports, credentials location (never store credentials inline)' },
        { name: 'Services', loadDepth: 1, description: 'Running services / provided functions' },
        { name: 'Apps', loadDepth: 1, description: 'Installed software and tools' },
        { name: 'Config', loadDepth: 1, description: 'Important config file paths and settings' },
        { name: 'Notes', loadDepth: 1, description: 'Caveats, quirks, known issues' },
        { name: 'Rules', loadDepth: 1, description: 'Agent rules for working with this resource' },
      ],
    },
  },
};

const PREFIX_KEY = /^[A-Z]{1,2}$/;

/**
 * Load config from `<dir>/hmem.config.json`, deep-merging `schemas` over DEFAULT_CONFIG.
 * Missing file → defaults. User-supplied schema keys win; default keys fill the rest.
 * Malformed prefix keys (not 1–2 uppercase letters) are dropped.
 */
export function loadConfig(dir: string): HmemConfig {
  const merged: HmemConfig = {
    ...DEFAULT_CONFIG,
    prefixes: { ...DEFAULT_CONFIG.prefixes },
    schemas: { ...DEFAULT_CONFIG.schemas },
  };

  const file = join(dir, 'hmem.config.json');
  if (!existsSync(file)) return merged;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return merged; // unreadable/invalid JSON → fall back to defaults, never crash
  }
  if (!raw || typeof raw !== 'object') return merged;
  const user = raw as Partial<HmemConfig>;

  if (typeof user.maxTitleChars === 'number') merged.maxTitleChars = user.maxTitleChars;
  if (typeof user.maxNodeChars === 'number') merged.maxNodeChars = user.maxNodeChars;
  if (user.prefixes && typeof user.prefixes === 'object') {
    merged.prefixes = { ...merged.prefixes, ...user.prefixes };
  }
  if (user.schemas && typeof user.schemas === 'object' && !Array.isArray(user.schemas)) {
    for (const [prefix, schema] of Object.entries(user.schemas)) {
      if (!PREFIX_KEY.test(prefix)) continue;
      if (!schema || typeof schema !== 'object' || !Array.isArray((schema as EntrySchema).sections)) continue;
      merged.schemas![prefix] = schema as EntrySchema;
    }
  }
  return merged;
}

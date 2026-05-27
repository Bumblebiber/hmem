/**
 * hmem v2 — Chunk 6b: LLM knowledge-extraction agent machinery.
 *
 * Two pieces, both network-free / mockable:
 *   1. buildV2ExtractionPrompt — a PURE builder for a SINGLE multi-segment
 *      extraction prompt. One `claude -p` per pipeline run covers ALL selected
 *      segments (timeout-safety design — never one subprocess per segment).
 *   2. runV2ExtractionAgent — spawns `claude -p` with an MCP config so the agent
 *      calls hmem MCP tools DIRECTLY (no JSON parsing of model output). An
 *      injectable `opts.invoke` seam replaces the spawn in tests.
 *
 * Vocabulary is "session segment / events" — v2 has no O-entries, batches, or
 * exchange nodes. The agent cites events by their per-session `seq`.
 *
 * OUT OF SCOPE for this chunk (deferred to a follow-up): per-event titling,
 * per-event tags, `move_nodes`, `rebind_segment`, and `sessions.irrelevant`
 * flagging. See the `DEFERRED:` markers below for the exact hook points.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { HmemConfig } from '../hmem-config.js';
import type { V2Store } from './store-facade.js';
import type { SelectedSegment } from './checkpoint-select.js';
import type { EventRow } from '../store/types.js';
import {
  buildMcpConfig,
  detectHarness,
  hasClaudeBinary,
  type Harness,
} from '../cli-checkpoint-agent.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** One selected segment paired with the unextracted events the agent will read. */
export interface SegmentWithEvents {
  segment: SelectedSegment;
  events: EventRow[];
}

/** The model used for the v2 extraction agent on the free claude -p path. */
export const V2_EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

/**
 * v2-appropriate hmem tools the extraction agent may call. Mirrors the v1
 * allowedTools list MINUS `move_nodes` — v2 has no node-moving (project
 * attribution is derived from `session_bindings`, so a future retroactive fix
 * is a `rebind_segment`, not a move).
 *
 * DEFERRED: a follow-up chunk that implements retroactive segment correction
 * would add `mcp__hmem__rebind_segment` here (NOT `move_nodes`). Likewise, a
 * follow-up that lets the agent flag off-topic segments would add the tool
 * backing `sessions.irrelevant` here (e.g. `mcp__hmem__rebind_segment` with a
 * detach, or a dedicated `mark_session_irrelevant`) and lift the
 * "Do NOT mark anything irrelevant" line from the prompt's MUST NOT block.
 */
export const V2_ALLOWED_TOOLS: string[] = [
  'mcp__hmem__read_memory',
  'mcp__hmem__write_memory',
  'mcp__hmem__append_memory',
  'mcp__hmem__update_memory',
  'mcp__hmem__list_projects',
];

/** Probes injectable in tests to avoid reading ambient env / spawning. */
export interface ExtractionProbes {
  detectHarness?: () => Harness;
  hasClaudeBinary?: () => boolean;
}

export interface RunExtractionOptions {
  /**
   * Injectable seam (REQUIRED for tests). When provided, it is called INSTEAD
   * of spawning `claude -p`. A test fake can simulate the agent by executing
   * scripted hmem writes against the real v2 store and returning — no
   * subprocess, no network.
   */
  invoke?: (args: { prompt: string; mcpConfigPath: string; allowedTools: string[] }) => Promise<void>;
  /** Override harness / claude-binary detection (tests). */
  probes?: ExtractionProbes;
}

// ── Part 1: pure prompt builder ───────────────────────────────────────────────

/** Trim + collapse a single event's content to a bounded, prompt-safe blob. */
function formatEventContent(content: string): string {
  const clean = content.replace(/<channel[^>]*>\s*/g, '').replace(/<\/channel>\s*/g, '').trim();
  return clean.length > 1200 ? clean.slice(0, 1200) + '...' : clean;
}

/**
 * Build ONE extraction prompt covering ALL given segments. Pure and
 * deterministic: identical inputs always produce byte-identical output.
 *
 * @param segments     selected segments + their unextracted events (by seq)
 * @param config       carries `schemas.P.sections` for the routing table
 * @param projectLabel the P-entry label these segments belong to (e.g. "P0042").
 *                     `SelectedSegment` does not carry it (the selector is
 *                     scoped by project), so we take it as an explicit param.
 */
export function buildV2ExtractionPrompt(
  segments: SegmentWithEvents[],
  config: HmemConfig,
  projectLabel: string,
): string {
  // ── Render each segment as a clearly delimited block, events listed by seq ──
  const segmentBlocks = segments
    .map(({ segment, events }) => {
      const header =
        `--- Session segment: ${segment.session_id} ` +
        `[seq ${segment.from_seq}..${segment.toSeqInclusive}] ---`;
      const lines = events
        .map(e => `  seq ${e.seq} ${e.role.toUpperCase()}: ${formatEventContent(e.content)}`)
        .join('\n');
      return `${header}\n${lines || '  (no unextracted events)'}`;
    })
    .join('\n\n');

  // ── P-entry section routing table (schema-agnostic; mirrors v1 :308-324) ────
  const pSchema = config.schemas?.P?.sections ?? [];
  const sectionRouting =
    pSchema.length > 0
      ? pSchema
          .map((s, i) => {
            const idx = i + 1;
            const desc = s.description ? ` — ${s.description}` : '';
            const policy =
              s.checkpointPolicy === 'readonly'
                ? ' [READONLY — do not write]'
                : s.checkpointPolicy === 'pointer'
                  ? ' [POINTER ONLY — e.g. → E00XX Title]'
                  : '';
            return `  .${idx} ${s.name}${desc}${policy}`;
          })
          .join('\n')
      : '  (no schema configured — use standard L2 structure)';

  const readonlySections = pSchema
    .map((s, i) => ({ ...s, idx: i + 1 }))
    .filter(s => s.checkpointPolicy === 'readonly')
    .map(s => `${projectLabel}.${s.idx} (${s.name})`)
    .join(', ');

  return `You are a knowledge-extraction agent for project ${projectLabel}.
You are given one or more SESSION SEGMENTS. Each segment lists its events by
\`seq\` (the per-session monotonic counter). Cite events by seq when relevant.

The event log is IMMUTABLE — you only READ events; you never edit, title, tag,
move, or rebind them. Your job is to mine durable knowledge out of these events
and route it into long-term memory.

== Session Segments ==
${segmentBlocks}

== P-entry Section Routing (${projectLabel}) ==
${sectionRouting}
${readonlySections ? `PROTECTED — never write to: ${readonlySections}\n` : ''}
## Tasks (execute in order):

### 1. Extract knowledge (L / E / D / R / C) — STRICT quality gate
Mine each segment for durable insights and persist with:
  write_memory(prefix="<L|E|D|R|C>", content="Concise insight title\\n> 2-4 sentence explanation with specific details", tags=[3-5 tags], links=["${projectLabel}"])
Valid prefixes: L (lesson), E (error), D (decision), R (rule), C (convention).
Link to the P-label ONLY: links=["${projectLabel}"].

Quality gate — SKIP unless the entry passes ALL checks:
- Would a developer find this useful 6 months from now? If not, skip.
- Is it a specific, actionable insight? Vague observations are NOT lessons.
- Does it already exist in memory? Do NOT duplicate known information.
- NEVER write test, placeholder, or "delete me" entries.
- When in doubt, skip. Writing nothing is better than writing noise.

### 2. Update the project P-entry (DEFAULT: skip)
Do NOT update ${projectLabel} unless a segment contains a concrete, specific
outcome that SHIPPED, was FIXED, or was definitively DECIDED. Discussion,
planning, brainstorming, and "made progress" → skip entirely.

When you do update, honor each section's policy from the routing table above
and append to the addressed section — never create new top-level sections:
  - Correct: append_memory(id="${projectLabel}.<sectionIdx>", content="Title\\n> Details")
  - Wrong:   write_memory or append_memory(id="${projectLabel}") creating a second section
Body before children; one topic = one node; append, don't fragment.
If you already wrote an E-entry above, add only a pointer line in the Bugs
section ("→ E00XX Title"), not a duplicate.
Max 1 P-entry change per run. When uncertain, skip.

## Rules:
- read_memory() FIRST to see current state before writing.
- Match the language of the existing entries and the conversation.
- Tags: 3-5 per entry, lowercase with #.
- Only save what is still valuable in 6 months.

## You MUST NOT:
- Do NOT title individual events. Do NOT tag individual events.
- Do NOT write session summaries — the summarizer owns those.
- Do NOT move or rebind any events or segments.
- Do NOT mark anything irrelevant.`;
}

// ── Part 2: agent runner with injectable invoke ───────────────────────────────

/**
 * Spawn `claude -p` with the v2 MCP config + allowedTools. Mirrors v1's
 * `runClaudeSubprocess` but with the v2 allowedTools (no `move_nodes`) and the
 * v2 extraction model. Kept as the default `opts.invoke` so tests can replace
 * the whole thing.
 */
async function spawnClaude(args: {
  prompt: string;
  mcpConfigPath: string;
  allowedTools: string[];
}): Promise<void> {
  execFileSync(
    'claude',
    [
      '-p',
      '--model',
      V2_EXTRACTION_MODEL,
      '--mcp-config',
      args.mcpConfigPath,
      // v1 passes a single space-separated string; match that shape.
      '--allowedTools',
      args.allowedTools.join(' '),
      '--dangerously-skip-permissions',
    ],
    { input: args.prompt, encoding: 'utf8', timeout: 120_000 },
  );
}

/**
 * Run the v2 knowledge-extraction agent over the selected segments.
 *
 * One prompt for ALL segments → one agent invocation per pipeline run.
 *
 * Routing:
 *   - `opts.invoke` provided        → call it INSTEAD of spawning (test seam).
 *   - claude-code harness + claude  → build MCP config + prompt, spawn claude -p.
 *   - claude binary on PATH         → same (zero-config Max OAuth last resort).
 *   - otherwise                     → safe no-op: log a one-line diagnostic and
 *                                     return. (6c only runs this on a free path,
 *                                     so a warning-and-return is correct here —
 *                                     unlike v1 which throws.)
 *
 * @param projectLabel the P-entry label these segments belong to (e.g. "P0042").
 *                     Not on `SelectedSegment`; passed explicitly (see builder).
 */
export async function runV2ExtractionAgent(
  store: V2Store,
  segments: SegmentWithEvents[],
  config: HmemConfig,
  hmemPath: string,
  projectLabel: string,
  opts: RunExtractionOptions = {},
): Promise<void> {
  if (segments.length === 0) return;

  const prompt = buildV2ExtractionPrompt(segments, config, projectLabel);
  const allowedTools = V2_ALLOWED_TOOLS;

  // ── Test seam: run the fake invoke against the OPEN store, then return. ─────
  // The store stays open here on purpose — the fake invoke executes facade
  // writes (writeMemory/appendMemory) against this very store. No subprocess
  // and no `which hmem` shell-out: pass an empty mcpConfigPath (a real spawn
  // would build one, but the seam contract says the fake never reads it).
  if (opts.invoke) {
    await opts.invoke({ prompt, mcpConfigPath: '', allowedTools });
    return;
  }

  const harness = (opts.probes?.detectHarness ?? detectHarness)();
  const claudeBin = (opts.probes?.hasClaudeBinary ?? hasClaudeBinary)();

  // ── Default path: spawn claude -p (free Max OAuth route). ───────────────────
  // Routes 1 + 4 from v1's ladder collapse to a single `claudeBin` check here:
  // this chunk only builds the free claude -p path; the codex/SDK loops are NOT
  // built in 6b. (`harness` is still read so the diagnostic below can report it.)
  if (claudeBin) {
    const projectDir = path.dirname(hmemPath);
    const mcpConfigPath = buildMcpConfig(projectDir, hmemPath);
    // The MCP child opens the same SQLite file — release our handle first
    // (mirrors v1 runCheckpointAgent store.close() before runClaudeSubprocess).
    store.close();
    try {
      await spawnClaude({ prompt, mcpConfigPath, allowedTools });
    } finally {
      try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(mcpConfigPath)); } catch { /* ignore */ }
    }
    return;
  }

  // ── No usable free route: safe no-op with a one-line diagnostic. ───────────
  // (v1 throws here; 6b deliberately does not — 6c gates on a free path.)
  console.error(
    `[hmem v2 extraction] no free claude -p route (harness=${harness} claudeBin=${claudeBin}); skipping extraction.`,
  );
}

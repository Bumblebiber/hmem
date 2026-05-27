/**
 * Tests for hasFreeExtractionPath() — the predicate that tells callers whether
 * the auto-checkpoint LLM extraction route is FREE (Claude Code Max/OAuth `claude -p`
 * subprocess) vs METERED (Anthropic SDK, OpenAI SDK, or codex route).
 *
 * "Free" = exactly the Claude Code OAuth route via `claude -p`:
 *   route 1: harness === "claude-code" AND claude binary on PATH
 *   route 4: last-resort claude binary (no metered API key present)
 * All other routes are metered.
 *
 * Tests use injected probes for hasClaudeBinary and detectHarness to avoid
 * spawning subprocesses or relying on ambient env.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hasFreeExtractionPath } from '../src/cli-checkpoint-agent.js';
import { DEFAULT_CONFIG } from '../src/hmem-config.js';
import type { HmemConfig } from '../src/hmem-config.js';

// Snapshot/restore env keys touched in tests
const WATCHED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HMEM_HARNESS', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_API_KEY'];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of WATCHED_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of WATCHED_ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

/** A base config with no API key env configured. */
function cfg(overrides: Partial<HmemConfig> = {}): HmemConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Probes: harness=claude-code, binary present */
const claudeCodeWithBinary = {
  detectHarness: () => 'claude-code' as const,
  hasClaudeBinary: () => true,
};

/** Probes: harness=claude-code, binary absent */
const claudeCodeNoBinary = {
  detectHarness: () => 'claude-code' as const,
  hasClaudeBinary: () => false,
};

/** Probes: harness=codex, binary present */
const codexWithBinary = {
  detectHarness: () => 'codex' as const,
  hasClaudeBinary: () => true,
};

/** Probes: harness=unknown, binary present */
const unknownWithBinary = {
  detectHarness: () => 'unknown' as const,
  hasClaudeBinary: () => true,
};

/** Probes: harness=unknown, binary absent */
const unknownNoBinary = {
  detectHarness: () => 'unknown' as const,
  hasClaudeBinary: () => false,
};

describe('hasFreeExtractionPath', () => {

  // ── The four mandatory cases from the spec ──────────────────────────────────

  it('claude-code harness + claude on PATH, no metered override → true (route 1)', () => {
    expect(hasFreeExtractionPath(cfg(), claudeCodeWithBinary)).toBe(true);
  });

  it('ANTHROPIC_API_KEY set, SDK/anthropic route would be used → false (metered, route 3)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(hasFreeExtractionPath(cfg(), unknownNoBinary)).toBe(false);
  });

  it('codex harness + OPENAI_API_KEY → false (metered, route 2)', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    expect(hasFreeExtractionPath(cfg(), codexWithBinary)).toBe(false);
  });

  it('no claude binary, no keys → false (no route available)', () => {
    expect(hasFreeExtractionPath(cfg(), unknownNoBinary)).toBe(false);
  });

  // ── Precedence discriminators (route 1 vs route 3) ─────────────────────────

  it('claude-code + ANTHROPIC_API_KEY set + binary present → true (route 1 wins over route 3)', () => {
    // Ladder hits route 1 BEFORE checking API keys → still free
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(hasFreeExtractionPath(cfg(), claudeCodeWithBinary)).toBe(true);
  });

  it('claude-code harness + binary absent + ANTHROPIC_API_KEY set → false (route 1 skipped, route 3 metered)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(hasFreeExtractionPath(cfg(), claudeCodeNoBinary)).toBe(false);
  });

  // ── Last-resort free path (route 4) ─────────────────────────────────────────

  it('unknown harness + binary present + no API keys → true (route 4 last-resort free)', () => {
    expect(hasFreeExtractionPath(cfg(), unknownWithBinary)).toBe(true);
  });

  it('unknown harness + OPENAI_API_KEY set + provider=openai + binary present → false (route 3 wins over route 4)', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    const openaiCfg = cfg({ checkpointProvider: 'openai' as const });
    expect(hasFreeExtractionPath(openaiCfg, unknownWithBinary)).toBe(false);
  });

  it('unknown harness + ANTHROPIC_API_KEY set + binary present → false (route 3 wins over route 4)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(hasFreeExtractionPath(cfg(), unknownWithBinary)).toBe(false);
  });

  // ── Custom checkpointApiKeyEnv ───────────────────────────────────────────────

  it('custom checkpointApiKeyEnv set and that env var is populated → false (route 3 metered)', () => {
    process.env.MY_CUSTOM_KEY = 'custom-key-value';
    try {
      const customCfg = cfg({ checkpointApiKeyEnv: 'MY_CUSTOM_KEY' });
      expect(hasFreeExtractionPath(customCfg, unknownWithBinary)).toBe(false);
    } finally {
      delete process.env.MY_CUSTOM_KEY;
    }
  });

  it('custom checkpointApiKeyEnv set but env var empty → true (route 4 last-resort, binary present)', () => {
    // MY_CUSTOM_KEY not set → route 3 skipped → binary present → route 4 (free)
    const customCfg = cfg({ checkpointApiKeyEnv: 'MY_CUSTOM_KEY_ABSENT' });
    expect(hasFreeExtractionPath(customCfg, unknownWithBinary)).toBe(true);
  });

  // ── Codex is always metered regardless of binary ─────────────────────────────

  it('codex harness without OPENAI_API_KEY still routes to codex (metered) → false', () => {
    // The ladder hardcodes codex→OpenAI without checking if the key exists
    expect(hasFreeExtractionPath(cfg(), codexWithBinary)).toBe(false);
  });

  // ── opencode / pi / hermes behave like unknown ───────────────────────────────

  it('opencode harness + binary present + no API keys → true (falls through to route 4)', () => {
    const probes = { detectHarness: () => 'opencode' as const, hasClaudeBinary: () => true };
    expect(hasFreeExtractionPath(cfg(), probes)).toBe(true);
  });

  it('hermes harness + ANTHROPIC_API_KEY set → false (route 3 metered)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const probes = { detectHarness: () => 'hermes' as const, hasClaudeBinary: () => false };
    expect(hasFreeExtractionPath(cfg(), probes)).toBe(false);
  });
});

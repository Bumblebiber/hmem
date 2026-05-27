/**
 * Tests for Chunk 8 — async v2-checkpoint Stop hook install + stale v1 checkpoint
 * migration in installClaudeHooksInto / detectStoreIsV2.
 *
 * Exercises:
 *  1. v2 store  → installs exactly ONE async v2-checkpoint Stop hook (timeout:120,
 *     async:true); second call is idempotent (no duplicate).
 *  2. v2 store  → stale `hmem checkpoint` Stop entries are removed; the new
 *     `v2-checkpoint` entry is NOT stripped (boundary test).
 *  3. v1 store  → installs `hmem checkpoint`; does NOT install `v2-checkpoint`.
 *  4. detectStoreIsV2 returns true for a v2 file, false for a v1 file,
 *     and true for a non-existent file.
 *
 * Uses mkdtemp dirs and /tmp only — never touches ~/.hmem.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/store/db.js';
import { installClaudeHooksInto, detectStoreIsV2 } from '../src/cli-init.js';
import { makeV1Fixture } from './migrate/fixture.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'hmem-init-hooks-'));
}

/** Build a minimal v2 file (openDb stamps schema_major=2). */
function buildV2File(filePath: string): void {
  openDb(filePath).close();
}

/** Build a minimal v1 file (memories + memory_nodes tables only). */
function buildV1File(filePath: string): void {
  makeV1Fixture(filePath).close();
}

/** Read and parse the settings.json at `settingsPath`. */
function readSettings(settingsPath: string): any {
  return JSON.parse(readFileSync(settingsPath, 'utf-8'));
}

/** Return all command strings from Stop hooks in settings. */
function stopCommands(settings: any): string[] {
  return (settings.hooks?.Stop ?? []).flatMap(
    (entry: any) => (entry.hooks ?? []).map((h: any) => h.command as string),
  );
}

/** Return the hook objects (not the wrapping entry) from Stop hooks. */
function stopHookObjects(settings: any): any[] {
  return (settings.hooks?.Stop ?? []).flatMap((entry: any) => entry.hooks ?? []);
}

// ── detectStoreIsV2 ───────────────────────────────────────────────────────────

describe('detectStoreIsV2', () => {
  it('returns true for a v2 file', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'v2.hmem');
    buildV2File(filePath);
    expect(detectStoreIsV2(filePath)).toBe(true);
  });

  it('returns false for a v1 file', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'v1.hmem');
    buildV1File(filePath);
    expect(detectStoreIsV2(filePath)).toBe(false);
  });

  it('returns true for a non-existent file (fresh install treated as v2)', () => {
    const filePath = join(tmpDir(), 'does-not-exist.hmem');
    expect(existsSync(filePath)).toBe(false);
    expect(detectStoreIsV2(filePath)).toBe(true);
  });
});

// ── installClaudeHooksInto — v2 store ─────────────────────────────────────────

describe('installClaudeHooksInto — v2 store', () => {
  let dir: string;
  let settingsPath: string;
  let hmemPath: string;

  beforeEach(() => {
    dir = tmpDir();
    settingsPath = join(dir, 'settings.json');
    hmemPath = join(dir, 'memory.hmem');
    buildV2File(hmemPath);
  });

  it('installs exactly one v2-checkpoint Stop hook on fresh settings.json', () => {
    installClaudeHooksInto(settingsPath, hmemPath, true);
    const settings = readSettings(settingsPath);

    const v2CpEntries = (settings.hooks.Stop ?? []).filter((entry: any) =>
      entry.hooks?.some((h: any) => (h.command as string).includes('hmem v2-checkpoint')),
    );
    expect(v2CpEntries).toHaveLength(1);

    // Check hook object properties
    const hook = v2CpEntries[0].hooks[0];
    expect(hook.type).toBe('command');
    expect(hook.command).toContain('v2-checkpoint');
    expect(hook.command).toContain('--hmem-path');
    expect(hook.timeout).toBe(120);
    expect(hook.async).toBe(true);
  });

  it('is idempotent — running init twice does NOT duplicate the v2-checkpoint hook', () => {
    installClaudeHooksInto(settingsPath, hmemPath, true);
    installClaudeHooksInto(settingsPath, hmemPath, true); // second run

    const settings = readSettings(settingsPath);
    const v2CpCommands = stopCommands(settings).filter(c => c.includes('v2-checkpoint'));
    expect(v2CpCommands).toHaveLength(1);
  });

  it('does NOT install a v1 `hmem checkpoint` Stop hook', () => {
    installClaudeHooksInto(settingsPath, hmemPath, true);
    const settings = readSettings(settingsPath);
    const ckptCommands = stopCommands(settings).filter(
      c => c.includes('hmem checkpoint') && !c.includes('v2-checkpoint'),
    );
    expect(ckptCommands).toHaveLength(0);
  });

  it('strips stale `hmem checkpoint` entry AND installs v2-checkpoint', () => {
    // Seed a settings.json that already has a stale v1 checkpoint entry
    const staleCmd = `hmem --hmem-path ${hmemPath} checkpoint`;
    const staleSettings = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: staleCmd, timeout: 120, async: true }] },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(staleSettings, null, 2));

    installClaudeHooksInto(settingsPath, hmemPath, true);
    const settings = readSettings(settingsPath);

    // Stale v1 entry MUST be gone
    const staleCmds = stopCommands(settings).filter(
      c => c.includes('hmem checkpoint') && !c.includes('v2-checkpoint'),
    );
    expect(staleCmds).toHaveLength(0);

    // New v2-checkpoint entry MUST be present
    const v2Cmds = stopCommands(settings).filter(c => c.includes('v2-checkpoint'));
    expect(v2Cmds).toHaveLength(1);
  });

  it('stale-strip regex does NOT remove the v2-checkpoint entry itself', () => {
    // The stale-strip is `migrateHook("Stop", "hmem checkpoint")`. Verify that
    // a command containing "v2-checkpoint" does NOT match "hmem checkpoint".
    const v2Cmd = `hmem --hmem-path ${hmemPath} v2-checkpoint`;
    expect(v2Cmd.includes('hmem checkpoint')).toBe(false);

    // Seed settings with ONLY a v2-checkpoint entry (no stale entry)
    const seededSettings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: `hmem --hmem-path ${hmemPath} log-exchange`, timeout: 10, async: true },
              { type: 'command', command: v2Cmd, timeout: 120, async: true },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(seededSettings, null, 2));

    installClaudeHooksInto(settingsPath, hmemPath, true);
    const settings = readSettings(settingsPath);

    // v2-checkpoint must still be present (not stripped)
    const v2Cmds = stopCommands(settings).filter(c => c.includes('v2-checkpoint'));
    expect(v2Cmds).toHaveLength(1);
  });

  it('installs log-exchange Stop + harness hook-prompt-submit + hook-session-start (no legacy)', () => {
    installClaudeHooksInto(settingsPath, hmemPath, true);
    const settings = readSettings(settingsPath);

    const leCmds = stopCommands(settings).filter(c => c.includes('log-exchange'));
    expect(leCmds).toHaveLength(1);

    const ups = (settings.hooks.UserPromptSubmit ?? []).flatMap(
      (e: any) => (e.hooks ?? []).map((h: any) => h.command as string));
    expect(ups.filter((c: string) => c.includes('hook-prompt-submit'))).toHaveLength(1);
    expect(ups.filter((c: string) => c.includes('hook-startup'))).toHaveLength(0); // no legacy on v2

    const ss = (settings.hooks.SessionStart ?? []).flatMap(
      (e: any) => (e.hooks ?? []).map((h: any) => h.command as string));
    expect(ss.filter((c: string) => c.includes('hook-session-start'))).toHaveLength(1);
    expect(ss.filter((c: string) => c.includes('context-inject'))).toHaveLength(0); // no legacy on v2
  });

  it('migrates a pre-cutover v2 install: strips legacy hook-startup + context-inject, adds harness hooks', () => {
    const legacy = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `hmem --hmem-path ${hmemPath} hook-startup`, timeout: 5 }] }],
        SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `hmem --hmem-path ${hmemPath} context-inject`, timeout: 10 }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(legacy, null, 2));

    installClaudeHooksInto(settingsPath, hmemPath, true);
    const settings = readSettings(settingsPath);

    const ups = (settings.hooks.UserPromptSubmit ?? []).flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command as string));
    expect(ups.filter((c: string) => c.includes('hook-startup'))).toHaveLength(0);        // legacy gone
    expect(ups.filter((c: string) => c.includes('hook-prompt-submit'))).toHaveLength(1);  // harness present

    const ss = (settings.hooks.SessionStart ?? []).flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command as string));
    expect(ss.filter((c: string) => c.includes('context-inject'))).toHaveLength(0);       // legacy gone
    expect(ss.filter((c: string) => c.includes('hook-session-start'))).toHaveLength(1);   // harness present
  });

  it('harness hook install is idempotent (no duplicates on second v2 init)', () => {
    installClaudeHooksInto(settingsPath, hmemPath, true);
    installClaudeHooksInto(settingsPath, hmemPath, true);
    const settings = readSettings(settingsPath);
    const ups = (settings.hooks.UserPromptSubmit ?? []).flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command as string));
    expect(ups.filter((c: string) => c.includes('hook-prompt-submit'))).toHaveLength(1);
    const ss = (settings.hooks.SessionStart ?? []).flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command as string));
    expect(ss.filter((c: string) => c.includes('hook-session-start'))).toHaveLength(1);
  });
});

// ── installClaudeHooksInto — v1 store ─────────────────────────────────────────

describe('installClaudeHooksInto — v1 store', () => {
  let dir: string;
  let settingsPath: string;
  let hmemPath: string;

  beforeEach(() => {
    dir = tmpDir();
    settingsPath = join(dir, 'settings.json');
    hmemPath = join(dir, 'memory.hmem');
    buildV1File(hmemPath);
  });

  it('installs `hmem checkpoint` Stop hook for a v1 store', () => {
    installClaudeHooksInto(settingsPath, hmemPath, false);
    const settings = readSettings(settingsPath);

    const ckptCmds = stopCommands(settings).filter(c => c.endsWith(' checkpoint'));
    expect(ckptCmds).toHaveLength(1);
    expect(ckptCmds[0]).toContain('--hmem-path');
  });

  it('does NOT install v2-checkpoint for a v1 store', () => {
    installClaudeHooksInto(settingsPath, hmemPath, false);
    const settings = readSettings(settingsPath);

    const v2CmDs = stopCommands(settings).filter(c => c.includes('v2-checkpoint'));
    expect(v2CmDs).toHaveLength(0);
  });

  it('v1 checkpoint install is idempotent (no duplicates on second run)', () => {
    installClaudeHooksInto(settingsPath, hmemPath, false);
    installClaudeHooksInto(settingsPath, hmemPath, false);
    const settings = readSettings(settingsPath);

    const ckptCmds = stopCommands(settings).filter(c => c.endsWith(' checkpoint'));
    expect(ckptCmds).toHaveLength(1);
  });

  it('keeps legacy hook-startup + context-inject for a v1 store (no harness hooks)', () => {
    installClaudeHooksInto(settingsPath, hmemPath, false);
    const settings = readSettings(settingsPath);

    const ups = (settings.hooks.UserPromptSubmit ?? []).flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command as string));
    expect(ups.filter((c: string) => c.includes('hook-startup'))).toHaveLength(1);
    expect(ups.filter((c: string) => c.includes('hook-prompt-submit'))).toHaveLength(0);

    const ss = (settings.hooks.SessionStart ?? []).flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command as string));
    expect(ss.filter((c: string) => c.includes('context-inject'))).toHaveLength(1);
    expect(ss.filter((c: string) => c.includes('hook-session-start'))).toHaveLength(0);
  });
});

// src/hooks/dispatch.ts
// Pure dispatch module — no top-level side effects, safe to import from tests.
// Moved from src/cli.ts (Phase 5 Task 13 refactor).

import fs from 'node:fs';
import path from 'node:path';
import * as ccShim from './harness/claude-code.js';
import * as hermesShim from './harness/hermes.js';
import * as piShim from './harness/pi.js';
import type { Harness } from './types.js';
import { resolveEnvDefaults } from '../cli-env.js';
import { loadHmemConfig } from '../hmem-config.js';
import { createV2Store } from '../v2/store-facade.js';
import { V1FileError } from '../store/db.js';
import { buildSessionStart } from './session-start.js';
import { buildPromptSubmit } from './prompt-submit.js';
import { logStop } from './stop-log.js';
import { readLastUserMessage, readLastAssistantMessage, isSubagentTranscript } from './transcript.js';

// --- Generic (Hermes/Pi) runner helpers ---

function readStdinRaw(): string {
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
export function openV2(): ReturnType<typeof createV2Store> | null {
  resolveEnvDefaults();
  const p = process.env.HMEM_PATH;
  if (!p || !fs.existsSync(p)) return null;
  try {
    return createV2Store(p, loadHmemConfig(path.dirname(p)));
  } catch (e) {
    // A v1 file (openDb throws V1FileError) is treated like "no v2 store available":
    // the hook silently skips rather than crashing for an un-migrated user.
    if (e instanceof V1FileError) return null;
    throw e;
  }
}
function genericParseStart(harness: Harness, raw: string) {
  return harness === 'pi' ? piShim.parsePiSessionStartStdin(raw) : hermesShim.parseHermesSessionStartStdin(raw);
}
function genericParseStop(harness: Harness, raw: string) {
  return harness === 'pi' ? piShim.parsePiStopStdin(raw) : hermesShim.parseHermesStopStdin(raw);
}
function genericFormat(harness: Harness, ctx: string) {
  return harness === 'pi' ? piShim.formatPiOutput(ctx) : hermesShim.formatHermesOutput(ctx);
}

function runGenericSessionStart(harness: Harness): void {
  const ctx = genericParseStart(harness, readStdinRaw());
  if (!ctx.sessionId) return;
  const store = openV2();
  if (!store) return;
  try { process.stdout.write(genericFormat(harness, buildSessionStart(store, ctx).context)); }
  finally { store.close(); }
}
function runGenericPromptSubmit(harness: Harness): void {
  const ctx = genericParseStart(harness, readStdinRaw());
  if (!ctx.sessionId) return;
  const store = openV2();
  if (!store) return;
  try { process.stdout.write(genericFormat(harness, buildPromptSubmit({ store, sessionId: ctx.sessionId }).context)); }
  finally { store.close(); }
}
async function runGenericStop(harness: Harness): Promise<void> {
  const ctx = genericParseStop(harness, readStdinRaw());
  // Note: stopHookActive is intentionally not guarded here — Hermes/Pi protocols don't define that field yet, so the guard would be a no-op.
  if (!ctx.sessionId || isSubagentTranscript(ctx.transcriptPath)) return;
  const userText = ctx.transcriptPath ? (readLastUserMessage(ctx.transcriptPath) ?? '') : '';
  const assistantText = ctx.lastAssistantMessage ?? (ctx.transcriptPath ? (readLastAssistantMessage(ctx.transcriptPath) ?? '') : '');
  if (!userText || !assistantText) return;
  const store = openV2();
  if (!store) return;
  try { await logStop({ store, sessionId: ctx.sessionId, userText, assistantText }); }
  finally { store.close(); }
}

/** Pure command+harness → runner map (unit-tested; the actual stdin/stdout lives in the shims). */
export function resolveHookRunner(command: string, harness: Harness): (() => void | Promise<void>) | undefined {
  if (command === 'hook-session-start') {
    if (harness === 'claude-code') return ccShim.runSessionStart;
    return () => runGenericSessionStart(harness);
  }
  if (command === 'hook-prompt-submit') {
    if (harness === 'claude-code') return ccShim.runPromptSubmit;
    return () => runGenericPromptSubmit(harness);
  }
  if (command === 'hook-stop') {
    if (harness === 'claude-code') return ccShim.runStop;
    return () => runGenericStop(harness);
  }
  return undefined;
}

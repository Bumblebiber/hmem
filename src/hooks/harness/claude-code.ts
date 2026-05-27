// src/hooks/harness/claude-code.ts
import fs from 'node:fs';
import path from 'node:path';
import type { HookContext } from '../types.js';
import { resolveEnvDefaults } from '../../cli-env.js';
import { loadHmemConfig } from '../../hmem-config.js';
import { createV2Store } from '../../v2/store-facade.js';
import { V1FileError } from '../../store/db.js';
import { writePpidBridgeForCurrentProcess, writeSessionMarker } from '../../session-state.js';
import { buildSessionStart } from '../session-start.js';
import { buildPromptSubmit } from '../prompt-submit.js';
import { logStop } from '../stop-log.js';
import { readLastUserMessage, readLastAssistantMessage, isSubagentTranscript } from '../transcript.js';

interface CcStdin {
  session_id?: string; cwd?: string; source?: string;
  transcript_path?: string; last_assistant_message?: string; stop_hook_active?: boolean;
}

function safeParse(raw: string): CcStdin {
  try { return JSON.parse(raw || '{}') as CcStdin; } catch { return {}; }
}

export function parseSessionStartStdin(raw: string): HookContext {
  const j = safeParse(raw);
  return { harness: 'claude-code', sessionId: j.session_id ?? '', cwd: j.cwd, source: j.source };
}
export function parseStopStdin(raw: string): HookContext {
  const j = safeParse(raw);
  return {
    harness: 'claude-code', sessionId: j.session_id ?? '',
    transcriptPath: j.transcript_path, lastAssistantMessage: j.last_assistant_message, stopHookActive: j.stop_hook_active,
  };
}
export function parsePromptSubmitStdin(raw: string): HookContext {
  const j = safeParse(raw);
  return { harness: 'claude-code', sessionId: j.session_id ?? '' };
}

export function formatSessionStartOutput(context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
}
export function formatPromptSubmitOutput(context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } });
}

function readStdin(): string {
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
export function openStore() {
  resolveEnvDefaults();
  const hmemPath = process.env.HMEM_PATH!;
  if (!hmemPath || !fs.existsSync(hmemPath)) return null;
  try {
    return createV2Store(hmemPath, loadHmemConfig(path.dirname(hmemPath)));
  } catch (e) {
    // A v1 file (openDb throws V1FileError) is treated like "no v2 store available":
    // the SessionStart/Stop hooks silently skip rather than crashing for an un-migrated user.
    if (e instanceof V1FileError) return null;
    throw e;
  }
}

export function runSessionStart(): void {
  const ctx = parseSessionStartStdin(readStdin());
  if (!ctx.sessionId) return;
  const store = openStore();
  if (!store) return;
  try {
    const res = buildSessionStart(store, ctx);
    // Bridge: a sibling MCP-server process resolves the session via readPpidMapping(process.ppid)
    // (src/session-state.ts:141) → must write the ppid bridge (parent shell AND grandparent =
    // Claude Code PID, the one the MCP server reads) plus the session marker, so in-session MCP
    // calls like activate() resolve to this same deterministic id (D1).
    try {
      writePpidBridgeForCurrentProcess(ctx.sessionId, store.path);
      writeSessionMarker(ctx.sessionId, { projectId: res.projectLabel, hmemPath: store.path });
    } catch { /* never crash the hook over a bridge write */ }
    process.stdout.write(formatSessionStartOutput(res.context));
  } finally { store.close(); }
}

export function runPromptSubmit(): void {
  const ctx = parsePromptSubmitStdin(readStdin());
  if (!ctx.sessionId) return;
  const store = openStore();
  if (!store) return;
  try {
    // Per-message bridge refresh: process.ppid (and the grandparent Claude Code PID)
    // change when the MCP server reconnects mid-session, so SessionStart alone is not
    // enough — re-stamp the bridge on every user turn so in-session MCP calls keep
    // resolving the session. Best-effort; never blocks the prompt.
    writePpidBridgeForCurrentProcess(ctx.sessionId, store.path);
    const { context } = buildPromptSubmit({ store, sessionId: ctx.sessionId });
    process.stdout.write(formatPromptSubmitOutput(context));
  } finally { store.close(); }
}

export async function runStop(): Promise<void> {
  const ctx = parseStopStdin(readStdin());
  if (!ctx.sessionId || ctx.stopHookActive) return;
  if (isSubagentTranscript(ctx.transcriptPath)) return;
  const userText = ctx.transcriptPath ? (readLastUserMessage(ctx.transcriptPath) ?? '') : '';
  const assistantText = ctx.lastAssistantMessage
    ?? (ctx.transcriptPath ? (readLastAssistantMessage(ctx.transcriptPath) ?? '') : '');
  if (!userText || !assistantText) return;
  const store = openStore();
  if (!store) return;
  try { await logStop({ store, sessionId: ctx.sessionId, userText, assistantText }); }
  finally { store.close(); }
}

/**
 * session-state.ts
 *
 * Per-Claude-session active-project marker files.
 * Located in ~/.hmem/sessions/<session_id>.json and keyed by the session_id
 * that Claude Code passes in every hook's stdin JSON.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SessionMarker {
  sessionId: string;
  projectId: string | null;
  hmemPath: string;
  updatedAt: string;
  pid: number;
}

export interface SessionMarkerInput {
  projectId?: string | null;
  hmemPath?: string;
}

function safeHomedir(): string {
  if (process.platform === "win32" && process.env.USERPROFILE) return process.env.USERPROFILE;
  return process.env.HOME || os.homedir();
}

export function sessionMarkerDir(): string {
  return path.join(safeHomedir(), ".hmem", "sessions");
}

function markerPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(sessionMarkerDir(), `${safe}.json`);
}

export function writeSessionMarker(sessionId: string, input: SessionMarkerInput): void {
  if (!sessionId) return;
  const dir = sessionMarkerDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = markerPath(sessionId);

  let existing: Partial<SessionMarker> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SessionMarker>;
  } catch { /* ignore */ }

  const marker: SessionMarker = {
    sessionId,
    projectId: input.projectId !== undefined ? input.projectId : (existing.projectId ?? null),
    hmemPath: input.hmemPath ?? existing.hmemPath ?? "",
    updatedAt: new Date().toISOString(),
    pid: process.pid,
  };

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
  fs.renameSync(tmp, file);
}

export function readSessionMarker(sessionId: string): SessionMarker | null {
  if (!sessionId) return null;
  try {
    const raw = fs.readFileSync(markerPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as SessionMarker;
    if (!parsed.sessionId) parsed.sessionId = sessionId;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSessionMarker(sessionId: string): void {
  try { fs.unlinkSync(markerPath(sessionId)); } catch { /* ignore */ }
}

export function purgeStaleSessionMarkers(maxAgeDays: number): number {
  const dir = sessionMarkerDir();
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    // Catches both <session_id>.json and ppid-<pid>.json files
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch { /* ignore */ }
  }
  return removed;
}

export interface PpidMapping {
  sessionId: string;
  hmemPath: string;
  updatedAt: string;
}

function ppidMappingPath(ppid: number): string {
  return path.join(sessionMarkerDir(), `ppid-${ppid}.json`);
}

/**
 * Write a mapping from a parent process id to a session id + hmem path.
 * Used as a bridge between hooks (which know the session id) and MCP servers
 * (which don't, but share the same parent pid = Claude Code's pid).
 */
export function writePpidMapping(ppid: number, sessionId: string, hmemPath: string): void {
  if (!ppid || !sessionId) return;
  const dir = sessionMarkerDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = ppidMappingPath(ppid);
  const mapping: PpidMapping = {
    sessionId,
    hmemPath,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2));
  fs.renameSync(tmp, file);
}

export function readPpidMapping(ppid: number): PpidMapping | null {
  if (!ppid) return null;
  try {
    const raw = fs.readFileSync(ppidMappingPath(ppid), "utf8");
    return JSON.parse(raw) as PpidMapping;
  } catch {
    return null;
  }
}

/**
 * Resolve the current session id by chaining: env var > ppid-bridge file.
 * Caches the result in process.env.HMEM_SESSION_ID so repeated calls are cheap.
 *
 * Linux/macOS: process.ppid is the Claude Code PID shared between the hook and
 * MCP server, so the ppid-bridge file written by the hook is readable here.
 * Windows: process.ppid may be unavailable in older Node versions — in that case
 * currentSessionId() returns undefined and the system falls through to legacy
 * DB-flag behavior.
 */
export function currentSessionId(): string | undefined {
  if (process.env.HMEM_SESSION_ID) return process.env.HMEM_SESSION_ID;
  const ppid = typeof process.ppid === "number" ? process.ppid : 0;
  if (!ppid) return undefined;
  const mapping = readPpidMapping(ppid);
  if (mapping?.sessionId) {
    process.env.HMEM_SESSION_ID = mapping.sessionId;
    return mapping.sessionId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-process active-project file
// Keyed by Claude Code PID (= process.ppid of MCP server and statusline).
// Provides session-isolated active-project tracking that doesn't depend on
// the shared DB active flag or the ppid-bridge session-id lookup.
// ---------------------------------------------------------------------------

function activeProjectFilePath(claudePid: number): string {
  return path.join(os.tmpdir(), `hmem-active-${claudePid}.txt`);
}

export function writeActiveProjectFile(claudePid: number, projectId: string): void {
  try {
    const file = activeProjectFilePath(claudePid);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, projectId);
    fs.renameSync(tmp, file);
  } catch { /* ignore — never crash MCP server over statusline file */ }
}

export function readActiveProjectFile(claudePid: number): string | null {
  try {
    const raw = fs.readFileSync(activeProjectFilePath(claudePid), "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

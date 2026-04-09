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

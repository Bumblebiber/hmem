/**
 * diagnostics.ts
 *
 * Append-only JSONL diagnostic log at ~/.hmem/diagnostics.log.
 * Rotated to .1 when the file exceeds 1 MB.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;

function safeHomedir(): string {
  if (process.platform === "win32" && process.env.USERPROFILE) return process.env.USERPROFILE;
  return process.env.HOME || os.homedir();
}

export function diagnosticsLogPath(): string {
  return path.join(safeHomedir(), ".hmem", "diagnostics.log");
}

export interface DiagnosticEntry {
  op: string;
  sessionId?: string;
  hmemPath?: string;
  activeProjectId?: string | null;
  oId?: string | null;
  batchId?: string | null;
  markerSource?: "session-marker" | "db-fallback" | "none";
  warning?: string;
  [key: string]: unknown;
}

export function writeDiagnostic(entry: DiagnosticEntry): void {
  try {
    const logPath = diagnosticsLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    try {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_BYTES) {
        const rotated = logPath + ".1";
        try { fs.unlinkSync(rotated); } catch { /* ignore */ }
        fs.renameSync(logPath, rotated);
      }
    } catch { /* no existing file */ }

    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(logPath, line);
  } catch {
    // diagnostics must never crash the caller
  }
}

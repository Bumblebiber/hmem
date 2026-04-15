/**
 * cli-deactivate.ts
 *
 * Called by Claude Code's SessionStart[clear] hook after /clear.
 * Writes a session marker with projectId=null for the new session so the
 * statusline shows "no project" instead of the previously active project.
 *
 * Also deletes the per-process active-project file and clears statusline
 * cache files so the change takes effect immediately.
 *
 * Usage: hmem deactivate  (reads stdin JSON from Claude Code hook)
 */

import fs from "node:fs";
import os from "node:os";
import { resolveEnvDefaults } from "./cli-env.js";
import {
  writeSessionMarker,
  writePpidMapping,
  activeProjectFilePath,
  getParentPid,
} from "./session-state.js";

interface HookInput {
  session_id?: string;
}

export async function deactivate(): Promise<void> {
  resolveEnvDefaults();

  // Read hook stdin JSON (Claude Code hook protocol)
  let input: HookInput = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw) input = JSON.parse(raw) as HookInput;
  } catch { /* no stdin — OK */ }

  const sessionId = input.session_id;
  const hmemPath = process.env.HMEM_PATH || "";

  // Write session marker with projectId=null — makes statusline authoritative "no project"
  if (sessionId) {
    writeSessionMarker(sessionId, { projectId: null, hmemPath, deactivated: true });

    // Update PPID bridge so MCP server can resolve this session
    const ppid = typeof process.ppid === "number" ? process.ppid : 0;
    const grandparent = ppid ? getParentPid(ppid) : null;
    const claudePid = grandparent && grandparent > 1 ? grandparent : ppid;
    if (claudePid) {
      writePpidMapping(claudePid, sessionId, hmemPath);
    }
  }

  // Delete per-process active-project file (written by MCP server on load_project)
  const ppid = typeof process.ppid === "number" ? process.ppid : 0;
  if (ppid) {
    const grandparent = getParentPid(ppid);
    const pidsToClean = [ppid, ...(grandparent && grandparent > 1 ? [grandparent] : [])];
    for (const pid of pidsToClean) {
      try { fs.unlinkSync(activeProjectFilePath(pid)); } catch { /* may not exist */ }
    }
  }

  // Invalidate statusline cache files so the change shows immediately
  const tmpDir = os.tmpdir();
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith(".hmem_statusline_")) {
        try { fs.unlinkSync(`${tmpDir}/${f}`); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

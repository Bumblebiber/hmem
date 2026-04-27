/**
 * cli-statusline.ts
 *
 * Generates Claude Code statusline output.
 * Reads JSON from stdin (Claude Code statusline protocol),
 * queries hmem DB for active project, outputs formatted line.
 *
 * Usage: cat | hmem statusline
 *
 * The shell script wrapper becomes a one-liner:
 *   #!/bin/bash
 *   cat | hmem statusline
 */

import fs from "node:fs";
import path from "node:path";
import { resolveEnvDefaults } from "./cli-env.js";
import { loadHmemConfig } from "./hmem-config.js";
import { readActiveProjectForCurrentProcess, getActiveDevice } from "./session-state.js";

interface StatusInput {
  session_id?: string;
  context_window?: {
    used_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  rate_limits?: {
    five_hour?: { used_percentage?: number | null };
    seven_day?: { used_percentage?: number | null };
  };
}

// ANSI color helpers
const C = {
  green: "\x1b[01;32m",
  yellow: "\x1b[01;33m",
  red: "\x1b[01;31m",
  cyan: "\x1b[00;36m",
  gray: "\x1b[00;90m",
  white: "\x1b[00;37m",
  reset: "\x1b[00m",
};

function cacheFile(sessionId: string | undefined): string {
  const key = sessionId ? sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") : "global";
  return `/tmp/.hmem_statusline_${key}.cache`;
}

const CACHE_TTL = 30; // seconds

interface HmemStatus {
  project: string;       // "P0048 hmem-mcp" or ""
  device: string;        // "I0002 Strato Server" or "" (not set)
  exchanges: number;     // exchanges since last checkpoint
  interval: number;      // checkpoint interval (0 = disabled)
}

function buildRateLimits(input: StatusInput): string {
  const fiveHour = input.rate_limits?.five_hour?.used_percentage;
  const sevenDay = input.rate_limits?.seven_day?.used_percentage;
  if (fiveHour == null && sevenDay == null) return "";

  const fiveColor = fiveHour != null
    ? (fiveHour >= 80 ? C.red : fiveHour >= 50 ? C.yellow : C.green)
    : C.gray;
  const weekColor = sevenDay != null
    ? (sevenDay >= 80 ? C.red : sevenDay >= 50 ? C.yellow : C.green)
    : C.gray;

  const parts: string[] = [];
  if (fiveHour != null) parts.push(`${fiveColor}5h: ${Math.round(fiveHour)}%${C.reset}`);
  if (sevenDay != null) parts.push(`${weekColor}w: ${Math.round(sevenDay)}%${C.reset}`);
  return parts.join(`${C.gray}/${C.reset}`);
}

function buildContextBar(input: StatusInput): string {
  const pct = input.context_window?.used_percentage;
  if (pct == null) return "";

  const usedInt = Math.round(pct);
  const filled = Math.floor(usedInt * 20 / 100);
  const empty = 20 - filled;
  const bar = "#".repeat(filled) + "-".repeat(empty);

  const color = usedInt >= 80 ? C.red : usedInt >= 50 ? C.yellow : C.green;

  // Total context tokens
  const cu = input.context_window?.current_usage;
  const totalCtx = (cu?.input_tokens ?? 0)
    + (cu?.cache_creation_input_tokens ?? 0)
    + (cu?.cache_read_input_tokens ?? 0);

  const tokLabel = totalCtx > 0
    ? `${Math.round(totalCtx / 1000)}k`
    : `${usedInt}%`;

  return `${color}[${bar}]${C.reset} ${C.white}${tokLabel}${C.reset}`;
}

async function getHmemStatus(sessionId: string | undefined): Promise<HmemStatus> {
  const empty: HmemStatus = { project: "", device: "", exchanges: 0, interval: 0 };
  const CACHE_FILE = cacheFile(sessionId);

  // Check cache
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf-8");
      const newline = raw.indexOf("\n");
      if (newline > 0) {
        const cacheTs = parseInt(raw.substring(0, newline), 10);
        const age = Math.floor(Date.now() / 1000) - cacheTs;
        if (age < CACHE_TTL) {
          return JSON.parse(raw.substring(newline + 1)) as HmemStatus;
        }
      }
    }
  } catch { /* ignore */ }

  // Query DB
  let status = empty;
  try {
    resolveEnvDefaults();
    const hmemPath = process.env.HMEM_PATH;
    if (!hmemPath) return writeCache(empty, sessionId);

    // Load config for checkpoint interval
    const hmemConfig = loadHmemConfig(path.dirname(hmemPath));

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(hmemPath, { readonly: true });
    try {
      // Active project — per-session marker lookup
      const { readSessionMarker } = await import("./session-state.js");
      const marker = sessionId ? readSessionMarker(sessionId) : null;

      let projRow: { id: string; title: string } | undefined;
      if (marker?.projectId) {
        // Session marker has an explicit project → use it
        projRow = db.prepare(
          "SELECT id, title FROM memories WHERE id = ? AND prefix='P' AND obsolete!=1 LIMIT 1"
        ).get(marker.projectId) as { id: string; title: string } | undefined;
      } else if (marker?.deactivated) {
        // Explicitly deactivated after /clear → show "no project", skip all fallbacks
        projRow = undefined;
      } else {
        // No marker, or marker with null and not explicitly deactivated → fall through to fallbacks
        // Fallback 1: per-process active-project file (written by MCP server on load_project).
        // MCP server is a direct child of Claude Code → writes file keyed by Claude Code PID.
        // Statusline runs via "bash -c" → Claude Code → bash → statusline.
        // readActiveProjectForCurrentProcess() checks both PPID and grandparent PPID to
        // handle the bash-intermediary case transparently.
        const activeFromFile = readActiveProjectForCurrentProcess();
        if (activeFromFile) {
          projRow = db.prepare(
            "SELECT id, title FROM memories WHERE id = ? AND prefix='P' AND obsolete!=1 LIMIT 1"
          ).get(activeFromFile) as { id: string; title: string } | undefined;
        }
        if (!projRow) {
          // Fallback 2: shared DB active flag (legacy — unreliable in multi-session setups)
          projRow = db.prepare(
            "SELECT id, title FROM memories WHERE prefix='P' AND active=1 AND obsolete!=1 LIMIT 1"
          ).get() as { id: string; title: string } | undefined;
        }
      }

      let project = "";
      if (projRow) {
        const name = projRow.title.split("|")[0].trim();
        project = `${projRow.id} ${name}`;
      }

      // Active device — global per-machine file
      let device = "";
      const deviceId = getActiveDevice();
      if (deviceId) {
        const devRow = db.prepare(
          "SELECT id, title FROM memories WHERE id = ? AND prefix='I' AND obsolete!=1 LIMIT 1"
        ).get(deviceId) as { id: string; title: string } | undefined;
        if (devRow) {
          device = devRow.title.split("|")[0].trim();
        } else {
          device = deviceId;
        }
      }

      // Exchange count since last checkpoint
      let exchanges = 0;

      // Find O-entry matching active project
      let oRow: { id: string } | undefined;
      if (projRow) {
        const projSeq = parseInt(projRow.id.replace(/\D/g, ""), 10);
        const oId = `O${String(projSeq).padStart(4, "0")}`;
        oRow = db.prepare("SELECT id FROM memories WHERE id = ?").get(oId) as { id: string } | undefined;
      }

      if (oRow) {
        // Find the latest L3 batch
        const latestBatch = db.prepare(
          `SELECT id FROM memory_nodes WHERE root_id = ? AND depth = 3 ORDER BY created_at DESC LIMIT 1`
        ).get(oRow.id) as { id: string } | undefined;

        if (latestBatch) {
          const batchExchanges = (db.prepare(
            "SELECT COUNT(*) as n FROM memory_nodes WHERE parent_id = ? AND depth = 4"
          ).get(latestBatch.id) as any)?.n ?? 0;

          const interval = hmemConfig.checkpointInterval;
          exchanges = batchExchanges;
          status = { project, device, exchanges, interval };
        } else {
          status = { project, device, exchanges: 0, interval: hmemConfig.checkpointInterval };
        }
      } else {
        status = { project, device, exchanges: 0, interval: hmemConfig.checkpointInterval };
      }
    } finally {
      db.close();
    }
  } catch { /* ignore */ }

  return writeCache(status, sessionId);
}

function writeCache(value: HmemStatus, sessionId: string | undefined): HmemStatus {
  try {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(cacheFile(sessionId), `${now}\n${JSON.stringify(value)}\n`);
  } catch { /* ignore */ }
  return value;
}

export async function statusline(): Promise<void> {
  // Read JSON from stdin
  let input: StatusInput = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch { /* no input — still show project */ }

  const parts: string[] = [];

  const ctxBar = buildContextBar(input);
  if (ctxBar) parts.push(ctxBar);

  const status = await getHmemStatus(input.session_id);

  // Device
  if (status.device) {
    parts.push(`${C.white}${status.device}${C.reset}`);
  } else {
    parts.push(`${C.gray}identify device${C.reset}`);
  }

  if (status.project) {
    parts.push(`${C.cyan}${status.project}${C.reset}`);
  } else {
    parts.push(`${C.gray}no project${C.reset}`);
  }

  // Checkpoint progress: "3/5" exchanges since last checkpoint
  if (status.interval > 0) {
    const ratio = `${status.exchanges}/${status.interval}`;
    // Color: gray normally, yellow when close (1 away), green right after checkpoint (0)
    const cpColor = status.exchanges === 0 ? C.green
      : status.exchanges >= status.interval - 1 ? C.yellow
      : C.gray;
    parts.push(`${cpColor}${ratio}${C.reset}`);
  }

  // Rate limits (Claude Max subscription)
  const rateLimits = buildRateLimits(input);
  if (rateLimits) parts.push(rateLimits);

  if (parts.length > 0) {
    const sep = `  ${C.gray}|${C.reset}  `;
    process.stdout.write(parts.join(sep));
  }
}

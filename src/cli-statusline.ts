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
import { resolveHmemPath } from "./hmem-store.js";
import { resolveEnvDefaults } from "./cli-env.js";
import { loadHmemConfig } from "./hmem-config.js";

interface StatusInput {
  context_window?: {
    used_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
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

const CACHE_FILE = "/tmp/.hmem_statusline_cache";
const CACHE_TTL = 30; // seconds

interface HmemStatus {
  project: string;       // "P0048 hmem-mcp" or ""
  exchanges: number;     // exchanges since last checkpoint
  interval: number;      // checkpoint interval (0 = disabled)
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

async function getHmemStatus(): Promise<HmemStatus> {
  const empty: HmemStatus = { project: "", exchanges: 0, interval: 0 };

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
    const projectDir = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR;
    if (!projectDir) return writeCache(empty);

    const agentId = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
    const templateName = agentId.replace(/_\d+$/, "");

    let hmemPath: string;
    try {
      hmemPath = resolveHmemPath(projectDir, templateName);
    } catch {
      const agentsDir = path.join(projectDir, "Agents");
      if (fs.existsSync(agentsDir)) {
        for (const dir of fs.readdirSync(agentsDir)) {
          const candidate = path.join(agentsDir, dir, `${dir}.hmem`);
          if (fs.existsSync(candidate)) { hmemPath = candidate; break; }
        }
      }
      if (!hmemPath!) return writeCache(empty);
    }

    // Load config for checkpoint interval
    const hmemConfig = loadHmemConfig(path.dirname(hmemPath));

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(hmemPath, { readonly: true });
    try {
      // Active project
      let projRow = db.prepare("SELECT id, title FROM memories WHERE prefix='P' AND active=1 LIMIT 1").get() as any;
      if (!projRow) {
        projRow = db.prepare(
          "SELECT id, title FROM memories WHERE prefix='P' AND obsolete!=1 AND irrelevant!=1 ORDER BY updated_at DESC LIMIT 1"
        ).get() as any;
      }

      let project = "";
      if (projRow) {
        const name = projRow.title.split("|")[0].trim();
        project = `${projRow.id} ${name}`;
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
          status = { project, exchanges, interval };
        } else {
          status = { project, exchanges: 0, interval: hmemConfig.checkpointInterval };
        }
      } else {
        status = { project, exchanges: 0, interval: hmemConfig.checkpointInterval };
      }
    } finally {
      db.close();
    }
  } catch { /* ignore */ }

  return writeCache(status);
}

function writeCache(value: HmemStatus): HmemStatus {
  try {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(CACHE_FILE, `${now}\n${JSON.stringify(value)}\n`);
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

  const status = await getHmemStatus();
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

  if (parts.length > 0) {
    const sep = `  ${C.gray}|${C.reset}  `;
    process.stdout.write(parts.join(sep));
  }
}

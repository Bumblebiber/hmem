/**
 * Shared setup for hmem-mcp and hmem-curate-server.
 * Both MCP servers run as separate processes but share env vars, config, and sync logic.
 */

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import Database from "better-sqlite3";
import os from "node:os";
import { openCompanyMemory, resolveHmemPath, HmemStore } from "./hmem-store.js";
import type { HmemConfig } from "./hmem-config.js";
import { loadHmemConfig, getSyncServers } from "./hmem-config.js";
import { currentSessionId } from "./session-state.js";

// ---- Environment ----
export const HMEM_PATH = process.env.HMEM_PATH || resolveHmemPath();
export const PROJECT_DIR = process.env.HMEM_PROJECT_DIR || path.dirname(HMEM_PATH);

export function log(msg: string): void {
  const name = path.basename(HMEM_PATH, ".hmem");
  console.error(`[hmem:${name}] ${msg}`);
}

export function jsonArrayString<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((val) => {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed;
        } catch { /* fall through */ }
      }
    }
    return val;
  }, schema);
}

export function validateFilePath(userPath: string, hmemDir: string): string {
  const resolved = path.resolve(userPath);
  const home = os.homedir();
  if (!resolved.startsWith(hmemDir + path.sep) && !resolved.startsWith(home + path.sep)
      && resolved !== hmemDir && resolved !== home) {
    throw new Error("Path must be within the hmem directory or home directory.");
  }
  return resolved;
}

export function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\/[^\s:)]+/g, "[path]").substring(0, 300);
}

export function activeProjectLine(store: HmemStore): string {
  const current = store.getActiveProject(currentSessionId());
  if (!current) return "Active project: none (call load_project to set)";
  const shortTitle = current.title.split("|")[0].trim();
  return `Active project: ${current.id} ${shortTitle}`;
}

// ---- hmem-sync integration ----

let lastPullAt = 0;
const PULL_COOLDOWN_MS = 30_000;

function hmemSyncEnabled(hmemPath: string): boolean {
  const passphrase = process.env["HMEM_SYNC_PASSPHRASE"];
  if (!passphrase) return false;
  const servers = getSyncServers(hmemConfig);
  if (servers.length > 0 && servers.some(s => s.serverUrl && s.token)) return true;
  const cfg = path.join(path.dirname(hmemPath), ".hmem-sync-config.json");
  return fs.existsSync(cfg);
}

function hmemSyncConfig(hmemPath: string): string {
  return path.join(path.dirname(hmemPath), ".hmem-sync-config.json");
}

let _resolvedSyncBin: [string, string] | null | undefined;
function resolveHmemSyncBin(): [string, string] | null {
  if (_resolvedSyncBin !== undefined) return _resolvedSyncBin;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, ["hmem-sync"], { encoding: "utf8", shell: true, windowsHide: true });
    if (result.stdout) {
      const lines = result.stdout.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const binPath = lines.find(l => l.endsWith(".cmd") || l.endsWith(".ps1")) || lines[0];
      if (binPath.endsWith(".cmd") || binPath.endsWith(".ps1")) {
        const content = fs.readFileSync(binPath, "utf8");
        const match = content.match(/"([^"]+\.js)"/);
        if (match) {
          const wrapperDir = path.dirname(binPath);
          const jsPath = match[1]
            .replace(/%~dp0\\?/gi, wrapperDir + path.sep)
            .replace(/%dp0%\\?/gi, wrapperDir + path.sep);
          _resolvedSyncBin = [process.execPath, path.resolve(jsPath)];
          return _resolvedSyncBin;
        }
      } else {
        const realPath = fs.realpathSync(binPath);
        _resolvedSyncBin = [process.execPath, realPath];
        return _resolvedSyncBin;
      }
    }
  } catch { /* ignore */ }
  _resolvedSyncBin = null;
  return null;
}

function spawnSyncHmemSync(args: string[]): ReturnType<typeof spawnSync> {
  const bin = resolveHmemSyncBin();
  if (bin) {
    return spawnSync(bin[0], [bin[1], ...args], {
      env: { ...process.env }, encoding: "utf8", windowsHide: true,
    });
  }
  return spawnSync("hmem-sync", args, {
    env: { ...process.env }, encoding: "utf8",
    shell: process.platform === "win32", windowsHide: true,
  });
}

function spawnDetachedHmemSync(args: string[]): void {
  const bin = resolveHmemSyncBin();
  if (bin) {
    const child = spawn(bin[0], [bin[1], ...args], {
      env: { ...process.env }, stdio: "ignore", detached: true, windowsHide: true,
    });
    child.unref();
  } else {
    const child = spawn("hmem-sync", args, {
      env: { ...process.env }, stdio: "ignore", detached: true,
      shell: process.platform === "win32", windowsHide: true,
    });
    child.unref();
  }
}

export function syncPull(hmemPath: string): Array<{id: string, title: string, created_at: string, modified?: boolean}> {
  if (!hmemSyncEnabled(hmemPath)) return [];
  const now = Date.now();
  if (now - lastPullAt < PULL_COOLDOWN_MS) return [];
  lastPullAt = now;

  let prevIds = new Set<string>();
  const prevNodeCounts = new Map<string, number>();
  try {
    const db = new Database(hmemPath, { readonly: true });
    const rows = db.prepare("SELECT id FROM memory_nodes WHERE seq=0").all() as {id: string}[];
    prevIds = new Set(rows.map(r => r.id));
    const countRows = db.prepare("SELECT root_id, COUNT(*) as cnt FROM memory_nodes GROUP BY root_id").all() as {root_id: string, cnt: number}[];
    for (const r of countRows) prevNodeCounts.set(r.root_id, r.cnt);
    db.close();
  } catch { /* db may not exist yet */ }

  const servers = getSyncServers(hmemConfig);
  if (servers.length > 0) {
    for (const s of servers) {
      if (!s.serverUrl || !s.token) continue;
      const result = spawnSyncHmemSync([
        "pull", "--config", hmemSyncConfig(hmemPath),
        "--hmem-path", hmemPath,
        "--server-url", s.serverUrl, "--token", s.token,
      ]);
      if (result.error) process.stderr.write(`hmem-sync pull error (${s.name ?? s.serverUrl}): ${result.error.message}\n`);
    }
  } else {
    const result = spawnSyncHmemSync(["pull", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath]);
    if (result.error) process.stderr.write(`hmem-sync pull error: ${result.error.message}\n`);
  }

  try {
    const db = new Database(hmemPath, { readonly: true });
    const rows = db.prepare(
      "SELECT id, content, created_at FROM memory_nodes WHERE seq=0"
    ).all() as {id: string, content: string, created_at: string}[];

    const newCountRows = db.prepare("SELECT root_id, COUNT(*) as cnt FROM memory_nodes GROUP BY root_id").all() as {root_id: string, cnt: number}[];
    const modifiedRoots = new Set<string>();
    for (const r of newCountRows) {
      const prev = prevNodeCounts.get(r.root_id) ?? 0;
      if (r.cnt > prev && prevIds.has(r.root_id)) {
        modifiedRoots.add(r.root_id);
      }
    }

    db.close();

    const newEntries = rows
      .filter(r => !prevIds.has(r.id))
      .map(r => ({
        id: r.id,
        title: r.content.split("\n")[0].trim().slice(0, 60),
        created_at: r.created_at.slice(0, 10),
      }));

    const modifiedEntries = rows
      .filter(r => modifiedRoots.has(r.id) && prevIds.has(r.id))
      .map(r => ({
        id: r.id,
        title: r.content.split("\n")[0].trim().slice(0, 60),
        created_at: r.created_at.slice(0, 10),
        modified: true as const,
      }));

    return [...newEntries, ...modifiedEntries];
  } catch { return []; }
}

export function syncPullThenPush(hmemPath: string): void {
  if (!hmemSyncEnabled(hmemPath)) return;
  const servers = getSyncServers(hmemConfig);
  if (servers.length > 0) {
    for (const s of servers) {
      if (!s.serverUrl || !s.token) continue;
      spawnSyncHmemSync([
        "pull", "--config", hmemSyncConfig(hmemPath),
        "--hmem-path", hmemPath,
        "--server-url", s.serverUrl, "--token", s.token,
      ]);
    }
  } else {
    spawnSyncHmemSync(["pull", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath]);
  }
  lastPullAt = Date.now();
}

export function syncPush(hmemPath: string): void {
  if (!hmemSyncEnabled(hmemPath)) return;
  const servers = getSyncServers(hmemConfig);
  if (servers.length > 0) {
    for (const s of servers) {
      if (!s.serverUrl || !s.token) continue;
      spawnDetachedHmemSync([
        "push", "--config", hmemSyncConfig(hmemPath),
        "--hmem-path", hmemPath,
        "--server-url", s.serverUrl, "--token", s.token,
      ]);
    }
  } else {
    spawnDetachedHmemSync(["push", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath]);
  }
}

export function reserveId(hmemPath: string, id: string): boolean {
  if (!hmemSyncEnabled(hmemPath)) return true;
  const servers = getSyncServers(hmemConfig);
  const targets = servers.length > 0
    ? servers.filter(s => s.serverUrl && s.token).map(s => ({ url: s.serverUrl!, token: s.token! }))
    : [{ url: "", token: "" }];

  for (const t of targets) {
    const args = ["reserve", "--config", hmemSyncConfig(hmemPath), "--id", id];
    if (t.url) args.push("--server-url", t.url, "--token", t.token);
    const result = spawnSyncHmemSync(args);
    if (result.status === 1) return false;
    if (result.status !== 0) {
      process.stderr.write(`reserveId(${id}) error on ${t.url || "default"}: ${result.stderr || result.error?.message || "unknown"}\n`);
    }
  }
  return true;
}

export function syncPushSync(hmemPath: string): boolean {
  if (!hmemSyncEnabled(hmemPath)) return true;
  const servers = getSyncServers(hmemConfig);
  const targets = servers.length > 0
    ? servers.filter(s => s.serverUrl && s.token).map(s => ({ url: s.serverUrl!, token: s.token! }))
    : [{ url: "", token: "" }];

  let allClean = true;
  for (const t of targets) {
    const args = ["push", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath];
    if (t.url) args.push("--server-url", t.url, "--token", t.token);
    const result = spawnSyncHmemSync(args);
    if (result.status === 3) {
      allClean = false;
    } else if (result.status !== 0 && result.status !== null) {
      process.stderr.write(`syncPushSync error on ${t.url || "default"}: status=${result.status} ${result.stderr || ""}\n`);
    }
  }
  return allClean;
}

export function syncPushWithRetry(hmemPath: string, maxAttempts = 3): { attempts: number; resolved: boolean } {
  if (!hmemSyncEnabled(hmemPath)) return { attempts: 0, resolved: true };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (syncPushSync(hmemPath)) {
      if (attempt > 1) log(`syncPushWithRetry: resolved on attempt ${attempt}/${maxAttempts}`);
      return { attempts: attempt, resolved: true };
    }
    log(`syncPushWithRetry: conflict on attempt ${attempt}/${maxAttempts}, pulling...`);
    lastPullAt = 0;
    syncPull(hmemPath);
  }
  log(`syncPushWithRetry: gave up after ${maxAttempts} attempts — local changes remain unpushed for this entry`);
  return { attempts: maxAttempts, resolved: false };
}

export function reserveNextSubIds(
  hmemPath: string,
  parentId: string,
  content: string,
  hmemStore: HmemStore,
  maxAttempts = 5,
): string[] {
  if (!hmemSyncEnabled(hmemPath)) {
    return hmemStore.peekAppendTopLevelIds(parentId, content);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidates = hmemStore.peekAppendTopLevelIds(parentId, content);
    if (candidates.length === 0) return [];

    let conflictAt = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (!reserveId(hmemPath, candidates[i])) {
        conflictAt = i;
        break;
      }
    }

    if (conflictAt === -1) {
      if (attempt > 1) log(`reserveNextSubIds: claimed [${candidates.join(", ")}] on attempt ${attempt}/${maxAttempts}`);
      return candidates;
    }

    log(`reserveNextSubIds: conflict on ${candidates[conflictAt]} (attempt ${attempt}/${maxAttempts}), pulling...`);
    lastPullAt = 0;
    syncPull(hmemPath);
  }
  throw new Error(
    `Could not reserve sub-IDs under ${parentId} after ${maxAttempts} attempts. ` +
    `Another agent may be appending rapidly to the same parent — try again in a moment.`
  );
}

export function bumpId(id: string): string {
  const m = id.match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`bumpId: malformed id ${id}`);
  const width = m[2].length;
  return `${m[1]}${String(Number(m[2]) + 1).padStart(width, "0")}`;
}

export function compareIds(a: string, b: string): number {
  const ma = a.match(/(\d+)$/), mb = b.match(/(\d+)$/);
  if (!ma || !mb) return 0;
  return Number(ma[1]) - Number(mb[1]);
}

export function reserveNextId(hmemPath: string, prefix: string, hmemStore: HmemStore, maxAttempts = 5): string {
  let candidate = hmemStore.peekNextId(prefix);
  let lastTried = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastTried = candidate;
    if (reserveId(hmemPath, candidate)) {
      log(`reserveNextId: claimed ${candidate} (attempt ${attempt}/${maxAttempts})`);
      return candidate;
    }
    log(`reserveNextId: conflict on ${candidate}, pulling and bumping (${attempt}/${maxAttempts})`);
    lastPullAt = 0;
    syncPull(hmemPath);
    const fresh = hmemStore.peekNextId(prefix);
    candidate = compareIds(fresh, candidate) > 0 ? fresh : bumpId(candidate);
  }
  throw new Error(
    `Could not reserve ID for prefix ${prefix} after ${maxAttempts} attempts ` +
    `(last tried: ${lastTried}). Another agent may be writing rapidly — try again in a moment.`
  );
}

// ---- Config ----
export const hmemConfig = loadHmemConfig(PROJECT_DIR);
log(`Config: levels=[${hmemConfig.maxCharsPerLevel.join(",")}] depth=${hmemConfig.maxDepth}`);

// ---- Store resolver ----
export function resolveStore(
  storeName: "personal" | "company",
  hmemPath: string | undefined,
): { store: HmemStore; label: string; path: string; isExternal: boolean } {
  if (hmemPath) {
    if (!fs.existsSync(hmemPath)) {
      throw new Error(`hmem_path not found: ${hmemPath}`);
    }
    const extConfig = loadHmemConfig(path.dirname(hmemPath));
    return {
      store: new HmemStore(hmemPath, extConfig),
      label: path.basename(hmemPath, ".hmem"),
      path: hmemPath,
      isExternal: true,
    };
  }
  if (storeName === "company") {
    const companyPath = path.join(PROJECT_DIR, "company.hmem");
    return {
      store: openCompanyMemory(PROJECT_DIR, hmemConfig),
      label: "company",
      path: companyPath,
      isExternal: false,
    };
  }
  return {
    store: new HmemStore(HMEM_PATH, hmemConfig),
    label: path.basename(HMEM_PATH, ".hmem"),
    path: HMEM_PATH,
    isExternal: false,
  };
}

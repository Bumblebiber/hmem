#!/usr/bin/env node
/**
 * hmem — Humanlike Memory MCP Server.
 *
 * Provides persistent, hierarchical memory for AI agents via MCP.
 * SQLite-backed, 5-level lazy loading.
 *
 * Environment variables:
 *   HMEM_PATH                — Full path to .hmem file (auto-resolved if not set)
 *   HMEM_PROJECT_DIR         — Root directory (fallback: dirname of HMEM_PATH)
 *   HMEM_AUDIT_STATE_PATH    — Path to audit_state.json (default: {PROJECT_DIR}/audit_state.json)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import Database from "better-sqlite3";
import { searchMemory } from "./memory-search.js";
import { openCompanyMemory, resolveHmemPath, HmemStore, SimilarEntriesError } from "./hmem-store.js";
import { loadHmemConfig, formatPrefixList, getSyncServers } from "./hmem-config.js";
import { SessionCache } from "./session-cache.js";
// ---- Environment ----
const HMEM_PATH = process.env.HMEM_PATH || resolveHmemPath();
const PROJECT_DIR = process.env.HMEM_PROJECT_DIR || path.dirname(HMEM_PATH);
let DEPTH = parseInt(process.env.HMEM_DEPTH || "0", 10);
// Legacy: PID-based identity override (Das Althing orchestrator)
const ppid = process.ppid;
const ctxFile = path.join(PROJECT_DIR, "orchestrator", ".mcp_contexts", `${ppid}.json`);
try {
    if (fs.existsSync(ctxFile)) {
        const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf-8"));
        DEPTH = ctx.depth ?? DEPTH;
    }
}
catch { }
function log(msg) {
    const name = path.basename(HMEM_PATH, ".hmem");
    console.error(`[hmem:${name}] ${msg}`);
}
/**
 * Coerce LLM-provided array arguments: some models serialize arrays as JSON strings
 * (e.g. tags: '["#foo","#bar"]' instead of tags: ["#foo", "#bar"]). Accept both.
 * Wrap a zod string-array schema so the preprocessing happens before validation.
 */
function jsonArrayString(schema) {
    return z.preprocess((val) => {
        if (typeof val === "string") {
            const trimmed = val.trim();
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed))
                        return parsed;
                }
                catch { /* fall through — zod will report the type mismatch */ }
            }
        }
        return val;
    }, schema);
}
// ---- Session-scoped active project (not shared via DB — safe for multi-agent) ----
let activeProjectId = null;
// ---- Session-start mtime snapshot (for [NEW] markers) ----
// Captured before any syncPull so we can detect entries created after our last local write.
const _hmemPathAtStart = HMEM_PATH;
const dbMtimeAtStart = (() => {
    try {
        if (fs.existsSync(_hmemPathAtStart)) {
            return fs.statSync(_hmemPathAtStart).mtime.toISOString();
        }
    }
    catch { }
    return null;
})();
// ---- Security helpers ----
import os from "node:os";
import { currentSessionId, writeActiveProjectFile } from "./session-state.js";
/** Validate that a file path stays within the hmem directory or user's home. */
function validateFilePath(userPath, hmemDir) {
    const resolved = path.resolve(userPath);
    const home = os.homedir();
    if (!resolved.startsWith(hmemDir + path.sep) && !resolved.startsWith(home + path.sep)
        && resolved !== hmemDir && resolved !== home) {
        throw new Error("Path must be within the hmem directory or home directory.");
    }
    return resolved;
}
/** Sanitize error for external consumption — strip file paths and stack traces. */
function safeError(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.replace(/\/[^\s:)]+/g, "[path]").substring(0, 300);
}
// ---- hmem-sync integration ----
let lastPullAt = 0;
const PULL_COOLDOWN_MS = 30_000;
function hmemSyncEnabled(hmemPath) {
    const passphrase = process.env["HMEM_SYNC_PASSPHRASE"];
    if (!passphrase)
        return false;
    // Unified config: sync section with at least one server
    const servers = getSyncServers(hmemConfig);
    if (servers.length > 0 && servers.some(s => s.serverUrl && s.token))
        return true;
    // Legacy: check for .hmem-sync-config.json
    const cfg = path.join(path.dirname(hmemPath), ".hmem-sync-config.json");
    return fs.existsSync(cfg);
}
function hmemSyncConfig(hmemPath) {
    return path.join(path.dirname(hmemPath), ".hmem-sync-config.json");
}
/**
 * Resolve hmem-sync CLI script path for direct Node invocation.
 * Avoids shell: true on Windows which causes visible PowerShell windows.
 * Returns [nodeExe, scriptPath] or null if hmem-sync is not found.
 */
let _resolvedSyncBin;
function resolveHmemSyncBin() {
    if (_resolvedSyncBin !== undefined)
        return _resolvedSyncBin;
    try {
        // Try which/where to find the hmem-sync script
        const cmd = process.platform === "win32" ? "where" : "which";
        const result = spawnSync(cmd, ["hmem-sync"], { encoding: "utf8", shell: true, windowsHide: true });
        if (result.stdout) {
            const lines = result.stdout.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            // On Windows, where.exe may return bash wrapper first; prefer .cmd/.ps1.
            const binPath = lines.find(l => l.endsWith(".cmd") || l.endsWith(".ps1")) || lines[0];
            if (binPath.endsWith(".cmd") || binPath.endsWith(".ps1")) {
                // Windows .cmd wrapper — read it to find the actual JS path
                const content = fs.readFileSync(binPath, "utf8");
                const match = content.match(/"([^"]+\.js)"/);
                if (match) {
                    // npm-generated .cmd shims reference %~dp0 (wrapper dir). Resolve it.
                    const wrapperDir = path.dirname(binPath);
                    const jsPath = match[1]
                        .replace(/%~dp0\\?/gi, wrapperDir + path.sep)
                        .replace(/%dp0%\\?/gi, wrapperDir + path.sep);
                    _resolvedSyncBin = [process.execPath, path.resolve(jsPath)];
                    return _resolvedSyncBin;
                }
            }
            else {
                // Unix: resolve symlink to the actual JS file
                const realPath = fs.realpathSync(binPath);
                _resolvedSyncBin = [process.execPath, realPath];
                return _resolvedSyncBin;
            }
        }
    }
    catch { /* ignore */ }
    _resolvedSyncBin = null;
    return null;
}
/** Spawn hmem-sync with resolved Node path (no shell). Falls back to shell spawn. */
function spawnSyncHmemSync(args) {
    const bin = resolveHmemSyncBin();
    if (bin) {
        return spawnSync(bin[0], [bin[1], ...args], {
            env: { ...process.env }, encoding: "utf8", windowsHide: true,
        });
    }
    // Fallback: shell spawn (legacy behavior)
    return spawnSync("hmem-sync", args, {
        env: { ...process.env }, encoding: "utf8",
        shell: process.platform === "win32", windowsHide: true,
    });
}
/** Spawn hmem-sync detached (async push). No shell needed. */
function spawnDetachedHmemSync(args) {
    const bin = resolveHmemSyncBin();
    if (bin) {
        const child = spawn(bin[0], [bin[1], ...args], {
            env: { ...process.env }, stdio: "ignore", detached: true, windowsHide: true,
        });
        child.unref();
    }
    else {
        const child = spawn("hmem-sync", args, {
            env: { ...process.env }, stdio: "ignore", detached: true,
            shell: process.platform === "win32", windowsHide: true,
        });
        child.unref();
    }
}
/** Blocking pull — waits for completion. Skips if called within cooldown window.
 *  Returns newly synced entries AND entries that received new nodes (empty array if skipped or none). */
function syncPull(hmemPath) {
    if (!hmemSyncEnabled(hmemPath))
        return [];
    const now = Date.now();
    if (now - lastPullAt < PULL_COOLDOWN_MS)
        return [];
    lastPullAt = now;
    // Snapshot existing root IDs + node counts before pull
    let prevIds = new Set();
    const prevNodeCounts = new Map();
    try {
        const db = new Database(hmemPath, { readonly: true });
        const rows = db.prepare("SELECT id FROM memory_nodes WHERE seq=0").all();
        prevIds = new Set(rows.map(r => r.id));
        const countRows = db.prepare("SELECT root_id, COUNT(*) as cnt FROM memory_nodes GROUP BY root_id").all();
        for (const r of countRows)
            prevNodeCounts.set(r.root_id, r.cnt);
        db.close();
    }
    catch { /* db may not exist yet */ }
    // Pull from all configured servers (unified multi-server or legacy single)
    const servers = getSyncServers(hmemConfig);
    if (servers.length > 0) {
        for (const s of servers) {
            if (!s.serverUrl || !s.token)
                continue;
            const result = spawnSyncHmemSync([
                "pull", "--config", hmemSyncConfig(hmemPath),
                "--hmem-path", hmemPath,
                "--server-url", s.serverUrl, "--token", s.token,
            ]);
            if (result.error)
                process.stderr.write(`hmem-sync pull error (${s.name ?? s.serverUrl}): ${result.error.message}\n`);
        }
    }
    else {
        const result = spawnSyncHmemSync(["pull", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath]);
        if (result.error)
            process.stderr.write(`hmem-sync pull error: ${result.error.message}\n`);
    }
    // Find new entries AND entries with new nodes introduced by this pull
    try {
        const db = new Database(hmemPath, { readonly: true });
        const rows = db.prepare("SELECT id, content, created_at FROM memory_nodes WHERE seq=0").all();
        // Detect entries that received new nodes (existing roots with more nodes than before)
        const newCountRows = db.prepare("SELECT root_id, COUNT(*) as cnt FROM memory_nodes GROUP BY root_id").all();
        const modifiedRoots = new Set();
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
            modified: true,
        }));
        return [...newEntries, ...modifiedEntries];
    }
    catch {
        return [];
    }
}
function syncPullThenPush(hmemPath) {
    if (!hmemSyncEnabled(hmemPath))
        return;
    const servers = getSyncServers(hmemConfig);
    if (servers.length > 0) {
        for (const s of servers) {
            if (!s.serverUrl || !s.token)
                continue;
            spawnSyncHmemSync([
                "pull", "--config", hmemSyncConfig(hmemPath),
                "--hmem-path", hmemPath,
                "--server-url", s.serverUrl, "--token", s.token,
            ]);
        }
    }
    else {
        spawnSyncHmemSync(["pull", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath]);
    }
    lastPullAt = Date.now();
}
function syncPush(hmemPath) {
    if (!hmemSyncEnabled(hmemPath))
        return;
    const servers = getSyncServers(hmemConfig);
    if (servers.length > 0) {
        for (const s of servers) {
            if (!s.serverUrl || !s.token)
                continue;
            spawnDetachedHmemSync([
                "push", "--config", hmemSyncConfig(hmemPath),
                "--hmem-path", hmemPath,
                "--server-url", s.serverUrl, "--token", s.token,
            ]);
        }
    }
    else {
        spawnDetachedHmemSync(["push", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath]);
    }
}
/**
 * Atomically reserve an entry-ID at the sync server (multi-agent collision prevention).
 * Returns true if reserved (or sync disabled — local-only mode), false if conflict.
 * Caller should pull + recompute next ID + retry on false.
 *
 * For multi-server setups, attempts reservation on every configured server. If ANY server
 * reports a conflict, the ID is considered taken (fail-closed). This may be overly strict
 * for partial-availability scenarios but is correct for the common single-server case.
 */
function reserveId(hmemPath, id) {
    if (!hmemSyncEnabled(hmemPath))
        return true; // local-only mode → always "reserved"
    const servers = getSyncServers(hmemConfig);
    const targets = servers.length > 0
        ? servers.filter(s => s.serverUrl && s.token).map(s => ({ url: s.serverUrl, token: s.token }))
        : [{ url: "", token: "" }]; // legacy: CLI reads from config
    for (const t of targets) {
        const args = ["reserve", "--config", hmemSyncConfig(hmemPath), "--id", id];
        if (t.url)
            args.push("--server-url", t.url, "--token", t.token);
        const result = spawnSyncHmemSync(args);
        if (result.status === 1)
            return false; // conflict
        if (result.status !== 0) {
            process.stderr.write(`reserveId(${id}) error on ${t.url || "default"}: ${result.stderr || result.error?.message || "unknown"}\n`);
            // Treat unreachable server as "ok" — fail-open for sync errors so writes don't block
            // when server is down. Real conflicts (status 1) still block.
        }
    }
    return true;
}
/**
 * Synchronous push that returns true on full success, false if the server reported
 * any conflicts (per Option α optimistic locking — exit code 3 from hmem-sync push).
 * Used by the append/update retry loop. Falls back to true if sync is disabled.
 */
function syncPushSync(hmemPath) {
    if (!hmemSyncEnabled(hmemPath))
        return true;
    const servers = getSyncServers(hmemConfig);
    const targets = servers.length > 0
        ? servers.filter(s => s.serverUrl && s.token).map(s => ({ url: s.serverUrl, token: s.token }))
        : [{ url: "", token: "" }];
    let allClean = true;
    for (const t of targets) {
        const args = ["push", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath];
        if (t.url)
            args.push("--server-url", t.url, "--token", t.token);
        const result = spawnSyncHmemSync(args);
        if (result.status === 3) {
            allClean = false;
        }
        else if (result.status !== 0 && result.status !== null) {
            process.stderr.write(`syncPushSync error on ${t.url || "default"}: status=${result.status} ${result.stderr || ""}\n`);
            // Fail-open on transport errors (don't block writes if server is down)
        }
    }
    return allClean;
}
/**
 * Pull-then-push retry loop for append/update operations.
 * Strategy: after a local mutation, try to push. If the server reports a
 * version_hash conflict, pull (which merges remote and updates state.versions
 * to the new server version), then retry. The local change is NOT rolled back
 * — it stays in the local DB and gets re-pushed with the fresh expected_version.
 *
 * Caveat: if a remote node collides with our local node at the SAME sub-id,
 * the pull's upsertEntry overwrites our local content with the remote one.
 * Detecting and re-allocating to the next free sub-id is a follow-up
 * (would need sub-node ID reservation, see Option β).
 */
function syncPushWithRetry(hmemPath, maxAttempts = 3) {
    if (!hmemSyncEnabled(hmemPath))
        return { attempts: 0, resolved: true };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (syncPushSync(hmemPath)) {
            if (attempt > 1)
                log(`syncPushWithRetry: resolved on attempt ${attempt}/${maxAttempts}`);
            return { attempts: attempt, resolved: true };
        }
        log(`syncPushWithRetry: conflict on attempt ${attempt}/${maxAttempts}, pulling...`);
        lastPullAt = 0; // bypass cooldown
        syncPull(hmemPath);
    }
    log(`syncPushWithRetry: gave up after ${maxAttempts} attempts — local changes remain unpushed for this entry`);
    return { attempts: maxAttempts, resolved: false };
}
/**
 * Reserve the top-level sub-node IDs that an append_memory call is about to create.
 * Multi-agent protection: prevents two agents from independently allocating the same
 * sub-id (e.g. both grabbing P0048.7.5) which would cause silent data loss when
 * pull-merge later overwrites local content.
 *
 * Strategy: peek the IDs the append would create, reserve each one. On any conflict,
 * pull (which advances the parent's sub-seq counter), recompute, retry. Returns the
 * final list of reserved IDs (which may differ from the initial peek if a retry was
 * needed). Throws after maxAttempts.
 */
function reserveNextSubIds(hmemPath, parentId, content, hmemStore, maxAttempts = 5) {
    if (!hmemSyncEnabled(hmemPath)) {
        // Local-only mode — peek once and return; caller still proceeds with write.
        return hmemStore.peekAppendTopLevelIds(parentId, content);
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const candidates = hmemStore.peekAppendTopLevelIds(parentId, content);
        if (candidates.length === 0)
            return [];
        let conflictAt = -1;
        for (let i = 0; i < candidates.length; i++) {
            if (!reserveId(hmemPath, candidates[i])) {
                conflictAt = i;
                break;
            }
        }
        if (conflictAt === -1) {
            if (attempt > 1)
                log(`reserveNextSubIds: claimed [${candidates.join(", ")}] on attempt ${attempt}/${maxAttempts}`);
            return candidates;
        }
        log(`reserveNextSubIds: conflict on ${candidates[conflictAt]} (attempt ${attempt}/${maxAttempts}), pulling...`);
        lastPullAt = 0;
        syncPull(hmemPath);
    }
    throw new Error(`Could not reserve sub-IDs under ${parentId} after ${maxAttempts} attempts. ` +
        `Another agent may be appending rapidly to the same parent — try again in a moment.`);
}
/** Pull + retry loop: returns the reserved root ID, or throws if all attempts conflict.
 *  Does NOT do the actual write — caller must invoke hmemStore.write() right after. */
function reserveNextId(hmemPath, prefix, hmemStore, maxAttempts = 5) {
    // Start from the local DB's next sequence; on conflict, bump past stale reservations
    // by incrementing the sequence number directly. Pulling alone is insufficient because
    // syncPull only fetches committed entries — it doesn't surface server-side reservations,
    // so peekNextId would otherwise return the same vetoed ID forever (Bug fix in 6.1.1).
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
        // After pull, recompute the local candidate. If the local DB has caught up past the
        // conflict, peekNextId will return a higher ID; otherwise bump past the conflict manually.
        const fresh = hmemStore.peekNextId(prefix);
        candidate = compareIds(fresh, candidate) > 0 ? fresh : bumpId(candidate);
    }
    throw new Error(`Could not reserve ID for prefix ${prefix} after ${maxAttempts} attempts ` +
        `(last tried: ${lastTried}). Another agent may be writing rapidly — try again in a moment.`);
}
/** Increment the numeric suffix of an ID (e.g. "I0009" → "I0010"). */
function bumpId(id) {
    const m = id.match(/^([A-Z]+)(\d+)$/);
    if (!m)
        throw new Error(`bumpId: malformed id ${id}`);
    const width = m[2].length;
    return `${m[1]}${String(Number(m[2]) + 1).padStart(width, "0")}`;
}
/** Compare two IDs by numeric suffix. Returns >0 if a>b, <0 if a<b, 0 if equal. */
function compareIds(a, b) {
    const ma = a.match(/(\d+)$/), mb = b.match(/(\d+)$/);
    if (!ma || !mb)
        return 0;
    return Number(ma[1]) - Number(mb[1]);
}
// Load hmem config (hmem.config.json in project dir, falls back to defaults)
const hmemConfig = loadHmemConfig(PROJECT_DIR);
log(`Config: levels=[${hmemConfig.maxCharsPerLevel.join(",")}] depth=${hmemConfig.maxDepth}`);
/** Resolve which store to open. hmem_path wins over storeName. */
function resolveStore(storeName, hmemPath) {
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
// ---- Version upgrade detection ----
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const PKG_VERSION = _require("../package.json").version;
/** Check if hmem was upgraded since last session. Auto-syncs skills and returns upgrade notice. */
function checkVersionUpgrade() {
    try {
        const configPath = path.join(PROJECT_DIR, "hmem.config.json");
        if (!fs.existsSync(configPath))
            return "";
        const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const lastSeen = raw?.memory?.lastSeenVersion || raw?.lastSeenVersion;
        if (!lastSeen) {
            // First run with version tracking — save current version, sync skills silently
            saveLastSeenVersion(configPath, raw);
            autoSyncSkills();
            return "";
        }
        if (lastSeen !== PKG_VERSION) {
            saveLastSeenVersion(configPath, raw);
            autoSyncSkills();
            return `\n\n⚠ hmem-mcp updated: v${lastSeen} → v${PKG_VERSION}. Skills have been auto-synced. Run /hmem-update for full post-update steps (entry migration, schema enforcement, config check).`;
        }
    }
    catch { }
    return "";
}
/** Auto-sync skill files on version upgrade. Runs hmem update-skills in background. */
function autoSyncSkills() {
    try {
        const hmemBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
        const child = spawn(process.execPath, [hmemBin, "update-skills"], {
            detached: true, stdio: "ignore",
            env: { ...process.env },
        });
        child.unref();
        log("Auto-syncing skills after version upgrade");
    }
    catch { }
}
function saveLastSeenVersion(configPath, raw) {
    try {
        if (!raw.memory)
            raw.memory = {};
        raw.memory.lastSeenVersion = PKG_VERSION;
        fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    }
    catch { }
}
let versionUpgradeNotice = checkVersionUpgrade();
// Session-scoped cache — persists across tool calls within this MCP connection
const sessionCache = new SessionCache();
const CONTEXT_THRESHOLD_WARNING = "\n\n⚠ CONTEXT THRESHOLD REACHED (~{tokens}k tokens delivered this session).\n" +
    "Tell the user to run /hmem-wipe — it saves key knowledge and prepares for /clear.\n" +
    "Alternative: flush_context manually, then /clear, then load_project to restore context.";
const CACHE_RESET_SIGNAL = "/tmp/hmem-cache-reset-signal";
/** Track tokens in a tool response and append threshold warning if needed. */
function trackTokens(result) {
    // Check for /clear signal from hook
    if (fs.existsSync(CACHE_RESET_SIGNAL)) {
        try {
            fs.unlinkSync(CACHE_RESET_SIGNAL);
        }
        catch { }
        sessionCache.reset();
        log("Session cache reset via /clear signal");
    }
    if (result.isError)
        return result;
    const text = result.content.map(c => c.text).join("");
    sessionCache.addTokens(text.length);
    // One-time version upgrade notice (shown once per session)
    if (versionUpgradeNotice) {
        result.content[result.content.length - 1].text += versionUpgradeNotice;
        versionUpgradeNotice = ""; // only show once
    }
    if (sessionCache.checkThreshold(hmemConfig.contextTokenThreshold)) {
        const tokK = Math.round(sessionCache.totalTokensDelivered / 1000);
        result.content[result.content.length - 1].text += CONTEXT_THRESHOLD_WARNING.replace("{tokens}", String(tokK));
    }
    return result;
}
/**
 * Format recent O-entries block using the 5-level hierarchy.
 * Shows sessions (L2), last batch rolling summary (L3), and recent exchanges (L4→L5).
 * @param store - HmemStore instance
 * @param limit - total O-entries to show
 * @param exchangeCount - number of exchanges to show from the latest O-entry
 * @param linkedTo - optional project ID filter
 * @param expandAll - if true, expand all O-entries (not just the first)
 * @returns formatted string + list of O-entry IDs for cache registration
 */
/** Compress exchange text for display: strip noise, collapse to meaningful lines, truncate. */
function compressExchangeText(text, maxLen) {
    if (!text)
        return "";
    // Replace code blocks with placeholder
    let cleaned = text.replace(/```[\s\S]*?```/g, "[code]");
    // Replace markdown tables (lines with |---|) with placeholder
    const tablePattern = /(?:^|\n)\|[^\n]+\|(?:\n\|[-: |]+\|)?(?:\n\|[^\n]+\|)*/g;
    cleaned = cleaned.replace(tablePattern, "\n[table]");
    // Replace inline JSON objects (multi-line { ... }) with placeholder
    cleaned = cleaned.replace(/\{[\s\S]{80,}?\}/g, "[config]");
    // Collect meaningful lines (skip blanks, deduplicate placeholders)
    const lines = cleaned.split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0);
    // Build result from meaningful lines, joining with " | "
    let result = "";
    for (const line of lines) {
        if (!result) {
            result = line;
        }
        else if (result.length + line.length + 3 <= maxLen) {
            result += " | " + line;
        }
        else {
            break;
        }
    }
    if (result.length > maxLen) {
        result = result.substring(0, maxLen - 3) + "...";
    }
    return result;
}
function formatRecentOEntries(store, limit, exchangeCount, linkedTo, expandAll) {
    if (limit <= 0)
        return { text: "", ids: [] };
    const recentO = store.getRecentOEntries(limit, linkedTo);
    if (recentO.length === 0)
        return { text: "", ids: [] };
    const lines = ["Recent sessions:"];
    const ids = recentO.map(o => o.id);
    for (let i = 0; i < recentO.length; i++) {
        const o = recentO[i];
        lines.push(`  ${o.id}  ${o.created_at.substring(0, 10)}  ${o.title}`);
        // Expand: all entries when expandAll, otherwise only latest
        if (expandAll || i === 0) {
            // Show sessions (L2 nodes) — chronological (oldest first), up to 5
            const sessions = store.getChildNodes(o.id)
                .filter(n => n.depth === 2)
                .sort((a, b) => a.seq - b.seq)
                .slice(-5);
            const latestSession = sessions[sessions.length - 1];
            // Find the last NON-CURRENT session with a summary body
            // The current session may have a batch summary but won't have a rolling summary yet
            const summarizedSessions = sessions
                .filter(s => s !== latestSession && s.content && s.content !== s.title);
            const lastSummarized = summarizedSessions.length > 0 ? summarizedSessions[summarizedSessions.length - 1] : null;
            // Find rolling summary: highest-seq L3 child of the last summarized session
            let rollingSum = null;
            if (lastSummarized) {
                const rsBatches = store.getChildNodes(lastSummarized.id)
                    .filter(n => n.depth === 3)
                    .sort((a, b) => b.seq - a.seq);
                if (rsBatches.length > 0 && rsBatches[0].content && rsBatches[0].content !== rsBatches[0].title) {
                    rollingSum = rsBatches[0].content;
                }
            }
            for (const session of sessions) {
                const hasBody = session.content && session.content !== session.title;
                const batches = !hasBody ? store.getChildNodes(session.id)
                    .filter(n => n.depth === 3 && n.content && n.content !== n.title)
                    .sort((a, b) => a.seq - b.seq) : [];
                const isLatest = session === latestSession;
                const isLastSummarized = session === lastSummarized;
                // Keep: latest session (current), last summarized session, and sessions without summary but with batches
                // Skip: older summarized sessions when a rolling summary exists (it covers them)
                if (!isLatest && !isLastSummarized && rollingSum)
                    continue;
                // Skip sessions that have no summary and no batch summaries
                if (!hasBody && batches.length === 0)
                    continue;
                const sessDate = session.created_at.substring(0, 10);
                lines.push(`    [Session ${sessDate}] ${session.title.trim()}`);
                if (hasBody && !(isLastSummarized && rollingSum)) {
                    // Show session summary, but skip it when rolling summary supersedes it
                    lines.push(`      Summary: ${session.content.trim()}`);
                }
                else if (!hasBody) {
                    for (const batch of batches) {
                        lines.push(`      [Batch ${batch.title.trim()}] ${batch.content.trim()}`);
                    }
                }
                // Show rolling summary after the last summarized session
                if (isLastSummarized && rollingSum) {
                    lines.push(`    [Rolling Summary] ${rollingSum}`);
                }
            }
            // Show last N exchanges (L4→L5) — only from the latest session
            const exchanges = latestSession ? store.getOEntryExchangesV2(o.id, exchangeCount, {
                skipIrrelevant: true,
                titleOnlyTags: ["#skill-dialog", "#admin", "#meta", "#repetition"],
                sessionScope: [latestSession.id],
            }) : [];
            for (const ex of exchanges) {
                if (!ex.userText && !ex.agentText) {
                    // Title-only exchange — skip, already covered by batch/session summary
                    continue;
                }
                // Strip XML channel tags from Telegram messages, keep inner text
                let userClean = ex.userText.replace(/<channel[^>]*>\s*/g, "").replace(/<\/channel>\s*/g, "").trim();
                let agentClean = ex.agentText?.replace(/<[^>]+>/g, "").trim() ?? "";
                // Skip meta-only exchanges (session management, no real content)
                const userLower = userClean.toLowerCase();
                if (/^(restarted|reconnected|mcp reconnected|\/mcp|\/clear|\/compact)$/i.test(userClean))
                    continue;
                // Detect and compress skill injections (huge user messages from /skill invocations)
                if (userClean.startsWith("Base directory for this skill:")) {
                    const skillMatch = userClean.match(/skills\/([^/\n]+)/);
                    userClean = skillMatch ? `[invoked /${skillMatch[1]}]` : "[invoked skill]";
                }
                else if (/^---\nname:/m.test(userClean)) {
                    // YAML frontmatter — injected skill content
                    const nameMatch = userClean.match(/name:\s*(.+)/);
                    userClean = nameMatch ? `[invoked /${nameMatch[1].trim()}]` : "[invoked skill]";
                }
                else if (userClean.startsWith("# ") && userClean.length > 500) {
                    // Large markdown doc injection
                    const heading = userClean.split("\n")[0].replace(/^#+\s*/, "");
                    userClean = `[doc: ${heading.substring(0, 80)}]`;
                }
                // Strip system-reminder tags that leak into exchange text
                userClean = userClean.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
                agentClean = agentClean.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
                // Compress multiline text: strip code blocks, tables, collapse to key lines
                userClean = compressExchangeText(userClean, 300);
                agentClean = compressExchangeText(agentClean, 300);
                if (!userClean && !agentClean)
                    continue; // nothing left after filtering
                lines.push(`    USER: ${userClean}`);
                if (agentClean)
                    lines.push(`    AGENT: ${agentClean}`);
            }
        }
    }
    return { text: lines.join("\n"), ids };
}
// ---- Server ----
const server = new McpServer({
    name: "hmem",
    version: "2.2.0",
});
// ---- Tool: search_memory ----
server.tool("search_memory", "Searches the collective memory: agent memories (lessons learned, evaluations), " +
    "and optionally personalities, project documentation, and skills. " +
    "Use this tool to learn from past experiences before starting a task.", {
    query: z.string().min(2).describe("Search terms (e.g. 'Node.js performance error', 'frontend testing strategy')"),
    scope: z
        .enum(["memories", "personalities", "projects", "skills", "all"])
        .optional()
        .describe("Limit search scope: 'memories' = agent .hmem databases, 'personalities' = agent roles, " +
        "'projects' = project docs, 'skills' = skill references, 'all' = everything (default)"),
    max_results: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Max results (default: 10)"),
}, async ({ query, scope, max_results }) => {
    log(`search_memory: query="${query}", scope=${scope || "all"}`);
    const results = searchMemory(PROJECT_DIR, query, {
        scope: scope || "all",
        maxResults: max_results || 10,
    });
    if (results.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `No results for "${query}" (Scope: ${scope || "all"}).\n\nTip: Try more general terms or a different scope.`,
                },
            ],
        };
    }
    const output = results
        .map((r, i) => {
        const header = r.agent
            ? `### ${i + 1}. ${r.agent} — ${r.file} (Score: ${r.score})`
            : `### ${i + 1}. ${r.file} (Score: ${r.score})`;
        const excerpts = r.excerpts.map((e) => `> ${e.replace(/\n/g, "\n> ")}`).join("\n\n");
        return `${header}\n${excerpts}`;
    })
        .join("\n\n---\n\n");
    return {
        content: [
            {
                type: "text",
                text: `## Memory Search: "${query}"\n**${results.length} hits** (Scope: ${scope || "all"})\n\n${output}`,
            },
        ],
    };
});
// ---- Humanlike Memory (.hmem) ----
/** Resolve a template string with {key} placeholders. */
function resolveTemplate(template, vars) {
    return template.replace(/\{([\w.]+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}
/** Execute configured reactions after a write/append/update event.
 *  Returns notification lines to append to the tool response.
 *  Runs within the caller's already-open hmemStore — no extra DB connection needed. */
function executeReactions(event, hmemStore, cfg) {
    if (!cfg.reactions || cfg.reactions.length === 0)
        return [];
    const notifications = [];
    for (const reaction of cfg.reactions) {
        if (reaction.on !== event.type)
            continue;
        if (reaction.prefix && reaction.prefix !== event.prefix)
            continue;
        if ("sectionName" in reaction && reaction.sectionName && reaction.sectionName !== event.sectionTitle)
            continue;
        if (reaction.action === "create_entry") {
            // Title: first line of content; skip if it equals the section header
            const firstLine = event.content.split("\n")[0].trim();
            const sectionHeader = event.sectionTitle ?? "";
            const nodeTitle = firstLine.toLowerCase() === sectionHeader.toLowerCase() || !firstLine
                ? (() => {
                    // Use root entry title + sectionName for the L-entry
                    const rootEntry = hmemStore.readEntry(event.rootId);
                    const rootTitle = rootEntry ? rootEntry.level_1.split("\n")[0].trim() : event.rootId;
                    return `${rootTitle} — ${sectionHeader}`;
                })()
                : firstLine;
            // Build entry content: title + schema sections (if schema exists for createPrefix)
            const schema = cfg.schemas?.[reaction.createPrefix];
            const sectionLines = schema
                ? "\n" + schema.sections.map(s => `\t${s.name}`).join("\n")
                : "";
            const newContent = nodeTitle + sectionLines;
            // Tags: inherited from root + prefix-specific defaults
            const rootTags = reaction.inheritTags ? hmemStore.fetchTags(event.rootId) : [];
            const extraTags = reaction.createPrefix === "E" ? ["#open"] : [];
            const allTags = [...new Set([...rootTags, ...extraTags])];
            const result = hmemStore.write(reaction.createPrefix, newContent, [event.nodeId], undefined, false, allTags);
            // For append reactions: rewrite the first new child to include the new entry reference
            if (event.type === "append" && event.newChildIds && event.newChildIds.length > 0) {
                for (const childId of event.newChildIds) {
                    const childNode = hmemStore.readNode(childId);
                    const childTitle = childNode?.title ?? "";
                    hmemStore.updateNode(childId, `[${result.id}] ${childTitle}`);
                }
            }
            if (reaction.notify) {
                notifications.push(resolveTemplate(reaction.notify, {
                    "created.id": result.id,
                    "node.title": nodeTitle,
                    "parent.id": event.rootId,
                    "node.id": event.nodeId,
                }));
            }
        }
        else if (reaction.action === "notify") {
            notifications.push(resolveTemplate(reaction.notify, {
                "parent.id": event.rootId,
                "node.id": event.nodeId,
                "section.name": event.sectionTitle ?? "",
            }));
        }
        else if (reaction.action === "check_related") {
            const entryTags = hmemStore.fetchTags(event.rootId);
            if (entryTags.length >= 2) {
                const related = hmemStore.findRelated(event.rootId, entryTags, 10)
                    .filter(r => r.id.startsWith(reaction.checkPrefix));
                if (related.length > 0) {
                    const matchList = related.map(r => `  ${r.id}  ${r.title}`).join("\n");
                    if (reaction.notify) {
                        notifications.push(resolveTemplate(reaction.notify, { "matches": matchList }));
                    }
                }
            }
        }
    }
    return notifications;
}
const prefixList = formatPrefixList(hmemConfig.prefixes);
const prefixKeys = Object.keys(hmemConfig.prefixes);
const REMINDER_HINT = "\nACTION: Scan the entries above. Mark stale/noise as irrelevant, important ones as favorite, wrong ones as obsolete. Do it NOW — don't just note it.\n  update_memory(id=\"X\", irrelevant=true)  — hide noise\n  update_memory(id=\"X\", favorite=true)    — pin important\n  update_memory(id=\"X\", content=\"Wrong — see [✓correctionId]\", obsolete=true)  — correct mistakes";
server.tool("write_memory", "Write a new memory entry to your hierarchical long-term memory (.hmem). " +
    "Use tab indentation to create depth levels:\n" +
    "  Level 1: No indentation — the rough summary (always visible at startup)\n" +
    "  Level 2: 1 tab — more detail (loaded on demand)\n" +
    "  Level 3: 2 tabs — even more detail\n" +
    "  Level 4: 3 tabs — fine-grained detail\n" +
    "  Level 5: 4 tabs — raw context/data\n" +
    "Body text (shown on drill-down, hidden in listings): use the 'body' parameter — or a blank line in 'content':\n" +
    "  write_memory(title='My Entry', body='Detailed body text.', content='\\tSection\\n\\t\\tDetails')\n" +
    "  write_memory(content='My Entry\\n\\nBody text.\\n\\tSection\\n\\t\\tDetails')  ← legacy format\n" +
    "The system auto-assigns an ID and timestamp. " +
    `Use prefix to categorize: ${prefixList}.\n\n` +
    "Store types:\n" +
    "  personal (default): Your private memory\n", {
    prefix: z.string().toUpperCase().describe(`Memory category: ${prefixList}`),
    title: z.string().optional().describe("Optional: explicit root title. If provided, overrides the first line of 'content'. Use together with 'body'."),
    body: z.string().optional().describe("Optional: explicit body text for the root entry (shown on drill-down, hidden in listings). " +
        "Prefer this over blank-line tricks in 'content'. " +
        "Example: write_memory(prefix='P', title='My Project', body='Full description.', content='\\tSection\\n\\t\\tDetails')"),
    content: z.string().optional().describe("Memory content with tab-indented sub-nodes. " +
        "If 'title' is provided: only sub-nodes here (no L1 title needed). " +
        "Legacy mode (no 'title'): full entry including title + blank-line body.\n" +
        "Example (title+body mode): content='\\tSection\\n\\t\\tDetails'\n" +
        "Example (legacy): content='My Entry\\n\\nBody text.\\n\\tSection'"),
    links: jsonArrayString(z.array(z.string()).optional()).describe("Optional: IDs of related memories, e.g. ['P0001', 'L0005']"),
    favorite: z.coerce.boolean().optional().describe("Mark this entry as a favorite — shown with [♥] in bulk reads and always inlined with L2 detail. " +
        "Use for reference info you need to see every session, regardless of category."),
    tags: jsonArrayString(z.array(z.string()).min(1)).describe("Required hashtags for cross-cutting search (min 1, recommend 3+). " +
        "E.g. ['#hmem', '#curation']. Max 10, lowercase, must start with #. Shown after title in reads."),
    pinned: z.coerce.boolean().optional().describe("Mark this entry as pinned [P] (super-favorite). Pinned entries show full L2 content in bulk reads. " +
        "Use for reference entries you need to see in full every session."),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' or 'company'"),
    force: z.coerce.boolean().optional().describe("Force creation of a new root entry even if existing entries share tags. " +
        "Only use when you intentionally want a separate entry, not a child of an existing one."),
}, async ({ prefix, title: titleParam, body: bodyParam, content: rawContent, links, favorite, tags, pinned, store: storeName, force }) => {
    const isFirstTime = !fs.existsSync(HMEM_PATH);
    // Build effective content from title/body/content params
    let content;
    if (titleParam !== undefined) {
        // New mode: title + optional body + optional sub-nodes
        const subNodes = rawContent?.trim() ?? "";
        content = titleParam
            + (bodyParam ? "\n\n" + bodyParam : "")
            + (subNodes ? "\n" + subNodes : "");
    }
    else if (rawContent !== undefined && rawContent.trim().length >= 3) {
        // Legacy mode: full content string
        if (bodyParam) {
            // Inject body after first line
            const nl = rawContent.indexOf("\n");
            const firstLine = nl >= 0 ? rawContent.substring(0, nl) : rawContent;
            const rest = nl >= 0 ? rawContent.substring(nl + 1) : "";
            content = firstLine + "\n\n" + bodyParam + (rest.trim() ? "\n" + rest : "");
        }
        else {
            content = rawContent;
        }
    }
    else {
        return {
            content: [{ type: "text", text: "ERROR: Either 'title' or 'content' (min 3 chars) must be provided." }],
            isError: true,
        };
    }
    // O-prefix is reserved for flush_context
    if (prefix.toUpperCase() === "O") {
        return {
            content: [{ type: "text", text: "ERROR: O-prefix entries are created via flush_context, not write_memory." }],
            isError: true,
        };
    }
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            // Warn if database is corrupted
            if (hmemStore.corrupted) {
                return {
                    content: [{ type: "text", text: "WARNING: Memory database is corrupted! A backup (.corrupt) was saved automatically.\n" +
                                "Writing to a corrupted database may cause further data loss.\n" +
                                "Recover via: git show LAST_GOOD_COMMIT:path/to/file.hmem > recovered.hmem" }],
                    isError: true,
                };
            }
            if (storeName === "personal")
                syncPullThenPush(HMEM_PATH);
            // Multi-agent ID-collision prevention: reserve next ID at sync server before writing.
            // No-op if hmem-sync is disabled. Throws after maxAttempts if continually conflicting.
            if (storeName === "personal") {
                reserveNextId(HMEM_PATH, prefix, hmemStore);
            }
            const result = hmemStore.write(prefix, content, links, undefined, favorite, tags, pinned, force);
            const storeLabel = storeName === "company" ? "company" : path.basename(HMEM_PATH, ".hmem");
            log(`write_memory [${storeLabel}]: ${result.id} (prefix=${prefix})`);
            // Reactions (must run before syncPush to include in same sync batch)
            const reactionNotes = storeName === "personal" && hmemConfig.reactions?.length
                ? executeReactions({
                    type: "write", nodeId: result.id, rootId: result.id,
                    prefix, sectionTitle: null, content,
                }, hmemStore, hmemConfig)
                : [];
            if (storeName === "personal")
                syncPush(HMEM_PATH);
            const firstTimeNote = isFirstTime
                ? `\nMemory store created: ${HMEM_PATH}`
                : "";
            // For E and D entries: show related errors/decisions by tag overlap
            let relatedHint = "";
            if ((prefix === "E" || prefix === "D") && tags && tags.length > 0) {
                const related = hmemStore.findRelated(result.id, tags, 5);
                const relevantRelated = related.filter(r => r.id.startsWith("E") || r.id.startsWith("D"));
                if (relevantRelated.length > 0) {
                    relatedHint = "\n\nSimilar errors/decisions (by tag overlap):\n" +
                        relevantRelated.map(r => `  ${r.id}  ${r.title}`).join("\n");
                }
            }
            // E-entry schema note: schema-driven if defined, else static fallback
            const eSchema = hmemConfig.schemas?.["E"];
            const eNote = prefix === "E"
                ? `\nSchema: ${eSchema ? eSchema.sections.map((s, i) => `.${i + 1} ${s.name}`).join(", ") : ".1 Analysis, .2 Possible Fixes, .3 Fixing Attempts, .4 Solution, .5 Cause, .6 Key Learnings"}`
                : "";
            const reactionSection = reactionNotes.length > 0
                ? "\n\n" + reactionNotes.join("\n\n")
                : "";
            const structNote = result.structure
                ? `\nCreated:\n${result.structure.split("\n").map(l => `  ${l}`).join("\n")}`
                : "";
            return {
                content: [{
                        type: "text",
                        text: `Memory saved: ${result.id} (${result.timestamp.substring(0, 19)})\n` +
                            `Store: ${storeLabel} | Category: ${prefix}` +
                            firstTimeNote + eNote + structNote + relatedHint + reactionSection,
                    }],
            };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        // Similar-entries hit is not a real error — it's a deduplication hint.
        // Return it as a non-error so the UI doesn't flag it in red (issue #15).
        if (e instanceof SimilarEntriesError) {
            return {
                content: [{ type: "text", text: `Note: ${e.message}` }],
            };
        }
        return {
            content: [{ type: "text", text: `ERROR: ${safeError(e)}` }],
            isError: true,
        };
    }
});
server.tool("update_memory", "Update the text of an existing memory entry or sub-node (your own personal memory). " +
    "Only modifies the text at the specified ID — children are preserved unchanged.\n\n" +
    "Use cases:\n" +
    "- Update title only: update_memory(id='L0003', content='corrected summary')\n" +
    "- Update body only: update_memory(id='L0003', body='New detailed body text.')  ← title preserved\n" +
    "- Update title+body: update_memory(id='L0003', content='Short title', body='Detailed body text.')\n" +
    "- Fix a sub-node: update_memory(id='L0003.2', content='node title', body='node body')\n" +
    "- Mark as obsolete: FIRST write the correction, THEN update with [✓ID] reference:\n" +
    "  1. write_memory(prefix='E', content='Correct fix is...') → E0076\n" +
    "  2. update_memory(id='E0042', content='Wrong — see [✓E0076]', obsolete=true)\n" +
    "- Mark as favorite: update_memory(id='D0010', content='...', favorite=true)\n" +
    "- Mark as irrelevant: update_memory(id='L0042', content='...', irrelevant=true)\n" +
    "  No correction entry needed (unlike obsolete). Hidden from bulk reads.\n\n" +
    "To add new child nodes, use append_memory. " +
    "To replace an entire entry, mark the old root obsolete and write a new one.", {
    id: z.string().describe("ID of the entry or node to update, e.g. 'L0003' or 'L0003.2'"),
    content: z.string().optional().describe("New title (and optionally body via blank-line format). Plain text, no indentation. " +
        "If 'body' is also provided, this becomes the new title and 'body' becomes the new body. " +
        "Omit to update only body text (preserves existing title)."),
    body: z.string().optional().describe("New body text for this node (shown on drill-down). " +
        "If 'content' is also provided: content=new title, body=new body. " +
        "If only 'body' is provided: existing title is preserved, only body text is updated."),
    links: jsonArrayString(z.array(z.string()).optional()).describe("Optional: update linked entry IDs (root entries only). Replaces existing links."),
    obsolete: z.coerce.boolean().optional().describe("Mark this root entry as no longer valid (root entries only). " +
        "Requires [✓ID] correction reference in content (e.g. 'Wrong — see [✓E0076]')."),
    favorite: z.coerce.boolean().optional().describe("Set or clear the [♥] favorite flag. Works on root entries and sub-nodes. " +
        "Root favorites are always shown with L2 detail in bulk reads."),
    irrelevant: z.coerce.boolean().optional().describe("Mark as irrelevant [-]. Works on root entries and sub-nodes. " +
        "No correction entry needed (unlike obsolete). Irrelevant entries/nodes are hidden from output."),
    tags: jsonArrayString(z.array(z.string()).optional()).describe("Set tags on this entry/node. Replaces all existing tags. " +
        "Pass empty array [] to remove all tags. E.g. ['#hmem', '#curation']."),
    pinned: z.coerce.boolean().optional().describe("Set or clear the [P] pinned flag (root entries only). " +
        "Pinned entries show full L2 content in bulk reads (super-favorite)."),
    active: z.coerce.boolean().optional().describe("Mark this root entry as actively relevant [*] (root entries only). " +
        "When any entry in a prefix has active=true, only active entries of that prefix are shown with children in bulk reads. " +
        "Non-active entries in the same prefix are shown as title-only (no children)."),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' or 'company'"),
    hmem_path: z.string().optional().describe("Curator mode: absolute path to an external .hmem file to update. " +
        "Overrides the `store` parameter. Sync is skipped for external files."),
}, async ({ id, content: rawContent, body: bodyParam, links, obsolete, favorite, irrelevant, tags, pinned, active, store: storeName, hmem_path }) => {
    try {
        const { store: hmemStore, label: storeLabelResolved } = resolveStore(storeName, hmem_path);
        const isExternal = !!hmem_path;
        // Build effective content from body param if provided
        let content = rawContent;
        if (bodyParam !== undefined) {
            if (content !== undefined && content.trim().length > 0) {
                // content = new title, body = new body
                content = content.trim() + "\n\n" + bodyParam;
            }
            else {
                // body only: preserve existing title
                const existingTitle = hmemStore.getTitle(id);
                if (existingTitle === null) {
                    return {
                        content: [{ type: "text", text: `ERROR: Entry "${id}" not found.` }],
                        isError: true,
                    };
                }
                content = existingTitle + "\n\n" + bodyParam;
            }
        }
        try {
            if (hmemStore.corrupted) {
                return {
                    content: [{ type: "text", text: "WARNING: Memory database is corrupted! Aborting update to prevent further data loss." }],
                    isError: true,
                };
            }
            if (storeName === "personal" && !isExternal)
                syncPullThenPush(HMEM_PATH);
            // Cross-project write notice: if updating a P-sub-node of a project that isn't currently
            // active, do NOT auto-switch. The agent may be doing a quick cross-project edit (e.g.
            // logging a hmem bug while working on another project). Instead, return a notice in the
            // response so the agent can decide whether to load_project() and switch context.
            const rootId = id.includes(".") ? id.split(".")[0] : id;
            let crossProjectNotice = "";
            if (rootId.startsWith("P") && storeName === "personal" && !isExternal) {
                const current = hmemStore.getActiveProject(currentSessionId());
                if (!current || current.id !== rootId) {
                    crossProjectNotice = `\n\nNotice: ${rootId} is not the currently active project${current ? ` (active: ${current.id})` : ""}. ` +
                        `Session exchanges will continue to log under the active project's O-entry. ` +
                        `If you want to switch context to ${rootId}, call load_project(id="${rootId}").`;
                }
            }
            // Auto-mark completed tasks as irrelevant (✓ DONE in title)
            if (irrelevant === undefined && content) {
                const trimmed = content.split("\n")[0].trim();
                if (trimmed.startsWith("✓ DONE") || trimmed.startsWith("DONE:")) {
                    irrelevant = true;
                }
            }
            // Reactions: read section title BEFORE update (so reaction matching uses original section name)
            const isL2SubNode = id.includes(".") && id.split(".").length === 2;
            const priorSectionTitle = isL2SubNode && !isExternal
                ? (hmemStore.readNode(id)?.title ?? null)
                : null;
            const ok = hmemStore.updateNode(id, content, links, obsolete, favorite, undefined, irrelevant, tags, pinned, active);
            const storeLabel = storeLabelResolved;
            log(`update_memory [${storeLabel}]: ${id} → ${ok ? "updated" : "not found"}${obsolete ? " (marked obsolete)" : ""}${irrelevant ? " (marked irrelevant)" : ""}${favorite !== undefined ? ` (favorite=${favorite})` : ""}${active !== undefined ? ` (active=${active})` : ""}`);
            if (!ok) {
                return {
                    content: [{ type: "text", text: `ERROR: Entry "${id}" not found in ${storeLabel}.` }],
                    isError: true,
                };
            }
            const parts = [`Updated: ${id}`];
            if (links !== undefined)
                parts.push("links updated");
            if (obsolete === true)
                parts.push("marked as [!] obsolete");
            if (irrelevant === true)
                parts.push("marked as [-] irrelevant");
            if (irrelevant === false)
                parts.push("irrelevant flag cleared");
            if (favorite === true)
                parts.push("marked as [♥] favorite");
            if (favorite === false)
                parts.push("favorite flag cleared");
            if (pinned === true)
                parts.push("marked as [P] pinned");
            if (pinned === false)
                parts.push("pinned flag cleared");
            if (active === true)
                parts.push("marked as [*] active");
            if (active === false)
                parts.push("active flag cleared");
            if (tags !== undefined)
                parts.push(tags.length > 0 ? `tags: ${tags.join(" ")}` : "tags cleared");
            // Reactions on L2 section updates
            const reactionNotes = storeName === "personal" && !isExternal && priorSectionTitle && hmemConfig.reactions?.length
                ? executeReactions({
                    type: "update", nodeId: id, rootId,
                    prefix: rootId.match(/^([A-Z])/)?.[1] ?? "",
                    sectionTitle: priorSectionTitle, content: content ?? "",
                }, hmemStore, hmemConfig)
                : [];
            if (storeName === "personal" && !isExternal) {
                const retry = syncPushWithRetry(HMEM_PATH);
                if (!retry.resolved) {
                    parts.push(`⚠ unresolved push conflicts after ${retry.attempts} attempts`);
                }
                else if (retry.attempts > 1) {
                    parts.push(`(resolved push conflict after ${retry.attempts} attempts)`);
                }
            }
            const reactionSection = reactionNotes.length > 0
                ? "\n\n" + reactionNotes.join("\n\n")
                : "";
            return { content: [{ type: "text", text: parts.join(" | ") + crossProjectNotice + reactionSection }] };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${safeError(e)}` }],
            isError: true,
        };
    }
});
server.tool("update_many", "Batch-update multiple memory entries at once. Applies the same flag(s) to all listed IDs. " +
    "Use this instead of calling update_memory multiple times during curation.\n\n" +
    "Example: update_many(ids=['T0005', 'T0012', 'L0044'], irrelevant=true)", {
    ids: z.array(z.string()).min(1).describe("List of entry/node IDs to update, e.g. ['T0005', 'T0012', 'L0044']"),
    irrelevant: z.coerce.boolean().optional().describe("Mark all as irrelevant [-]"),
    favorite: z.coerce.boolean().optional().describe("Set or clear [♥] favorite on all"),
    active: z.coerce.boolean().optional().describe("Set or clear [*] active on all"),
    pinned: z.coerce.boolean().optional().describe("Set or clear [P] pinned on all"),
    store: z.enum(["personal", "company"]).default("personal"),
}, async ({ ids, irrelevant, favorite, active, pinned, store: storeName }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            if (storeName === "personal")
                syncPullThenPush(HMEM_PATH);
            let updated = 0;
            let notFound = 0;
            for (const id of ids) {
                const ok = hmemStore.updateNode(id, undefined, undefined, undefined, favorite, undefined, irrelevant, undefined, pinned, active);
                if (ok)
                    updated++;
                else
                    notFound++;
            }
            const storeLabel = storeName === "company" ? "company" : path.basename(HMEM_PATH, ".hmem");
            const flags = [
                irrelevant !== undefined ? `irrelevant=${irrelevant}` : "",
                favorite !== undefined ? `favorite=${favorite}` : "",
                active !== undefined ? `active=${active}` : "",
                pinned !== undefined ? `pinned=${pinned}` : "",
            ].filter(Boolean).join(", ");
            log(`update_many [${storeLabel}]: ${updated}/${ids.length} updated (${flags})`);
            if (storeName === "personal")
                syncPush(HMEM_PATH);
            const result = `Updated ${updated} of ${ids.length} entries (${flags})`;
            return {
                content: [{ type: "text", text: notFound > 0 ? `${result}\n${notFound} not found` : result }],
            };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${safeError(e)}` }],
            isError: true,
        };
    }
});
server.tool("flush_context", "Store a conversation chunk as linear context history (O-prefix). " +
    "The AI does the summarization: chunk raw text by topic, then summarize progressively.\n\n" +
    "Recommended: provide L1 (title) + L2 (paragraph summary) + L5 (raw text).\n" +
    "L3/L4 are optional intermediate levels for extra detail.\n\n" +
    "O-entries are hidden from bulk reads but discoverable via search, tags, and context_for.\n" +
    "Use during /save to preserve raw session context alongside curated P/L/D/E entries.", {
    l1: z.string().min(3).max(200).describe("One-line topic title for this chunk. E.g. 'hmem UX improvements session'"),
    l2: z.string().optional().describe("Paragraph summary (~100 words). Key decisions and outcomes."),
    l3: z.string().optional().describe("Detailed summary (~500 words). Only if L2 is too compressed."),
    l4: z.string().optional().describe("Extended context (~2000 words). Rarely needed."),
    l5: z.string().optional().describe("Raw conversation chunk. Full text, no summarization."),
    tags: jsonArrayString(z.array(z.string()).min(1)).describe("Required hashtags for discovery. E.g. ['#hmem', '#context-for', '#ux']"),
    links: jsonArrayString(z.array(z.string()).optional()).describe("Link to related entries. E.g. ['P0029', 'D0120']"),
}, async ({ l1, l2, l3, l4, l5, tags, links }) => {
    try {
        const hmemStore = new HmemStore(HMEM_PATH, hmemConfig);
        try {
            syncPullThenPush(HMEM_PATH);
            const result = hmemStore.writeLinear("O", { l1, l2, l3, l4, l5 }, tags, links);
            const levels = [l1, l2, l3, l4, l5].filter(Boolean).length;
            log(`flush_context: ${result.id} (${levels} levels, ${tags.join(" ")})`);
            syncPush(HMEM_PATH);
            return trackTokens({
                content: [{
                        type: "text",
                        text: `Context saved: ${result.id} (${levels} levels)\n` +
                            `Title: ${l1}\nTags: ${tags.join(" ")}` +
                            (links?.length ? `\nLinks: ${links.join(", ")}` : ""),
                    }],
            });
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${safeError(e)}` }],
            isError: true,
        };
    }
});
server.tool("append_memory", "Append new child nodes to an existing memory entry or node (your own personal memory). " +
    "Existing children are preserved — new nodes are added after them.\n\n" +
    "Use this to extend an existing entry with additional detail without overwriting it.\n\n" +
    "Content uses tab indentation relative to the parent:\n" +
    "  0 tabs = direct child of id\n" +
    "  1 tab  = grandchild, etc.\n" +
    "Two modes:\n" +
    "  Simple (title+body): append_memory(id='L0003', title='New finding', body='Detailed explanation')\n" +
    "  Complex (full sub-tree): append_memory(id='L0003', content='New finding\\n\\tSub-detail\\n\\t\\tDeep')\n\n" +
    "Examples:\n" +
    "  append_memory(id='P0048.6', title='Crash on startup', body='Steps: open app, click X') → adds L3 node with body\n" +
    "  append_memory(id='L0003.2', content='Extra note') → adds child node under L0003.2", {
    id: z.string().describe("Root entry ID or parent node ID to append children to, e.g. 'L0003' or 'L0003.2'"),
    title: z.string().optional().describe("Simple mode: title for the new node. Use with 'body' for clean title+body creation."),
    body: z.string().optional().describe("Simple mode: body text for the new node (shown on drill-down). Use with 'title'."),
    content: z.string().optional().describe("Complex mode: full tab-indented sub-tree to append. 0 tabs = direct child of id.\n" +
        "Example: 'New section\\n\\tChild\\n\\t\\tGrandchild'. Omit if using 'title'+'body'."),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' or 'company'"),
}, async ({ id, title: titleParam, body: bodyParam, content: rawContent, store: storeName }) => {
    // Build effective content from title/body or raw content
    let content;
    if (titleParam !== undefined) {
        content = titleParam + (bodyParam ? "\n\n" + bodyParam : "");
    }
    else if (rawContent !== undefined && rawContent.trim().length > 0) {
        content = rawContent;
    }
    else {
        return {
            content: [{ type: "text", text: "ERROR: Either 'title' or 'content' must be provided." }],
            isError: true,
        };
    }
    // Schema enforcement: if a schema is defined for this prefix, only allow appending
    // L2 nodes whose names are defined schema sections. Non-schema nodes are blocked.
    // Agents may append missing sections (e.g. after a schema upgrade) by passing the
    // section names as content — all top-level lines must be valid schema section names.
    if (!id.includes(".")) {
        const appendPrefix = id.match(/^([A-Z])/)?.[1];
        if (appendPrefix && hmemConfig.schemas?.[appendPrefix]) {
            const appendSchema = hmemConfig.schemas[appendPrefix];
            // Simulate parseRelativeTree body-mode logic to extract depth-0 titles
            const newSectionTitles = [];
            const bodyModeAtRelDepth = new Map();
            let lastRelDepth = -1;
            for (const rawLine of content.split("\n")) {
                const text = rawLine.trim();
                if (!text) {
                    if (lastRelDepth >= 0)
                        bodyModeAtRelDepth.set(lastRelDepth, true);
                    continue;
                }
                const tabs = rawLine.match(/^\t*/)?.[0].length ?? 0;
                if (tabs === 0) {
                    if (!bodyModeAtRelDepth.get(0)) {
                        newSectionTitles.push(text);
                        bodyModeAtRelDepth.delete(0); // reset body mode for new node
                    }
                    // body lines do not reset body mode — stays sticky
                }
                lastRelDepth = tabs;
            }
            const schemaNameSet = new Set(appendSchema.sections.map(s => s.name));
            const allAreSchemaSection = newSectionTitles.length > 0 &&
                newSectionTitles.every(t => schemaNameSet.has(t));
            if (!allAreSchemaSection) {
                const sectionList = appendSchema.sections.map((s, i) => `  .${i + 1}  ${s.name}`).join("\n");
                return {
                    content: [{ type: "text", text: `ERROR: ${id} uses a fixed schema — cannot add new L2 nodes directly.\n` +
                                `Defined sections:\n${sectionList}\n\n` +
                                `Append to a specific section instead, e.g.:\n` +
                                `  append_memory(id="${id}.1", content="...")  → ${appendSchema.sections[0]?.name ?? "first section"}` }],
                    isError: true,
                };
            }
            // All top-level lines are valid schema sections — allow the append
        }
    }
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            if (hmemStore.corrupted) {
                return {
                    content: [{ type: "text", text: "WARNING: Memory database is corrupted! Aborting append to prevent further data loss." }],
                    isError: true,
                };
            }
            if (storeName === "personal")
                syncPullThenPush(HMEM_PATH);
            // Cross-project write notice (see update_memory for rationale)
            const rootId = id.includes(".") ? id.split(".")[0] : id;
            let crossProjectNotice = "";
            if (rootId.startsWith("P") && storeName === "personal") {
                const current = hmemStore.getActiveProject(currentSessionId());
                if (!current || current.id !== rootId) {
                    crossProjectNotice = `\n\nNotice: ${rootId} is not the currently active project${current ? ` (active: ${current.id})` : ""}. ` +
                        `Session exchanges will continue to log under the active project's O-entry. ` +
                        `If you want to switch context to ${rootId}, call load_project(id="${rootId}").`;
                }
            }
            // Sub-node ID reservation: prevent two agents from racing on the same sub-id
            // (e.g. both inserting P0048.7.5 with different content). On conflict the loop
            // pulls and recomputes the next free sub-seq before retrying.
            if (storeName === "personal") {
                reserveNextSubIds(HMEM_PATH, id, content, hmemStore);
            }
            // Read section title BEFORE append for reaction matching (id may be a section node like P0048.6)
            const appendSectionTitle = id.includes(".")
                ? (hmemStore.readNode(id)?.title ?? null)
                : null;
            const appendRootId = id.includes(".") ? id.split(".")[0] : id;
            const appendPrefix = appendRootId.match(/^([A-Z])/)?.[1] ?? "";
            const result = hmemStore.appendChildren(id, content);
            const storeLabel = storeName === "company" ? "company" : path.basename(HMEM_PATH, ".hmem");
            log(`append_memory [${storeLabel}]: ${id} + ${result.count} nodes → [${result.ids.join(", ")}]`);
            if (result.count === 0) {
                return {
                    content: [{ type: "text", text: "No nodes appended — content was empty or contained no valid lines." }],
                };
            }
            // Reactions (runs before sync so all writes land in same push)
            const reactionNotes = storeName === "personal" && appendSectionTitle && hmemConfig.reactions?.length
                ? executeReactions({
                    type: "append", nodeId: id, rootId: appendRootId,
                    prefix: appendPrefix, sectionTitle: appendSectionTitle,
                    content, newChildIds: result.ids,
                }, hmemStore, hmemConfig)
                : [];
            let conflictNote = "";
            if (storeName === "personal") {
                const retry = syncPushWithRetry(HMEM_PATH);
                if (!retry.resolved) {
                    conflictNote = `\n⚠ Push had unresolved conflicts after ${retry.attempts} attempts — your local changes are saved but another agent's writes may have collided. Run hmem-sync sync manually to investigate.`;
                }
                else if (retry.attempts > 1) {
                    conflictNote = `\n(resolved push conflict after ${retry.attempts} attempts)`;
                }
            }
            const reactionSection = reactionNotes.length > 0
                ? "\n\n" + reactionNotes.join("\n\n")
                : "";
            return {
                content: [{
                        type: "text",
                        text: `Appended ${result.count} node${result.count === 1 ? "" : "s"} to ${id}.\n` +
                            `New top-level children: ${result.ids.join(", ")}` + conflictNote + crossProjectNotice + reactionSection,
                    }],
            };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${safeError(e)}` }],
            isError: true,
        };
    }
});
server.tool("read_memory", "Read from your hierarchical long-term memory (.hmem). " +
    "At startup, you received all Level 1 entries (rough summaries). " +
    "Use this tool to drill deeper into specific memories.\n\n" +
    "Query modes:\n" +
    "- By ID: read_memory({ id: 'P0001' }) → L1 + direct L2 children (one level at a time)\n" +
    "- By node ID: read_memory({ id: 'P0001.2' }) → that node's content + its direct children\n" +
    "- By prefix: read_memory({ prefix: 'L' }) → All Lessons Learned (Level 1)\n" +
    "- By time: read_memory({ after: '2026-02-15', before: '2026-02-17' })\n" +
    "- Search: read_memory({ search: 'SSE' }) → Full-text search across all levels\n" +
    "- Time-around: read_memory({ time_around: 'P0001' }) → entries near P0001's timestamp\n" +
    "- Title listing: read_memory({ titles_only: true }) → compact table of contents (ID + date + title)\n\n" +
    "Lazy loading: ID queries always return the node + its DIRECT children only.\n" +
    "To go deeper, call read_memory(id=child_id). depth parameter is ignored for ID queries.\n\n" +
    "Store types:\n" +
    "  personal (default): Your private memory\n", {
    id: z.string().optional().describe("Specific memory ID, e.g. 'P0001' or 'L0023'"),
    depth: z.number().min(1).max(4).optional().describe("How deep to read (1-4). Default: 2 when reading by ID, 1 for listings. For L5 detail, drill into specific node IDs."),
    prefix: z.string().optional().describe(`Filter by category: ${prefixKeys.join(", ")}`),
    after: z.string().optional().describe("Only entries after this date (ISO format, e.g. '2026-02-15')"),
    before: z.string().optional().describe("Only entries before this date (ISO format)"),
    search: z.string().optional().describe("Full-text search across all memory levels"),
    limit: z.number().optional().describe("Max results (default: unlimited — all L1 entries are returned)"),
    time: z.string().optional().describe("Time filter 'HH:MM' — filter entries by time of day"),
    period: z.string().optional().describe("Time window: '+4h' (after), '-2h' (before), '4h' (±4h symmetric), 'both' (±2h default)"),
    time_around: z.string().optional().describe("Reference entry ID — find entries created around the same time"),
    show_obsolete: z.coerce.boolean().optional().describe("Include all obsolete entries (default: only top 3 most-accessed)"),
    show_obsolete_path: z.coerce.boolean().optional().describe("When reading an obsolete entry by ID, show the full correction chain instead of just the final valid entry."),
    titles_only: z.coerce.boolean().optional().describe("Compact title listing — shows all entries as ID + date + title, without V2 selection or children. " +
        "Like a table of contents. Combine with prefix to filter by category."),
    expand: z.coerce.boolean().optional().describe("Expand full tree with complete node content (ID queries only). " +
        "Use to deep-dive into a project after a long break. " +
        "depth controls how deep (default: 5 = full tree). " +
        "Example: read_memory({ id: 'P0001', expand: true, depth: 3 })"),
    mode: z.enum(["discover", "essentials"]).optional().describe("Bulk read mode. 'discover' (default for first read): newest-heavy — good for getting an overview. " +
        "'essentials': importance-heavy (more favorites + most-accessed, fewer newest) — " +
        "use after context compression to recover key knowledge. " +
        "Auto-selected if omitted: first bulk read → discover, subsequent → essentials."),
    store: z.enum(["personal", "company"]).default("personal").describe("Source store: 'personal' or 'company'"),
    curator: z.coerce.boolean().optional().describe("Set true to show full metadata (access counts, roles, dates). For curators only."),
    show_all: z.coerce.boolean().optional().describe("Curation mode: show ALL entries of the selected prefix with depth 3 children. " +
        "Bypasses V2 selection and session cache. Use with prefix filter for manageable output."),
    tag: z.string().optional().describe("Filter by hashtag, e.g. '#hmem'. Only entries with this tag are shown in bulk reads. " +
        "Also works with search to find tagged entries."),
    stale_days: z.number().optional().describe("Show entries not accessed in the last N days. Sorted oldest-access first. " +
        "Useful for finding what to curate or review. Example: stale_days=30"),
    context_for: z.string().optional().describe("Load full context for an entry: the entry itself (expanded) + all related entries. " +
        "Related = directly linked OR sharing weighted tag overlap with any node of the source. " +
        "Tag weights: rare(<=5 uses)=3, medium(6-20)=2, common(>20)=1. " +
        "Example: read_memory({ context_for: 'P0029' }) — loads P0029 + all contextually related entries."),
    min_tag_score: z.number().optional().describe("Minimum weighted tag score for context_for matches (default: 5). " +
        "Score 4 = e.g. 2 medium tags, or 1 rare + 1 common. Lower = more results, higher = stricter."),
    hmem_path: z.string().optional().describe("Curator mode: absolute path to an external .hmem file to read from. " +
        "Overrides the `store` parameter. Use to audit/curate another .hmem file."),
}, async ({ id, depth, prefix, after, before, search, limit: maxResults, time, period, time_around, show_obsolete, show_obsolete_path, titles_only, expand, mode, store: storeName, curator, show_all, tag, stale_days, context_for, min_tag_score, hmem_path }) => {
    // Pull before read to get latest from server (30s cooldown)
    const newEntries = storeName === "personal" && !hmem_path ? syncPull(HMEM_PATH) : [];
    try {
        const { store: hmemStore, label: storeLabelResolved, path: resolvedPath } = resolveStore(storeName, hmem_path);
        const isExternal = !!hmem_path;
        try {
            const corruptionWarning = hmemStore.corrupted
                ? "⚠ WARNING: Memory database is corrupted! Reads may be incomplete. A backup (.corrupt) was saved.\n\n"
                : "";
            // Context-for: load source entry expanded + all related entries
            if (context_for) {
                const sourceEntries = hmemStore.read({
                    id: context_for,
                    expand: true,
                });
                if (sourceEntries.length === 0) {
                    return {
                        content: [{ type: "text", text: `Entry not found: ${context_for}` }],
                        isError: true,
                    };
                }
                const source = sourceEntries[0];
                hmemStore.assignBulkTags([source]);
                const { linked, tagRelated } = hmemStore.findContext(context_for, min_tag_score ?? 5, maxResults ?? 30);
                // Bump access_count on all related entries (so they get promoted in future bulk reads)
                for (const e of linked)
                    hmemStore.bumpAccess(e.id);
                for (const { entry } of tagRelated)
                    hmemStore.bumpAccess(entry.id);
                // Deduplicate: remove linked entries from tagRelated
                const linkedIds = new Set(linked.map(e => e.id));
                const dedupedTagRelated = tagRelated.filter(r => !linkedIds.has(r.entry.id));
                const isCurator = curator ?? false;
                const totalRelated = linked.length + dedupedTagRelated.length;
                const sourceChildren = source.children?.length ?? 0;
                const lines = [];
                // Header with summary — visible even when collapsed in Claude Code
                const relatedSummary = [
                    linked.length > 0 ? `${linked.length} linked` : "",
                    dedupedTagRelated.length > 0 ? `${dedupedTagRelated.length} tag-related` : "",
                ].filter(Boolean).join(", ");
                lines.push(`## Context for ${context_for}: ${source.title}`);
                lines.push(`Source: ${sourceChildren} children | Related: ${relatedSummary || "none"}\n`);
                // Source entry (expanded)
                lines.push("### Source entry\n");
                renderEntryFormatted(lines, source, isCurator, true);
                // Direct links
                if (linked.length > 0) {
                    lines.push(`### Directly linked (${linked.length})\n`);
                    for (const e of linked) {
                        renderEntryFormatted(lines, e, isCurator);
                    }
                }
                // Tag-related
                if (dedupedTagRelated.length > 0) {
                    lines.push(`### Tag-related (${dedupedTagRelated.length} entries, score >= ${min_tag_score ?? 5})\n`);
                    for (const { entry, score, matchNode } of dedupedTagRelated) {
                        renderEntryFormatted(lines, entry, isCurator);
                        if (isCurator) {
                            lines.push(`  [score=${score} via ${matchNode}]`);
                        }
                    }
                }
                const storeLabel = storeLabelResolved;
                const output = lines.join("\n");
                // Add token estimate to header line (2nd line)
                const fmtTok = (n) => n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
                const outputTokens = Math.round(output.length / 4);
                const finalOutput = output.replace(/^(## Context for .+\n)(Source:.+)\n/, `$1$2 | ~${fmtTok(outputTokens)} tokens\n`);
                log(`read_memory [${storeLabel}]: context_for=${context_for}, ${totalRelated} related (${linked.length} linked, ${dedupedTagRelated.length} tag-related), ~${fmtTok(outputTokens)} tokens`);
                return trackTokens({
                    content: [{ type: "text", text: corruptionWarning + finalOutput }],
                });
            }
            const effectiveDepth = depth || (id ? 2 : 1);
            // Session cache: cached entries shown as titles in subsequent bulk reads
            // Explicit filters (after, before, prefix, stale_days, tag) bypass V2 selection + cache
            const isBulkListing = !id && !search && !time_around && !after && !before && !prefix && !stale_days && !tag;
            const useCache = isBulkListing && storeName === "personal" && !show_all && !isExternal;
            const cachedIds = useCache ? sessionCache.getCachedIds() : undefined;
            const hiddenIds = useCache ? sessionCache.getHiddenIds() : undefined;
            const slotFraction = useCache ? sessionCache.getSlotFraction() : undefined;
            // Auto-select mode: first bulk read → discover, subsequent → essentials
            const effectiveMode = mode ?? (useCache && sessionCache.readCount > 0 ? "essentials" : "discover");
            const entries = hmemStore.read({
                id, depth: effectiveDepth, prefix, after, before, search,
                limit: maxResults,
                time, period, timeAround: time_around,
                showObsolete: show_obsolete,
                showObsoletePath: show_obsolete_path,
                titlesOnly: titles_only,
                expand,
                cachedIds,
                hiddenIds,
                slotFraction,
                showAll: show_all,
                mode: isBulkListing ? effectiveMode : undefined,
                tag,
                staleDays: stale_days,
                directResults: !isBulkListing && !id && !search && !time_around,
            });
            if (entries.length === 0) {
                const hmemPath = resolvedPath;
                const dbExists = fs.existsSync(hmemPath);
                const label = storeLabelResolved;
                const storeInfo = `\nStore: ${label} | DB: ${hmemPath}${dbExists ? "" : " [FILE NOT FOUND]"}`;
                // Sync hint: if memory is empty and hmem-sync is not configured, suggest it
                let syncHint = "";
                if (!id && !search && !time_around) {
                    const hasSyncSetup = getSyncServers(hmemConfig).length > 0 || fs.existsSync(path.join(path.dirname(hmemPath), ".hmem-sync-config.json"));
                    if (!hasSyncSetup) {
                        syncHint = "\n\n💡 Memory is empty. If you have memories on another device, you can sync them:\n" +
                            "  npm install -g hmem-sync\n" +
                            "  npx hmem-sync connect\n" +
                            "Ask the user if they want to set up sync.";
                    }
                }
                const hint = id ? `No memory with ID "${id}".${storeInfo}` :
                    search ? `No memories matching "${search}".${storeInfo}` :
                        time_around ? `No entries found around "${time_around}".${storeInfo}` :
                            `No memories found.${storeInfo}${syncHint}`;
                return { content: [{ type: "text", text: hint }] };
            }
            // Update session cache after bulk read
            if (useCache) {
                const allIds = entries.filter(e => !e.obsolete).map(e => e.id);
                const promotedIds = new Set(entries.filter(e => e.promoted === "favorite" || e.promoted === "access" || e.promoted === "subnode" || e.promoted === "task").map(e => e.id));
                sessionCache.registerDelivered(allIds, promotedIds);
            }
            // Format output
            const output = titles_only
                ? formatTitlesOnly(entries, hmemConfig, curator ?? false)
                : isBulkListing
                    ? formatGroupedOutput(hmemStore, entries, curator ?? false, hmemConfig)
                    : formatFlatOutput(entries, curator ?? false, expand ?? false);
            const stats = hmemStore.stats();
            const storeLabel = storeLabelResolved;
            const visibleCount = entries.length;
            // Cache status in header (when active)
            const hiddenCount = hiddenIds?.size ?? 0;
            const cachedCount = cachedIds?.size ?? 0;
            const cacheInfo = useCache && sessionCache.size > 0
                ? ` | Cache: ${sessionCache.size} seen` + (hiddenCount > 0 ? ` (${hiddenCount} hidden)` : "")
                : "";
            // Mode info in header (only for bulk reads)
            const modeInfo = isBulkListing ? ` | Mode: ${effectiveMode}` : "";
            // Token estimation: output tokens / total tokens
            const outputTokens = Math.round(output.length / 4);
            const totalTokens = Math.round(stats.totalChars / 4);
            const fmtTok = (n) => n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
            const tokenInfo = ` | ${fmtTok(outputTokens)}/${fmtTok(totalTokens)} tokens`;
            // Stale hint + new-since-last-session: on first bulk read OR after cache expiry (fresh start)
            const isFirstOrFresh = isBulkListing && (sessionCache.readCount <= 1 || sessionCache.size === 0);
            const staleHint = isFirstOrFresh && stats.staleCount > 0
                ? ` | ${stats.staleCount} stale (>60d)`
                : "";
            // New-since-last-session: root entries + child nodes created after DB mtime at server start
            // Respects active-prefix: in prefixes with active entries, only show new items from active entries
            let newSinceSection = "";
            if (isFirstOrFresh && dbMtimeAtStart) {
                // Detect active prefixes (prefixes where at least one entry has active=1)
                const activePrefixes = new Set();
                const activeEntryIds = new Set();
                for (const e of entries) {
                    if (e.active) {
                        activePrefixes.add(e.prefix);
                        activeEntryIds.add(e.id);
                    }
                }
                // Filter new roots: skip non-active entries in active prefixes
                const newRoots = entries.filter(e => !e.obsolete && e.created_at > dbMtimeAtStart &&
                    (!activePrefixes.has(e.prefix) || activeEntryIds.has(e.id)));
                const newNodes = hmemStore.getNewNodesSince(dbMtimeAtStart, 20);
                // Exclude nodes belonging to new root entries (already shown)
                // AND nodes whose root is non-active in an active prefix
                const newRootIds = new Set(newRoots.map(e => e.id));
                const newChildNodes = newNodes.filter(n => {
                    if (newRootIds.has(n.root_id))
                        return false; // already shown as root
                    // Check if root entry is suppressed by active-prefix
                    const rootPrefix = n.root_id.replace(/\d+$/, "");
                    if (activePrefixes.has(rootPrefix) && !activeEntryIds.has(n.root_id))
                        return false;
                    return true;
                });
                const parts = [];
                for (const e of newRoots)
                    parts.push(`  ${e.id}  ${e.title ?? e.level_1}`);
                for (const n of newChildNodes) {
                    const title = n.title || (n.content.length > 50 ? n.content.substring(0, 50) : n.content);
                    parts.push(`  ${n.id}  ${title}`);
                }
                if (parts.length > 0) {
                    newSinceSection = `New since last session (${parts.length}):\n${parts.join("\n")}\n\n`;
                }
            }
            // PROJECT GATE: on unfiltered bulk reads, BLOCK output if no project is active.
            // The agent MUST activate a project first — otherwise O-entries go unassigned.
            let projectWarning = "";
            if (!id && !prefix && !search && !time_around && !stale_days && !tag) {
                const hasActiveProject = entries.some(e => e.prefix === "P" && e.active);
                if (!hasActiveProject) {
                    const projects = entries.filter(e => e.prefix === "P" && !e.obsolete && !e.irrelevant);
                    const projectList = projects.length > 0
                        ? projects.map(e => `  ${e.id}  ${e.title}`).join("\n")
                        : "  (no projects yet — create one with write_memory(prefix=\"P\", content=\"Name | Status | Stack | Description\", tags=[...]))";
                    // Inject recent O-entries even without active project (global, no project filter)
                    let recentOHint = "";
                    if (hmemConfig.bulkReadOEntries > 0) {
                        const { text, ids } = formatRecentOEntries(hmemStore, hmemConfig.bulkReadOEntries, 10);
                        if (text) {
                            recentOHint = `\n${text}\n`;
                            sessionCache.registerDelivered(ids);
                        }
                    }
                    return trackTokens({
                        content: [{
                                type: "text",
                                text: `⚠ ACTION REQUIRED: No project is active.\n\n` +
                                    `Ask the user which project to work on, then activate it:\n` +
                                    `  update_memory(id="P00XX", active=true)\n\n` +
                                    `Or create a new one:\n` +
                                    `  write_memory(prefix="P", content="Name | Status | Stack | Description", tags=["#project"])\n\n` +
                                    `Available projects:\n${projectList}\n\n` +
                                    `Session logs (O-entries) will be linked to the active project.\n` +
                                    `Memory data is withheld until a project is activated.` + recentOHint,
                            }],
                    });
                }
            }
            // Inject recent O-entries (session logs) on bulk reads when none are cached
            let recentOSection = "";
            if (isBulkListing && storeName === "personal" && !isExternal && hmemConfig.bulkReadOEntries > 0) {
                const cachedOIds = [...(cachedIds || []), ...(hiddenIds || [])].filter(id => id.startsWith("O"));
                if (cachedOIds.length === 0) {
                    const { text, ids } = formatRecentOEntries(hmemStore, hmemConfig.bulkReadOEntries, 10);
                    if (text) {
                        recentOSection = `\n${text}\n`;
                        sessionCache.registerDelivered(ids);
                    }
                }
            }
            // Check for P-entries that need migration to standard schema
            let migrationHint = "";
            if (!id && !prefix && !search && !time_around && isBulkListing) {
                const STANDARD_L2 = ["overview", "codebase", "usage", "context", "deployment", "known issues", "protocol", "open tasks"];
                const oldPEntries = entries.filter(e => e.prefix === "P" && !e.obsolete && !e.irrelevant && e.children && e.children.length > 0 &&
                    !e.children.some(c => STANDARD_L2.some(cat => (c.content || c.title || "").toLowerCase().startsWith(cat))));
                if (oldPEntries.length > 0) {
                    migrationHint = `\n⚠ P-ENTRY MIGRATION: ${oldPEntries.length} project(s) use old format: ${oldPEntries.map(e => e.id).join(", ")}.\n` +
                        `Standard schema (R0009): Overview → Codebase → Usage → Context → Deployment → Bugs → Protocol → Roadmap → Ideas → Next Steps.\n` +
                        `Create new entry with write_memory(prefix="P", force=true), then mark old one obsolete.\n\n`;
                }
            }
            const header = `## Memory: ${storeLabel} (${stats.total} total entries)\n` +
                `Query: ${id ? `id=${id}` : ""}${prefix ? `prefix=${prefix}` : ""}${search ? `search="${search}"` : ""}${time_around ? `time_around=${time_around}` : ""}${after ? ` after=${after}` : ""}${before ? ` before=${before}` : ""}${time ? ` time=${time}` : ""} | Depth: ${effectiveDepth} | Results: ${visibleCount}${modeInfo}${cacheInfo}${tokenInfo}${staleHint}\n`;
            log(`read_memory [${storeLabel}]: ${visibleCount} results (depth=${effectiveDepth}${cacheInfo})`);
            return trackTokens({
                content: [{
                        type: "text",
                        text: corruptionWarning + projectWarning + migrationHint + newSinceSection + header + "\n" + output + recentOSection + (isBulkListing && (sessionCache.readCount <= 1 || sessionCache.size === 0) ? REMINDER_HINT : ""),
                    }],
            });
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${safeError(e)}` }],
            isError: true,
        };
    }
});
// bump_memory removed — access_count is auto-incremented on reads, favorites cover explicit importance
// ---- Session Cache Reset ----
server.tool("reset_memory_cache", "Clear the session cache so all entries are treated as unseen again. " +
    "The next bulk read will behave like the first read of a fresh session " +
    "(full Fibonacci slots, no suppressed entries).\n\n" +
    "Use when you need a clean slate — e.g., after a major topic change " +
    "or when you suspect important entries were suppressed.", {}, async () => {
    const before = sessionCache.size;
    const readsBefore = sessionCache.readCount;
    sessionCache.reset();
    return {
        content: [{
                type: "text",
                text: `Session cache reset. Cleared ${before} tracked entries, ` +
                    `bulk read counter ${readsBefore} → 0. ` +
                    `Next read_memory() will return the full first-read selection.`,
            }],
    };
});
// ---- Export Memory ----
server.tool("export_memory", "Export your memory, excluding secret entries and secret sub-nodes. " +
    "Use for sharing, backup, or publishing a sanitized version of your memory.", {
    store: z.enum(["personal", "company"]).default("personal").describe("Source store: 'personal' (your own memory) or 'company' (shared company store)"),
    format: z.enum(["text", "hmem"]).default("text").describe("Export format: 'text' = Markdown (returned inline), " +
        "'hmem' = SQLite .hmem file (written to disk)"),
    output_path: z.string().optional().describe("Output path for 'hmem' format. Default: export.hmem next to the source file. " +
        "Ignored for 'text' format."),
}, async ({ store: storeName, format, output_path }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            if (format === "hmem") {
                const defaultPath = path.join(path.dirname(hmemStore.getDbPath()), "export.hmem");
                const outPath = validateFilePath(output_path || defaultPath, path.dirname(hmemStore.getDbPath()));
                const result = hmemStore.exportPublicToHmem(outPath);
                return { content: [{ type: "text", text: `Exported to ${outPath}\n${result.entries} entries, ${result.nodes} nodes, ${result.tags} tags` }] };
            }
            else {
                const output = hmemStore.exportMarkdown();
                return { content: [{ type: "text", text: output }] };
            }
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${safeError(e)}` }],
            isError: true,
        };
    }
});
// ---- Import Memory ----
server.tool("import_memory", "Import entries from a .hmem file into your memory. " +
    "Deduplicates by L1 content (merges sub-nodes), remaps IDs on conflict.", {
    source_path: z.string().describe("Path to .hmem file to import"),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' (your own memory) or 'company' (shared company store)"),
    dry_run: z.coerce.boolean().default(false).describe("Preview only — report what would happen without modifying the database"),
}, async ({ source_path, store: storeName, dry_run }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            const safePath = validateFilePath(source_path, path.dirname(hmemStore.getDbPath()));
            // Pull before import so the dedup logic and ID-remapping see the freshest state.
            // Skip on dry_run since nothing is written.
            if (storeName === "personal" && !dry_run)
                syncPullThenPush(HMEM_PATH);
            const result = hmemStore.importFromHmem(safePath, dry_run);
            const mode = dry_run ? "preview" : "imported";
            log(`import_memory: ${mode} from ${safePath} (${result.inserted} new, ${result.merged} merged)`);
            const lines = [];
            lines.push(dry_run
                ? `Import preview from ${source_path}:`
                : `Imported from ${source_path}:`);
            lines.push(`  ${result.inserted} entries ${dry_run ? "to insert" : "inserted"}`);
            lines.push(`  ${result.merged} entries ${dry_run ? "to merge" : "merged"} (L1 match)`);
            lines.push(`  ${result.nodesInserted} nodes ${dry_run ? "to insert" : "inserted"}`);
            lines.push(`  ${result.nodesSkipped} nodes skipped (duplicate L2)`);
            lines.push(`  ${result.tagsImported} tags ${dry_run ? "to import" : "imported"}`);
            if (result.remapped) {
                lines.push(`  ID remapping ${dry_run ? "required" : "applied"} (${result.conflicts} conflicts)`);
            }
            // Push imported entries through the optimistic-lock retry loop.
            // Note: import allocates many fresh root IDs at once. Per-ID reservation is
            // skipped here (would require pre-knowing all allocated IDs); the layer-2
            // optimistic-lock check still detects post-hoc collisions and reports them.
            if (storeName === "personal" && !dry_run && (result.inserted > 0 || result.merged > 0)) {
                const retry = syncPushWithRetry(HMEM_PATH);
                if (!retry.resolved)
                    lines.push(`  ⚠ unresolved push conflicts after ${retry.attempts} attempts`);
                else if (retry.attempts > 1)
                    lines.push(`  (resolved push conflict after ${retry.attempts} attempts)`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${safeError(e)}` }],
            isError: true,
        };
    }
});
server.tool("memory_stats", "Shows budget status of your memory: total entries by prefix, nodes, favorites, pinned, most-accessed, oldest entry, stale count (not accessed in 30 days), unique hashtags, and avg nodes per entry.", {
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' (your own memory) or 'company' (shared company store)"),
}, async ({ store: storeName }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            const s = hmemStore.getStats();
            const hmemPath = storeName === "company"
                ? path.join(PROJECT_DIR, "company.hmem")
                : HMEM_PATH;
            const lines = [];
            lines.push(`Memory stats (${storeName}):`);
            lines.push(`  DB: ${hmemPath}`);
            lines.push(`  Total entries: ${s.totalEntries}`);
            const prefixLine = Object.entries(s.byPrefix).map(([p, c]) => `${p}:${c}`).join(", ");
            if (prefixLine)
                lines.push(`  By prefix: ${prefixLine}`);
            lines.push(`  Total nodes: ${s.totalNodes}  (avg ${s.avgDepth} nodes/entry)`);
            lines.push(`  Favorites [♥]: ${s.favorites}  Pinned [P]: ${s.pinned}`);
            lines.push(`  Unique hashtags: ${s.uniqueTags}`);
            lines.push(`  Stale (>30d not accessed): ${s.staleCount}`);
            if (s.oldestEntry) {
                lines.push(`  Oldest entry: ${s.oldestEntry.id} (${s.oldestEntry.created_at}) — ${s.oldestEntry.title}`);
            }
            if (s.mostAccessed.length > 0) {
                lines.push(`  Most accessed:`);
                for (const e of s.mostAccessed) {
                    lines.push(`    ${e.id} (${e.access_count}×) — ${e.title}`);
                }
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
server.tool("find_related", "Find entries related to the given entry. " +
    "Uses tag overlap first (intentional connections, marked [T]), " +
    "then FTS5 keyword matching as supplement (marked [~]). " +
    "Use to discover connections or spot potential duplicates.", {
    id: z.string().describe("Root entry ID to find related entries for, e.g. 'P0001'"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to return (default: 5)"),
    store: z.enum(["personal", "company"]).default("personal"),
    hmem_path: z.string().optional().describe("Curator mode: absolute path to an external .hmem file. Overrides `store`."),
}, async ({ id, limit, store: storeName, hmem_path }) => {
    try {
        const { store: hmemStore } = resolveStore(storeName, hmem_path);
        try {
            const results = hmemStore.findRelatedCombined(id, limit);
            if (results.length === 0) {
                return { content: [{ type: "text", text: `No related entries found for ${id}.` }] };
            }
            const lines = [`Related to ${id}:`];
            for (const r of results) {
                const marker = r.matchType === "tags" ? "[T]" : "[~]";
                const tagSuffix = r.tags.length > 0 ? "  " + r.tags.join(" ") : "";
                lines.push(`  ${marker} ${r.id} ${r.created_at}  ${r.title}${tagSuffix}`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
/** Strip body (after \n>) and newlines from titles for compact display */
function cleanTitle(t, max = 0) {
    // Split at body separator — real newline+> or literal \n>
    let s = t.split(/\n>|\\n>/)[0];
    s = s.replace(/[\t\r\n]/g, " ").replace(/  +/g, " ").trim();
    if (max > 0 && s.length > max) {
        s = s.substring(0, max).replace(/[,;:\s]+$/, "") + "…";
    }
    return s;
}
server.tool("load_project", "Load a project and activate it. Returns L2 content + L3 titles — the perfect project briefing. " +
    "Also marks the project as active (deactivates any previously active project in the same prefix).\n\n" +
    "Use this when starting work on a project. It combines read_memory(id, depth=3) + update_memory(active=true) in one call.\n\n" +
    "Example: load_project({ id: 'P0048' })\n" +
    "Returns: Overview, Codebase, Usage, Context, etc. with L3 subcategory titles.", {
    id: z.string().describe("Project entry ID, e.g. 'P0048'"),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' or 'company'"),
}, async ({ id, store: storeName }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            // Validate it's a P-entry
            if (!id.startsWith("P")) {
                return {
                    content: [{ type: "text", text: `ERROR: load_project only works with P-prefix entries. Got: ${id}` }],
                    isError: true,
                };
            }
            // Check if project is obsolete
            const isObsolete = hmemStore.db.prepare("SELECT obsolete FROM memories WHERE id = ? AND obsolete = 1").get(id);
            if (isObsolete) {
                return {
                    content: [{ type: "text", text: `ERROR: ${id} is obsolete. Use the current version instead.` }],
                    isError: true,
                };
            }
            // Activate the project — deactivate all other P-entries in this agent's DB first
            // (multi-agent isolation happens at the .hmem-file level, not within a single file).
            // load_project is the ONLY path that switches the active project; write/update/append
            // on a different P only emit a notice (see below) so a one-off cross-project bug-fix
            // doesn't disrupt the agent's current work.
            hmemStore.setActiveProject(id, currentSessionId());
            activeProjectId = id;
            // Write per-process active-project file keyed by Claude Code PID (= our PPID).
            // The statusline reads this file — no dependency on the shared DB active flag.
            if (typeof process.ppid === "number" && process.ppid > 0) {
                writeActiveProjectFile(process.ppid, id);
            }
            // Auto-reconcile: add missing schema sections to existing entry
            const pSchemaForReconcile = hmemConfig.schemas?.P;
            let reconcileNotice = "";
            if (pSchemaForReconcile && pSchemaForReconcile.sections.length > 0) {
                try {
                    const l2Entries = hmemStore.read({ id, depth: 2 });
                    if (l2Entries.length > 0 && l2Entries[0].children) {
                        const existingTitles = new Set(l2Entries[0].children.map((c) => (c.title || c.content || "").trim().toLowerCase()));
                        const missing = [];
                        for (const sec of pSchemaForReconcile.sections) {
                            if (!existingTitles.has(sec.name.toLowerCase())) {
                                missing.push(sec.name);
                            }
                        }
                        if (missing.length > 0) {
                            for (const name of missing) {
                                hmemStore.appendChildren(id, name);
                            }
                            reconcileNotice = `Reconciled: added sections ${missing.join(", ")}`;
                            log(`load_project: ${id} reconciled — added: ${missing.join(", ")}`);
                        }
                    }
                }
                catch (e) {
                    log(`load_project: reconcile failed for ${id}: ${safeError(e)}`);
                }
            }
            // Cache check: if project was already loaded recently, return short confirmation
            const hiddenIds = sessionCache.getHiddenIds();
            if (hiddenIds.has(id)) {
                log(`load_project: ${id} already cached (< 5 min), returning short response`);
                if (storeName === "personal")
                    syncPush(HMEM_PATH);
                return trackTokens({
                    content: [{ type: "text", text: `✓ Project ${id} already active (loaded recently). Use read_memory(id="${id}") to drill into specific sections.` }],
                });
            }
            // Read with expand + depth 3 (L2 content + L3 titles + L4 hints)
            const entries = hmemStore.read({
                id,
                depth: 3,
                expand: true,
            });
            if (entries.length === 0) {
                return {
                    content: [{ type: "text", text: `ERROR: Project ${id} not found.` }],
                    isError: true,
                };
            }
            // Custom compact rendering for project briefing: L2 content + L3 titles, no dates, compact IDs
            // ID format: each level shows only its own segment (e.g. .7 → .40 → .1 instead of .7.40.1)
            const e = entries[0];
            const syncThreshold = getSyncThreshold();
            const syncTag = syncThreshold && e.updated_at && e.updated_at <= syncThreshold ? " ✓" : "";
            const lines = [];
            const lastSeg = (nodeId) => "." + nodeId.split(".").pop();
            lines.push(`${e.id}${syncTag}  ${e.title}`);
            if (e.level_1 && e.level_1 !== e.title)
                lines.push(`  ${e.level_1}`);
            if (e.children) {
                const pSchema = hmemConfig.schemas?.P;
                if (pSchema) {
                    // ── Schema-driven rendering (schema order) ──
                    const children = e.children.filter(c => !c.irrelevant);
                    // Index children by lowercase title for O(1) lookup
                    const childByTitle = new Map();
                    for (const child of children) {
                        childByTitle.set((child.title || child.content || "").trim().toLowerCase(), child);
                    }
                    const renderedIds = new Set();
                    // Render one child node at the given depth
                    const renderChild = (child, depth) => {
                        if (depth === 0)
                            return;
                        const cId = lastSeg(child.id);
                        const childTitle = (child.title || child.content || "").trim();
                        lines.push(`  ${cId}  ${cleanTitle(childTitle, 60)}`);
                        if (depth === 1) {
                            const childCount = child.children ? child.children.filter((g) => !g.irrelevant).length : 0;
                            if (childCount > 0)
                                lines[lines.length - 1] += ` (${childCount} entries)`;
                            return;
                        }
                        if (child.children && child.children.length > 0) {
                            const grandchildren = child.children.filter((g) => !g.irrelevant);
                            for (const gc of grandchildren) {
                                const gcId = lastSeg(gc.id);
                                if (depth >= 3) {
                                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                                    if (gc.content && gc.content !== gc.title) {
                                        for (const bodyLine of gc.content.split("\n")) {
                                            lines.push(`      ${bodyLine}`);
                                        }
                                    }
                                }
                                else {
                                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                                }
                                if (depth >= 4 && gc.children && gc.children.length > 0) {
                                    for (const l4 of gc.children.filter((l4) => !l4.irrelevant)) {
                                        lines.push(`      ${lastSeg(l4.id)}  ${cleanTitle(l4.title || l4.content || "", 60)}`);
                                    }
                                }
                                else if (gc.child_count && gc.child_count > 0) {
                                    lines.push(`      [+${gc.child_count}]`);
                                }
                            }
                        }
                        else if (child.child_count && child.child_count > 0) {
                            lines.push(`    [+${child.child_count}]`);
                        }
                    };
                    // 1. Schema sections in defined order
                    for (const sec of pSchema.sections) {
                        const child = childByTitle.get(sec.name.toLowerCase());
                        if (!child)
                            continue; // missing — reconcile will add on next load
                        renderedIds.add(child.id);
                        renderChild(child, sec.loadDepth);
                    }
                    // 2. Extra children not in schema — always shown, title only
                    for (const child of children) {
                        if (renderedIds.has(child.id))
                            continue;
                        renderChild(child, 1);
                    }
                }
                else {
                    // ── Legacy rendering (no schema) — exact current code ──
                    const { withBody, withChildren } = hmemConfig.loadProjectExpand;
                    const SKIP_SECTIONS = [];
                    const TAIL_SECTIONS = [];
                    const TAIL_COUNT = 3;
                    const HIDE_CHILDREN_SECTIONS = [7, 9, 2];
                    const FILTER_DONE_SECTIONS = [8];
                    for (const child of e.children.filter(c => !c.irrelevant)) {
                        if (SKIP_SECTIONS.includes(child.seq))
                            continue;
                        const cId = lastSeg(child.id);
                        const expandBody = withBody.includes(child.seq);
                        const expandChildTitles = withChildren.includes(child.seq);
                        const hideChildren = HIDE_CHILDREN_SECTIONS.includes(child.seq);
                        lines.push(`  ${cId}  ${cleanTitle(child.title || child.content, 60)}`);
                        if (hideChildren) {
                            const childCount = child.children ? child.children.filter((g) => !g.irrelevant).length : 0;
                            if (childCount > 0) {
                                lines[lines.length - 1] += ` (${childCount} entries)`;
                            }
                            else if (child.content && child.content !== child.title) {
                                lines.push(`    ${child.content}`);
                            }
                            else {
                                lines.pop();
                            }
                            continue;
                        }
                        if (child.children && child.children.length > 0) {
                            let grandchildren = child.children.filter((g) => !g.irrelevant);
                            if (FILTER_DONE_SECTIONS.includes(child.seq)) {
                                grandchildren = grandchildren.filter((g) => {
                                    const t = (g.title || g.content || "").trim();
                                    return !t.startsWith("✓") && !t.startsWith("DONE");
                                });
                            }
                            if (TAIL_SECTIONS.includes(child.seq) && grandchildren.length > TAIL_COUNT) {
                                grandchildren = grandchildren.slice(-TAIL_COUNT);
                            }
                            for (const gc of grandchildren) {
                                const gcId = lastSeg(gc.id);
                                if (expandBody) {
                                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                                    if (gc.content && gc.content !== gc.title) {
                                        for (const bodyLine of gc.content.split("\n")) {
                                            lines.push(`      ${bodyLine}`);
                                        }
                                    }
                                }
                                else {
                                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                                }
                                if (gc.children && gc.children.length > 0) {
                                    const visibleL4 = gc.children.filter((l4) => !l4.irrelevant);
                                    for (const l4 of visibleL4) {
                                        lines.push(`      ${lastSeg(l4.id)}  ${cleanTitle(l4.title || l4.content || "", 60)}`);
                                    }
                                }
                                else if (gc.child_count && gc.child_count > 0) {
                                    lines.push(`      [+${gc.child_count}]`);
                                }
                            }
                        }
                        else if (child.child_count && child.child_count > 0) {
                            lines.push(`    [+${child.child_count}]`);
                        }
                    }
                }
            }
            // Links
            if (e.linkedEntries && e.linkedEntries.length > 0) {
                lines.push("  Links:");
                for (const le of e.linkedEntries) {
                    lines.push(`    ${le.id}  ${cleanTitle(le.title, 70)}`);
                }
            }
            // Context injection: find related E/L entries by weighted tag scoring
            try {
                const ctx = hmemStore.findContext(id, 4, 10);
                const relatedEL = ctx.tagRelated.filter(r => (r.entry.prefix === "E" || r.entry.prefix === "L") && !r.entry.obsolete && !r.entry.irrelevant);
                if (relatedEL.length > 0) {
                    lines.push("  Related errors & lessons:");
                    for (const r of relatedEL) {
                        lines.push(`    ${r.entry.id} [⚡]  ${cleanTitle(r.entry.title, 70)}`);
                    }
                }
            }
            catch { /* findContext may fail on empty/new entries */ }
            // Inject recent O-entries linked to THIS project
            // Purpose: seamless continuation of the previous session's conversation
            if (hmemConfig.recentOEntries > 0) {
                const projectSeq = parseInt(id.replace(/\D/g, ""), 10);
                const projectOId = `O${String(projectSeq).padStart(4, "0")}`;
                const oExists = hmemStore.readEntry(projectOId);
                if (oExists) {
                    const { text: oText, ids } = formatRecentOEntries(hmemStore, 1, 5, id, true);
                    if (oText.trim()) {
                        lines.push("  --- Recent Session Context ---");
                        lines.push("  " + oText.replace(/\n/g, "\n  "));
                        sessionCache.registerDelivered(ids);
                    }
                }
            }
            // Inject global context — configurable via globalLoad, fallback: R (depth 2) + C#universal (depth 2)
            {
                const globalItems = hmemConfig.globalLoad ?? [
                    { prefix: "R", loadDepth: 2 },
                    { prefix: "C", loadDepth: 2, tagFilter: "#universal" },
                ];
                for (const item of globalItems) {
                    try {
                        const readDepth = item.loadDepth >= 3 ? 2 : 1;
                        let entries = hmemStore.read({ prefix: item.prefix, depth: readDepth })
                            .filter((e) => !e.obsolete && !e.irrelevant);
                        if (item.tagFilter) {
                            const tf = item.tagFilter;
                            entries = entries.filter((e) => e.tags?.includes(tf));
                        }
                        if (entries.length === 0)
                            continue;
                        const prefixName = hmemConfig.prefixes[item.prefix] || item.prefix;
                        lines.push(`  ${prefixName}:`);
                        for (const entry of entries) {
                            lines.push(`    ${entry.id}  ${cleanTitle(entry.title)}`);
                            if (item.loadDepth >= 2 && entry.level_1 && entry.level_1 !== entry.title) {
                                lines.push(`      ${entry.level_1}`);
                            }
                            if (item.loadDepth >= 3 && entry.children) {
                                for (const child of entry.children.filter((c) => !c.irrelevant)) {
                                    lines.push(`      ${lastSeg(child.id)}  ${cleanTitle(child.title || child.content || "")}`);
                                }
                            }
                        }
                    }
                    catch { /* global context entries are always optional */ }
                }
            }
            if (reconcileNotice) {
                lines.push("");
                lines.push(`  ⚡ ${reconcileNotice}`);
            }
            const irrelevantTip = `Tip: update_memory(id, { irrelevant: true }) to hide noisy entries from future loads.`;
            const output = lines.join("\n");
            const outputTokens = Math.round(output.length / 4);
            const totalStats = hmemStore.stats();
            const totalTokens = Math.round(totalStats.totalChars / 4);
            const tokenInfo = ` | ${(outputTokens / 1000).toFixed(1)}k/${(totalTokens / 1000).toFixed(0)}k tokens`;
            log(`load_project: ${id} activated and loaded (depth=3)`);
            // Register in session cache to prevent redundant full loads
            sessionCache.registerDelivered([id]);
            // Sync if enabled
            if (storeName === "personal")
                syncPush(HMEM_PATH);
            return trackTokens({
                content: [{
                        type: "text",
                        text: `✓ Project ${id} activated.${tokenInfo}\n${irrelevantTip}\n\n${output}\n\n${irrelevantTip}`,
                    }],
            });
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
server.tool("create_project", "Create a new project with the standard R0009 schema. Automatically creates:\n" +
    "1. P-entry with all 10 L2 sections (Overview, Codebase, Usage, Context, Deployment, Bugs, Protocol, Roadmap, Ideas, Next Steps)\n" +
    "2. Matching O-entry for session logging (O00XX ↔ P00XX)\n\n" +
    "Example: create_project({ name: 'Carlo Auftrag', tech: 'Python/SAP', description: 'SAP Freigabe-Automatisierung' })", {
    name: z.string().describe("Project name (short, for L1 title)"),
    tech: z.string().describe("Tech stack, e.g. 'TS/React', 'Python/Flask', 'AHK v2'"),
    description: z.string().describe("One-line project description"),
    status: z.enum(["Active", "Paused", "Planning", "Mature", "Archived"]).default("Active"),
    repo: z.string().optional().describe("Repo path or URL, e.g. '~/projects/foo' or 'GH: User/repo'"),
    goal: z.string().optional().describe("Main project goal (1-2 sentences)"),
    audience: z.string().optional().describe("Target audience / who uses it"),
    deployment: z.string().optional().describe("How it's deployed (npm, exe, server, manual)"),
    tags: jsonArrayString(z.array(z.string()).optional()).describe("Additional tags beyond #project (auto-added)"),
    links: jsonArrayString(z.array(z.string()).optional()).describe("Related entry IDs, e.g. ['T0044', 'L0095']"),
    store: z.enum(["personal", "company"]).default("personal"),
}, async ({ name, tech, description, status, repo, goal, audience, deployment, tags, links, store: storeName }) => {
    try {
        const hmemStore = new HmemStore(HMEM_PATH, loadHmemConfig(path.dirname(HMEM_PATH)));
        try {
            // Build the P-entry content with R0009 schema
            const titleLine = `${name} | ${status} | ${tech} | ${description}`;
            const bodyLine = goal ? `> ${goal}` : `> ${description}`;
            const sections = [titleLine, bodyLine];
            const schema = hmemConfig.schemas?.P;
            if (schema) {
                // Schema-driven creation
                for (const sec of schema.sections) {
                    sections.push(`\t${sec.name}`);
                    if (sec.defaultChildren) {
                        for (const child of sec.defaultChildren) {
                            // Inject known values for standard Overview children
                            if (sec.name === "Overview" && child === "Current state") {
                                sections.push(`\t\tCurrent state: ${status}, ${tech}`);
                            }
                            else if (sec.name === "Overview" && child === "Goals" && goal) {
                                sections.push(`\t\tGoals: ${goal}`);
                            }
                            else if (sec.name === "Overview" && child === "Environment" && repo) {
                                sections.push(`\t\tEnvironment: ${repo}`);
                            }
                            else if (sec.name === "Context" && child === "Target audience" && audience) {
                                sections.push(`\t\tTarget audience: ${audience}`);
                            }
                            else {
                                sections.push(`\t\t${child}`);
                            }
                        }
                    }
                    // Backward compat: inject deployment into Deployment section if no defaultChildren
                    if (sec.name === "Deployment" && deployment && !sec.defaultChildren) {
                        sections.push(`\t\t${deployment}`);
                    }
                }
            }
            else {
                // Fallback: hardcoded R0009 schema (backward compat)
                sections.push(`\tOverview`);
                sections.push(`\t\tCurrent state: ${status}, ${tech}`);
                if (goal)
                    sections.push(`\t\tGoals: ${goal}`);
                if (repo)
                    sections.push(`\t\tEnvironment: ${repo}`);
                sections.push(`\tCodebase`);
                sections.push(`\tUsage`);
                sections.push(`\tContext`);
                if (audience)
                    sections.push(`\t\tTarget audience: ${audience}`);
                sections.push(`\tDeployment`);
                if (deployment)
                    sections.push(`\t\t${deployment}`);
                sections.push(`\tBugs`);
                sections.push(`\tProtocol`);
                sections.push(`\tRoadmap`);
                sections.push(`\tIdeas`);
                sections.push(`\tNext Steps`);
            }
            const content = sections.join("\n");
            // Merge tags
            const allTags = ["#project", ...(tags ?? [])];
            // Pull + reserve P-ID before write (multi-agent collision prevention)
            if (storeName === "personal") {
                syncPullThenPush(HMEM_PATH);
                reserveNextId(HMEM_PATH, "P", hmemStore);
            }
            // Write P-entry (signature: prefix, content, links, minRole, favorite, tags)
            const result = hmemStore.write("P", content, links ?? [], undefined, false, allTags);
            const pId = result.id;
            const pSeq = parseInt(pId.replace(/\D/g, ""), 10);
            // Create matching O-entry (only if schema says so, or no schema = backward compat)
            const shouldCreateO = schema ? (schema.createLinkedO === true) : true;
            const oId = `O${String(pSeq).padStart(4, "0")}`;
            if (shouldCreateO) {
                const existingO = hmemStore.readEntry(oId);
                if (!existingO) {
                    // Reserve the O-prefix slot too — even though we may rename it afterwards,
                    // the initial write needs collision protection
                    if (storeName === "personal")
                        reserveNextId(HMEM_PATH, "O", hmemStore);
                    hmemStore.write("O", `${name} — Session Log`, [pId], undefined, false, ["#session-log"]);
                    // The O-entry gets auto-assigned the next seq, which may not match pSeq.
                    // We need to ensure it has the right ID. Check if it matches:
                    const lastO = hmemStore.read({ prefix: "O", depth: 1 })
                        .sort((a, b) => b.seq - a.seq)[0];
                    if (lastO && lastO.id !== oId) {
                        // Rename to match P-entry seq
                        hmemStore.renameId(lastO.id, oId);
                    }
                }
            }
            // Note: write() with prefix "P" auto-activates the project (deactivates others)
            // Sync with retry loop to catch any version conflicts from the rename
            if (storeName === "personal")
                syncPushWithRetry(HMEM_PATH);
            log(`create_project: ${pId} + ${oId} created and activated`);
            const sectionNames = schema
                ? schema.sections.map(s => s.name).join(", ")
                : "Overview, Codebase, Usage, Context, Deployment, Bugs, Protocol, Roadmap, Ideas, Next Steps";
            return trackTokens({
                content: [{
                        type: "text",
                        text: `✓ Project ${pId} created and activated.\n` +
                            (shouldCreateO ? `  O-entry: ${oId} (session logging)\n` : "") +
                            `  Sections: ${sectionNames}\n\n` +
                            `Next: Use load_project(id="${pId}") to see the full briefing.\n` +
                            `Tip: Use append_memory(id="${pId}.2", content="...") to fill in Codebase details.`,
                    }],
            });
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
server.tool("memory_health", "Audit report for your memory: broken links (links pointing to deleted entries), " +
    "orphaned entries (no sub-nodes), stale favorites/pinned (not accessed in 60 days), " +
    "broken obsolete chains ([✓ID] pointing to non-existent entries), " +
    "and tag orphans (tags with no matching entry). " +
    "Run before/after a curation session.", {
    store: z.enum(["personal", "company"]).default("personal"),
    hmem_path: z.string().optional().describe("Curator mode: absolute path to an external .hmem file. Overrides `store`."),
}, async ({ store: storeName, hmem_path }) => {
    try {
        const { store: hmemStore, label: storeLabelResolved } = resolveStore(storeName, hmem_path);
        try {
            const h = hmemStore.healthCheck();
            const lines = [`Memory health report (${storeLabelResolved}):`];
            const ok = (label) => lines.push(`  ✓ ${label}`);
            const warn = (label) => lines.push(`  ⚠ ${label}`);
            if (h.brokenLinks.length === 0) {
                ok("No broken links");
            }
            else {
                warn(`${h.brokenLinks.length} entries with broken links:`);
                for (const e of h.brokenLinks) {
                    lines.push(`    ${e.id} — ${e.title} → broken: ${e.brokenIds.join(", ")}`);
                }
            }
            if (h.orphanedEntries.length === 0) {
                ok("No orphaned entries (all have sub-nodes)");
            }
            else {
                warn(`${h.orphanedEntries.length} entries with no sub-nodes:`);
                for (const e of h.orphanedEntries) {
                    lines.push(`    ${e.id} (${e.created_at}) — ${e.title}`);
                }
            }
            if (h.staleFavorites.length === 0) {
                ok("No stale favorites/pinned");
            }
            else {
                warn(`${h.staleFavorites.length} stale favorites/pinned (>60d not accessed):`);
                for (const e of h.staleFavorites) {
                    lines.push(`    ${e.id} — ${e.title} [last: ${e.lastAccessed ?? "never"}]`);
                }
            }
            if (h.brokenObsoleteChains.length === 0) {
                ok("No broken obsolete chains");
            }
            else {
                warn(`${h.brokenObsoleteChains.length} broken [✓ID] references:`);
                for (const e of h.brokenObsoleteChains) {
                    lines.push(`    ${e.id} — ${e.title} → [✓${e.badRef}] not found`);
                }
            }
            if (h.tagOrphans === 0) {
                ok("No tag orphans");
            }
            else {
                warn(`${h.tagOrphans} tag rows pointing to deleted entries`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
server.tool("tag_bulk", "Apply tag changes (add and/or remove) to all entries matching a filter. " +
    "Filter by prefix, full-text search, or existing tag. " +
    "Returns the number of entries modified. " +
    "Also use tag_rename to rename a tag across all entries.", {
    filter: z.object({
        prefix: z.string().optional().describe("Only entries with this prefix, e.g. 'L'"),
        search: z.string().optional().describe("FTS5 search term — only matching entries"),
        tag: z.string().optional().describe("Only entries that already have this tag"),
    }).describe("At least one filter field required"),
    add_tags: z.array(z.string()).optional().describe("Tags to add, e.g. ['#hmem', '#bugfix']"),
    remove_tags: z.array(z.string()).optional().describe("Tags to remove"),
    store: z.enum(["personal", "company"]).default("personal"),
}, async ({ filter, add_tags, remove_tags, store: storeName }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            const count = hmemStore.tagBulk(filter, add_tags, remove_tags);
            const added = add_tags?.length ? `+[${add_tags.join(", ")}]` : "";
            const removed = remove_tags?.length ? `-[${remove_tags.join(", ")}]` : "";
            return {
                content: [{
                        type: "text",
                        text: `tag_bulk: modified ${count} entries. ${added} ${removed}`.trim(),
                    }],
            };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
server.tool("tag_rename", "Rename a hashtag across all entries and nodes. " +
    "Example: tag_rename(old_tag='#sqlite', new_tag='#db') renames every occurrence.", {
    old_tag: z.string().describe("Existing tag to rename, e.g. '#old-tag'"),
    new_tag: z.string().describe("New tag name, e.g. '#new-tag'"),
    store: z.enum(["personal", "company"]).default("personal"),
}, async ({ old_tag, new_tag, store: storeName }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            const count = hmemStore.tagRename(old_tag, new_tag);
            return {
                content: [{
                        type: "text",
                        text: count > 0
                            ? `Renamed ${old_tag} → ${new_tag} on ${count} entries/nodes.`
                            : `Tag ${old_tag} not found — nothing renamed.`,
                    }],
            };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
server.tool("move_memory", "Move a sub-node (and its entire subtree) to a different parent, updating all ID references. " +
    "source_id must be a sub-node (e.g. 'P0029.15'), not a root entry. " +
    "target_parent_id is the new parent: a root entry (e.g. 'L0074') or a sub-node (e.g. 'P0029.20'). " +
    "Use during curation to reorganize entries into the correct hierarchy.", {
    source_id: z.string().describe("Sub-node to move, e.g. 'P0029.15' (must not be a root entry ID)"),
    target_parent_id: z.string().describe("New parent: root 'L0074' or sub-node 'P0029.20'"),
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
}, async ({ source_id, target_parent_id, store }) => {
    try {
        const hmemStore = store === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            const result = hmemStore.moveNode(source_id, target_parent_id);
            const idLines = Object.entries(result.idMap)
                .map(([old, nw]) => `  ${old} → ${nw}`)
                .join("\n");
            return {
                content: [{
                        type: "text",
                        text: `Moved ${result.moved} node(s) to ${target_parent_id}.\nNew ID: ${result.newId}\n\nID mapping:\n${idLines}`,
                    }],
            };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
server.tool("rename_id", "Atomically rename an entry ID and update ALL references across the database. " +
    "Renames: root entry, all child nodes, tags, FTS index, links in other entries, obsolete markers. " +
    "Use to resolve ID conflicts after sync-push detects a collision. " +
    "Example: rename_id({ old_id: 'P0048', new_id: 'P0052' })", {
    old_id: z.string().describe("Current entry ID to rename, e.g. 'P0048'"),
    new_id: z.string().describe("New entry ID, e.g. 'P0052' — must have same prefix and not exist yet"),
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
}, async ({ old_id, new_id, store }) => {
    try {
        const hmemStore = store === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            const result = hmemStore.renameId(old_id, new_id);
            if (!result.ok) {
                return { content: [{ type: "text", text: `ERROR: ${result.error}` }], isError: true };
            }
            log(`rename_id: ${old_id} → ${new_id} (${result.affected} rows affected)`);
            return {
                content: [{
                        type: "text",
                        text: `Renamed ${old_id} → ${new_id} (${result.affected} rows affected).\nAll child nodes, tags, links, and FTS index updated.`,
                    }],
            };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
// ---- Tool: list_projects ----
server.tool("list_projects", "List all projects (P-entries) with their IDs and titles. Minimal output for checkpoint agents.", {
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
}, async ({ store }) => {
    try {
        const hmemStore = store === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            const projects = hmemStore.listProjects();
            const text = projects.map(p => `${p.id} ${p.title}`).join("\n");
            return { content: [{ type: "text", text: text || "No projects found." }] };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
// ---- Tool: move_nodes ----
server.tool("move_nodes", "Move session (L2), batch (L3), or exchange (L4) nodes between O-entries. Handles ID rewriting, tag migration, and cleanup of empty parents.", {
    node_ids: z.array(z.string()).describe("IDs of nodes to move (L2, L3, or L4)"),
    target_o_id: z.string().describe("Target O-entry ID (e.g. O0048)"),
    store: z.enum(["personal", "company"]).default("personal").describe("Which store to operate on"),
}, async ({ node_ids, target_o_id, store }) => {
    try {
        const hmemStore = store === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            if (store === "personal")
                syncPullThenPush(HMEM_PATH);
            const result = hmemStore.moveNodes(node_ids, target_o_id);
            let text = `Moved ${result.moved} node(s) to ${target_o_id}.`;
            if (result.errors.length > 0) {
                text += `\nErrors:\n${result.errors.join("\n")}`;
            }
            if (store === "personal") {
                const retry = syncPushWithRetry(HMEM_PATH);
                if (!retry.resolved)
                    text += `\n⚠ unresolved push conflicts after ${retry.attempts} attempts`;
                else if (retry.attempts > 1)
                    text += `\n(resolved push conflict after ${retry.attempts} attempts)`;
            }
            return { content: [{ type: "text", text }] };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
    }
});
// ---- Output Formatting ----
/**
 * Format bulk-read output grouped by prefix with header entries.
 * Non-curator: strips [♥], [★] markers, shortens [OBSOLETE] to [!].
 */
/**
 * Format compact title listing — ID + date + title, grouped by prefix.
 * V2 selection applies. Favorites/top-accessed show L2 children titles.
 * Non-expanded entries show (N) child count indicator.
 */
/** Format tags as a compact suffix: "  #hmem #curation" or "" if no tags. Only shown in curator mode. */
function formatTagSuffix(tags, curator = false) {
    if (!curator || !tags || tags.length === 0)
        return "";
    return "  " + [...new Set(tags)].join(" ");
}
function formatTitlesOnly(entries, config, curator = false) {
    const CHILD_TITLE_LEN = 50;
    const lines = [];
    const byPrefix = new Map();
    for (const e of entries) {
        const arr = byPrefix.get(e.prefix);
        if (arr)
            arr.push(e);
        else
            byPrefix.set(e.prefix, [e]);
    }
    for (const [prefix, prefixEntries] of byPrefix) {
        const desc = config.prefixDescriptions[prefix] ?? config.prefixes[prefix] ?? prefix;
        lines.push(`## ${desc} (${prefixEntries.length} total)\n`);
        for (const e of prefixEntries) {
            const fav = e.favorite ? " [♥]" : "";
            const act = e.active ? " [*]" : "";
            const obs = e.obsolete ? " [!]" : "";
            const irr = e.irrelevant ? " [-]" : "";
            const syncThreshold = getSyncThreshold();
            const sync = syncThreshold && e.updated_at && e.updated_at <= syncThreshold ? " ✓" : "";
            if (e.expanded && e.children && e.children.length > 0) {
                const visibleChildren = e.children.filter(c => !c.irrelevant);
                const hiddenIrr = e.children.length - visibleChildren.length;
                const rootId = e.id;
                lines.push(`${e.id}${fav}${act}${obs}${sync}  ${e.title}${formatTagSuffix(e.tags, curator)}`);
                for (const child of visibleChildren) {
                    const short = child.title || (child.content.length > CHILD_TITLE_LEN
                        ? child.content.substring(0, CHILD_TITLE_LEN)
                        : child.content);
                    const grandchildren = (child.child_count ?? 0) > 0 ? ` (${child.child_count})` : "";
                    const cfav = child.favorite ? " [♥]" : "";
                    const compactChildId = child.id.replace(rootId, "");
                    lines.push(`  ${compactChildId}${cfav}  ${short}${grandchildren}`);
                }
                if (e.hiddenChildrenCount && e.hiddenChildrenCount > 0) {
                    lines.push(`  [+${e.hiddenChildrenCount} more]`);
                }
                if (hiddenIrr > 0) {
                    lines.push(`  (+${hiddenIrr} irrelevant hidden)`);
                }
            }
            else {
                // Non-expanded: compact line with child count
                const childHint = (e.hiddenChildrenCount ?? 0) > 0 ? ` (${e.hiddenChildrenCount})` : "";
                lines.push(`${e.id}${fav}${act}${obs}${sync}  ${e.title}${formatTagSuffix(e.tags, curator)}${childHint}`);
            }
        }
        lines.push("");
    }
    return lines.join("\n");
}
function formatGroupedOutput(store, entries, curator, config) {
    const lines = [];
    const headers = store.getHeaders();
    const headerMap = new Map();
    for (const h of headers)
        headerMap.set(h.prefix, h);
    // Get total counts per prefix from DB (includes hidden entries)
    const stats = store.stats();
    const nonObsolete = entries.filter(e => !e.obsolete);
    const obsolete = entries.filter(e => e.obsolete);
    const byPrefix = new Map();
    for (const e of nonObsolete) {
        const arr = byPrefix.get(e.prefix);
        if (arr)
            arr.push(e);
        else
            byPrefix.set(e.prefix, [e]);
    }
    for (const [prefix, prefixEntries] of byPrefix) {
        const header = headerMap.get(prefix);
        const description = header?.level_1 ?? config.prefixDescriptions[prefix] ?? config.prefixes[prefix] ?? prefix;
        const totalCount = stats.byPrefix[prefix] ?? prefixEntries.length;
        lines.push(`## ${description} (${prefixEntries.length}/${totalCount} shown)\n`);
        for (const e of prefixEntries) {
            renderEntryFormatted(lines, e, curator);
        }
    }
    if (obsolete.length > 0) {
        lines.push("");
        for (const e of obsolete) {
            renderEntryFormatted(lines, e, curator);
        }
    }
    return lines.join("\n");
}
function formatFlatOutput(entries, curator, expand = false) {
    const lines = [];
    // Obsolete chain resolution note
    if (entries.length > 0 && entries[0].obsoleteChain && entries[0].obsoleteChain.length > 1) {
        const chain = entries[0].obsoleteChain;
        if (entries.length === 1) {
            const chainStr = chain.slice(0, -1).map(id => `${id} [!]`).join(" → ") + ` → ${chain[chain.length - 1]} ✓`;
            lines.push(`[Resolved: ${chainStr}]\n`);
        }
        else {
            lines.push(`[Chain: ${chain.join(" → ")}]\n`);
        }
    }
    for (const e of entries) {
        renderEntryFormatted(lines, e, curator, expand);
    }
    return lines.join("\n");
}
/** Favorite marker for child nodes. */
function nodeMarkers(node) {
    const fav = node.favorite ? " [♥]" : "";
    const irr = node.irrelevant ? " [-]" : "";
    return `${fav}${irr}`;
}
/** Get the minimum lastPushAt across all sync servers — entries updated before this are fully synced. */
function getSyncThreshold() {
    const servers = getSyncServers(hmemConfig);
    if (servers.length === 0)
        return null;
    const pushTimes = servers.map(s => s.lastPushAt).filter((t) => !!t);
    if (pushTimes.length === 0)
        return null;
    // Min = earliest push → everything before this is on ALL servers
    return pushTimes.reduce((a, b) => a < b ? a : b);
}
function renderEntryFormatted(lines, e, curator, expand = false) {
    // O-prefix: title-only rendering — never expand children (raw conversation data, too large)
    // Use read_memory(id="O0042") to drill in explicitly.
    if (e.prefix === "O" && !expand) {
        const mmdd = e.created_at.substring(5, 10);
        const sessionCount = e.children?.length ?? 0;
        lines.push(`${e.id} ${mmdd}  ${e.title}${sessionCount > 0 ? ` (${sessionCount} sessions)` : ""}`);
        lines.push("");
        return;
    }
    const isNode = e.id.includes(".");
    const hasDetail = !!(e.children?.length || e.linkedEntries?.length);
    const tagStr = formatTagSuffix(e.tags, curator);
    // Headline: use title for navigation, show full content below when drilling in
    if (isNode) {
        if (curator) {
            lines.push(`[${e.id}] ${e.title}${tagStr}`);
        }
        else {
            lines.push(`${e.id}  ${e.title}${tagStr}`);
        }
        // Node drilldown: show body below title
        if (e.level_1 && e.level_1 !== e.title) {
            for (const bodyLine of e.level_1.split("\n")) {
                lines.push(`  ${bodyLine}`);
            }
        }
    }
    else {
        if (curator) {
            const promotedTag = e.promoted === "favorite" ? " [♥]" : e.promoted === "access" ? " [★]" : e.promoted === "subnode" ? " [≡]" : e.promoted === "task" ? " [⚡]" : "";
            const activeTag = e.active ? " [*]" : "";
            const pinnedTag = e.pinned ? " [P]" : "";
            const obsoleteTag = e.obsolete ? " [⚠ OBSOLETE]" : "";
            const irrelevantTag = e.irrelevant ? " [- IRRELEVANT]" : "";
            const date = e.created_at.substring(0, 10);
            const accessed = e.access_count > 0 ? ` (${e.access_count}x accessed)` : "";
            lines.push(`[${e.id}] ${date}${promotedTag}${activeTag}${pinnedTag}${obsoleteTag}${irrelevantTag}${accessed}`);
            lines.push(`  ${e.title}${tagStr}`);
        }
        else {
            const promotedTag = e.promoted === "favorite" ? " [♥]" : e.promoted === "access" ? " [★]" : e.promoted === "subnode" ? " [≡]" : e.promoted === "task" ? " [⚡]" : "";
            const activeTag = e.active ? " [*]" : "";
            const pinnedTag = e.pinned ? " [P]" : "";
            const obsoleteTag = e.obsolete ? " [!]" : "";
            const irrelevantTag = e.irrelevant ? " [-]" : "";
            const syncThreshold = getSyncThreshold();
            const syncTag = syncThreshold && e.updated_at && e.updated_at <= syncThreshold ? " ✓" : "";
            lines.push(`${e.id}${promotedTag}${activeTag}${pinnedTag}${obsoleteTag}${irrelevantTag}${syncTag}  ${e.title}${tagStr}`);
        }
        // Show body below title when entry is drilled into
        if (e.level_1 && e.level_1 !== e.title) {
            for (const bodyLine of e.level_1.split("\n")) {
                lines.push(`  ${bodyLine}`);
            }
        }
    }
    // Children — filter out irrelevant nodes
    // Root ID for compact child rendering (e.g. P0048.1 → .1)
    const rootId = e.id.includes(".") ? e.id.split(".")[0] : e.id;
    if (e.children && e.children.length > 0) {
        const visibleChildren = e.children.filter(c => !c.irrelevant);
        const hiddenIrrelevant = e.children.length - visibleChildren.length;
        if (expand || e.pinned) {
            // Expand mode or pinned: full L2 content + recursive children
            renderChildrenExpanded(lines, visibleChildren, curator, rootId);
        }
        else if (e.expanded && !expand) {
            renderChildrenFormatted(lines, visibleChildren, curator, rootId);
            if (e.hiddenChildrenCount && e.hiddenChildrenCount > 0) {
                lines.push(`  [+${e.hiddenChildrenCount} more]`);
            }
        }
        else if (e.hiddenChildrenCount !== undefined) {
            // Non-expanded bulk read: show only the latest visible child title
            const child = visibleChildren[0];
            if (child) {
                const fav = nodeMarkers(child);
                const compactChildId = child.id.replace(rootId, "");
                const hint = (child.child_count ?? 0) > 0
                    ? `  [+${child.child_count}]`
                    : "";
                if (curator) {
                    lines.push(`  [${child.id}]${fav} ${child.title}${hint}`);
                }
                else {
                    lines.push(`  ${compactChildId}${fav}  ${child.title}${hint}`);
                }
            }
            if (e.hiddenChildrenCount > 0) {
                lines.push(`  [+${e.hiddenChildrenCount} more]`);
            }
        }
        else {
            // ID-based read: show all direct children as titles
            renderChildrenFormatted(lines, visibleChildren, curator, rootId);
        }
        if (hiddenIrrelevant > 0) {
            lines.push(`  (+${hiddenIrrelevant} irrelevant hidden)`);
        }
    }
    // Links
    if (e.links && e.links.length > 0) {
        const parts = [`Links: ${e.links.join(", ")}`];
        const hiddenParts = [];
        if (e.hiddenObsoleteLinks && e.hiddenObsoleteLinks > 0)
            hiddenParts.push(`${e.hiddenObsoleteLinks} obsolete`);
        if (e.hiddenIrrelevantLinks && e.hiddenIrrelevantLinks > 0)
            hiddenParts.push(`${e.hiddenIrrelevantLinks} irrelevant`);
        if (hiddenParts.length > 0)
            parts.push(`(+${hiddenParts.join(", ")} hidden)`);
        lines.push(`  ${parts.join(" ")}`);
    }
    // Auto-resolved linked entries
    if (e.linkedEntries && e.linkedEntries.length > 0) {
        lines.push(`  --- Linked entries ---`);
        for (const linked of e.linkedEntries) {
            const isLinkedNode = linked.id.includes(".");
            if (isLinkedNode) {
                lines.push(`  [${linked.id}] ${linked.title}`);
            }
            else {
                const ldate = linked.created_at.substring(0, 10);
                lines.push(`  [${linked.id}] ${ldate}`);
                lines.push(`    ${linked.title}`);
            }
            // Linked children as titles
            if (linked.children && linked.children.length > 0) {
                for (const lchild of linked.children) {
                    const hint = (lchild.child_count ?? 0) > 0
                        ? ` (${lchild.child_count} ${lchild.child_count === 1 ? "child" : "children"} — use id="${lchild.id}" to expand)`
                        : "";
                    lines.push(`    [${lchild.id}]${nodeMarkers(lchild)} ${lchild.title}${hint}`);
                }
            }
        }
    }
    // Related entries (shared tags)
    if (e.relatedEntries && e.relatedEntries.length > 0) {
        lines.push(`  --- Related (shared tags) ---`);
        for (const rel of e.relatedEntries) {
            const rmmdd = rel.created_at.substring(5, 10);
            lines.push(`  ${rel.id} ${rmmdd}  ${rel.title}${formatTagSuffix(rel.tags, curator)}`);
        }
    }
    lines.push("");
}
/**
 * Render a list of child nodes — shows titles for navigation.
 * Use read_memory(id=child.id) to see full content.
 */
function renderChildrenFormatted(lines, children, curator, rootId) {
    for (const child of children) {
        const indent = "  ".repeat(child.depth - 1);
        const fav = nodeMarkers(child);
        const ctags = formatTagSuffix(child.tags, curator);
        const compactId = rootId ? child.id.replace(rootId, "") : child.id;
        const hint = (child.child_count ?? 0) > 0
            ? `  [+${child.child_count}]`
            : "";
        if (curator) {
            lines.push(`${indent}[${child.id}]${fav} ${child.title}${ctags}${hint}`);
        }
        else {
            lines.push(`${indent}${compactId}${fav}  ${child.title}${ctags}${hint}`);
        }
    }
}
/**
 * Render children with full content (expand mode).
 * Shows complete node text and recurses into grandchildren.
 * At the depth boundary (children loaded but THEIR children are not),
 * renders as titles instead of full content.
 */
function renderChildrenExpanded(lines, children, curator, rootId) {
    for (const child of children) {
        const indent = "  ".repeat(child.depth - 1);
        const bodyIndent = indent + "  ";
        const fav = nodeMarkers(child);
        const compactId = rootId ? child.id.replace(rootId, "") : child.id;
        const visibleGrandchildren = child.children?.filter(c => !c.irrelevant);
        const hasLoadedChildren = visibleGrandchildren && visibleGrandchildren.length > 0;
        const isBoundary = !hasLoadedChildren && (child.child_count ?? 0) > 0;
        const hasBody = child.content && child.content !== child.title;
        if (hasLoadedChildren) {
            // Inner node: title + body + recurse
            if (curator) {
                lines.push(`${indent}[${child.id}]${fav} ${child.title}`);
            }
            else {
                lines.push(`${indent}${compactId}${fav}  ${child.title}`);
            }
            if (hasBody) {
                for (const bodyLine of child.content.split("\n")) {
                    lines.push(`${bodyIndent}${bodyLine}`);
                }
            }
            renderChildrenExpanded(lines, visibleGrandchildren, curator, rootId);
        }
        else if (isBoundary) {
            // Boundary: title only + child count hint
            const hint = `  [+${child.child_count}]`;
            if (curator) {
                lines.push(`${indent}[${child.id}]${fav} ${child.title}${hint}`);
            }
            else {
                lines.push(`${indent}${compactId}${fav}  ${child.title}${hint}`);
            }
        }
        else {
            // Leaf node: title + body
            if (curator) {
                lines.push(`${indent}[${child.id}]${fav} ${child.title}`);
            }
            else {
                lines.push(`${indent}${compactId}${fav}  ${child.title}`);
            }
            if (hasBody) {
                for (const bodyLine of child.content.split("\n")) {
                    lines.push(`${bodyIndent}${bodyLine}`);
                }
            }
        }
    }
}
// ---- Update check ----
const CURRENT_VERSION = "2.5.3";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const updateCheckFile = path.join(path.dirname(PROJECT_DIR), ".hmem", ".update-check.json");
/** Fire-and-forget update check. Runs max once per day. Logs to stderr if outdated. */
function checkForUpdates() {
    try {
        // Rate-limit: once per day per package
        let state = {};
        try {
            state = JSON.parse(fs.readFileSync(updateCheckFile, "utf8"));
        }
        catch { }
        const lastCheck = state["hmem-mcp"] ? new Date(state["hmem-mcp"]).getTime() : 0;
        if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS)
            return;
        // On Windows, npm is a .cmd wrapper — use shell only as last resort
        const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
        const child = spawn(npmCmd, ["show", "hmem-mcp", "version"], {
            stdio: ["ignore", "pipe", "ignore"],
            detached: true,
            windowsHide: true,
        });
        child.unref();
        let out = "";
        child.stdout.on("data", (d) => { out += d.toString(); });
        child.on("close", () => {
            const latest = out.trim();
            if (!latest)
                return;
            // Save check timestamp
            state["hmem-mcp"] = new Date().toISOString();
            try {
                fs.mkdirSync(path.dirname(updateCheckFile), { recursive: true });
                fs.writeFileSync(updateCheckFile, JSON.stringify(state, null, 2), "utf8");
            }
            catch { }
            // Warn if outdated
            if (latest !== CURRENT_VERSION) {
                const [ci, cj, ck] = CURRENT_VERSION.split(".").map(Number);
                const [li, lj, lk] = latest.split(".").map(Number);
                const isNewer = li > ci || (li === ci && lj > cj) || (li === ci && lj === cj && lk > ck);
                if (isNewer) {
                    log(`⚠ hmem-mcp update available: ${CURRENT_VERSION} → ${latest}. Run: npm install -g hmem-mcp@latest`);
                }
            }
        });
    }
    catch {
        // Update check is best-effort — never crash the server
    }
}
// ---- Start ----
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Startup diagnostics — helps debug "0 entries" issues
    const dbExists = fs.existsSync(HMEM_PATH);
    let entryCount = 0;
    if (dbExists) {
        try {
            const store = new HmemStore(HMEM_PATH, hmemConfig);
            try {
                entryCount = store.stats().total;
                // Reset all active markers — each session starts neutral, agent picks project
                store.clearAllActive();
            }
            finally {
                store.close();
            }
        }
        catch { }
    }
    if (!dbExists) {
        log(`WARNING: DB not found at ${HMEM_PATH}`);
        log(`  Check HMEM_PATH in your .mcp.json (current: ${HMEM_PATH})`);
        log(`  The DB will be created on first write_memory() call.`);
    }
    log(`MCP Server running on stdio | DB: ${HMEM_PATH}${dbExists ? ` (${entryCount} entries)` : " [NOT FOUND]"}`);
    checkForUpdates();
}
main().catch((error) => {
    console.error("Fatal error in MCP Server:", error);
    process.exit(1);
});
//# sourceMappingURL=mcp-server.js.map
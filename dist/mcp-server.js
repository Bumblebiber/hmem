#!/usr/bin/env node
/**
 * hmem — Humanlike Memory MCP Server.
 *
 * Provides persistent, hierarchical memory for AI agents via MCP.
 * SQLite-backed, 5-level lazy loading, role-based access control.
 *
 * Environment variables:
 *   HMEM_PROJECT_DIR         — Root directory where .hmem files are stored (required)
 *   HMEM_AGENT_ID            — Agent identifier (optional; defaults to memory.hmem)
 *   HMEM_AGENT_ROLE          — Role: worker | al | pl | ceo (default: worker)
 *   HMEM_AUDIT_STATE_PATH    — Path to audit_state.json (default: {PROJECT_DIR}/audit_state.json)
 *
 * Legacy fallbacks (Das Althing):
 *   COUNCIL_PROJECT_DIR, COUNCIL_AGENT_ID, COUNCIL_AGENT_ROLE
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import Database from "better-sqlite3";
import { searchMemory } from "./memory-search.js";
import { openAgentMemory, openCompanyMemory, resolveHmemPath, routeTask, HmemStore } from "./hmem-store.js";
import { loadHmemConfig, formatPrefixList, getSyncServers } from "./hmem-config.js";
import { SessionCache } from "./session-cache.js";
// ---- Environment ----
// HMEM_* vars are the canonical names; COUNCIL_* kept for backwards compatibility
const PROJECT_DIR = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR || "";
if (!PROJECT_DIR) {
    console.error("FATAL: HMEM_PROJECT_DIR not set");
    process.exit(1);
}
// Empty string → resolveHmemPath uses memory.hmem (no agent name required)
let AGENT_ID = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
let DEPTH = parseInt(process.env.HMEM_DEPTH || process.env.COUNCIL_DEPTH || "0", 10);
let ROLE = process.env.HMEM_AGENT_ROLE || process.env.COUNCIL_AGENT_ROLE || "worker";
// Optional: PID-based identity override (used by Das Althing orchestrator)
const ppid = process.ppid;
const ctxFile = path.join(PROJECT_DIR, "orchestrator", ".mcp_contexts", `${ppid}.json`);
try {
    if (fs.existsSync(ctxFile)) {
        const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf-8"));
        AGENT_ID = ctx.agent_id || AGENT_ID;
        DEPTH = ctx.depth ?? DEPTH;
        ROLE = ctx.role || ROLE;
    }
}
catch {
    // Fallback to env vars — context file is optional
}
function log(msg) {
    console.error(`[hmem:${AGENT_ID || "default"}] ${msg}`);
}
// ---- Session-start mtime snapshot (for [NEW] markers) ----
// Captured before any syncPull so we can detect entries created after our last local write.
const _tmpl = AGENT_ID.replace(/_\d+$/, "");
const _hmemPathAtStart = resolveHmemPath(PROJECT_DIR, _tmpl);
const dbMtimeAtStart = (() => {
    try {
        if (fs.existsSync(_hmemPathAtStart)) {
            return fs.statSync(_hmemPathAtStart).mtime.toISOString();
        }
    }
    catch { }
    return null;
})();
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
            const result = spawnSync("hmem-sync", [
                "pull", "--config", hmemSyncConfig(hmemPath),
                "--hmem-path", hmemPath,
                "--server-url", s.serverUrl, "--token", s.token,
            ], { env: { ...process.env }, encoding: "utf8", shell: process.platform === "win32", windowsHide: true });
            if (result.error)
                process.stderr.write(`hmem-sync pull error (${s.name ?? s.serverUrl}): ${result.error.message}\n`);
        }
    }
    else {
        const result = spawnSync("hmem-sync", ["pull", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath], {
            env: { ...process.env }, encoding: "utf8", shell: process.platform === "win32", windowsHide: true,
        });
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
            spawnSync("hmem-sync", [
                "pull", "--config", hmemSyncConfig(hmemPath),
                "--hmem-path", hmemPath,
                "--server-url", s.serverUrl, "--token", s.token,
            ], { env: { ...process.env }, encoding: "utf8", shell: process.platform === "win32", windowsHide: true });
        }
    }
    else {
        spawnSync("hmem-sync", ["pull", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath], {
            env: { ...process.env }, encoding: "utf8", shell: process.platform === "win32", windowsHide: true,
        });
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
            const child = spawn("hmem-sync", [
                "push", "--config", hmemSyncConfig(hmemPath),
                "--hmem-path", hmemPath,
                "--server-url", s.serverUrl, "--token", s.token,
            ], { env: { ...process.env }, shell: process.platform === "win32", stdio: "ignore", detached: true, windowsHide: true });
            child.unref();
        }
    }
    else {
        const child = spawn("hmem-sync", ["push", "--config", hmemSyncConfig(hmemPath), "--hmem-path", hmemPath], {
            env: { ...process.env }, shell: process.platform === "win32", stdio: "ignore", detached: true, windowsHide: true,
        });
        child.unref();
    }
}
// Load hmem config (hmem.config.json in project dir, falls back to defaults)
const hmemConfig = loadHmemConfig(PROJECT_DIR);
log(`Config: levels=[${hmemConfig.maxCharsPerLevel.join(",")}] depth=${hmemConfig.maxDepth}`);
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
        const child = spawn("hmem", ["update-skills"], {
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
 * Format recent O-entries block: latest O-entry with full exchanges, rest as titles.
 * @param store - HmemStore instance
 * @param limit - total O-entries to show
 * @param exchangeCount - number of exchanges to show from the latest O-entry
 * @param linkedTo - optional project ID filter
 * @returns formatted string + list of O-entry IDs for cache registration
 */
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
        // Expand exchanges: all entries when expandAll, otherwise only latest
        if (expandAll || i === 0) {
            // Check for checkpoint summaries — if present, show summary + only exchanges after it
            // Always show: latest summary (if any) + last 5 exchanges verbatim
            const VERBATIM_WINDOW = 5;
            const summaries = store.getCheckpointSummaries(o.id, 1);
            if (summaries.length > 0) {
                lines.push(`    [Summary] ${summaries[0].content}`);
            }
            const exchanges = store.getOEntryExchanges(o.id, VERBATIM_WINDOW, true);
            for (const ex of exchanges) {
                const userShort = ex.userText.length > 300 ? ex.userText.substring(0, 300) + "..." : ex.userText;
                const agentShort = ex.agentText.length > 500 ? ex.agentText.substring(0, 500) + "..." : ex.agentText;
                lines.push(`    USER: ${userShort}`);
                if (agentShort)
                    lines.push(`    AGENT: ${agentShort}`);
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
    log(`search_memory: query="${query}", scope=${scope || "all"}, by=${AGENT_ID}`);
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
    "Use > lines for body text (shown on drill-down, hidden in listings):\n" +
    "  Title line\\n> Body line 1\\n> Body line 2\\n\\tChild title\\n\\t> Child body\n" +
    "The system auto-assigns an ID and timestamp. " +
    `Use prefix to categorize: ${prefixList}.\n\n` +
    "Store types:\n" +
    "  personal (default): Your private memory\n", {
    prefix: z.string().toUpperCase().describe(`Memory category: ${prefixList}`),
    content: z.string().min(3).describe("The memory content. Use tab indentation for depth levels. Use > for body text (hidden in listings, shown on drill-down).\n" +
        "Example:\n" +
        "Council Dashboard for Althing Inc.\n" +
        "> Built a real-time dashboard with React + Vite. ShadcnUI for components, SSE for live updates.\n" +
        "\tFrontend architecture\n" +
        "\t> React + Vite, ShadcnUI components, SSE for real-time updates\n" +
        "\t\tAuth was tricky — EventSource can't send custom headers"),
    links: z.array(z.string()).optional().describe("Optional: IDs of related memories, e.g. ['P0001', 'L0005']"),
    favorite: z.coerce.boolean().optional().describe("Mark this entry as a favorite — shown with [♥] in bulk reads and always inlined with L2 detail. " +
        "Use for reference info you need to see every session, regardless of category."),
    tags: z.array(z.string()).min(1).describe("Required hashtags for cross-cutting search (min 1, recommend 3+). " +
        "E.g. ['#hmem', '#curation']. Max 10, lowercase, must start with #. Shown after title in reads."),
    pinned: z.coerce.boolean().optional().describe("Mark this entry as pinned [P] (super-favorite). Pinned entries show full L2 content in bulk reads. " +
        "Use for reference entries you need to see in full every session."),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' or 'company'"),
    min_role: z.enum(["worker", "al", "pl", "ceo"]).default("worker").describe("Minimum role to see this entry"),
    force: z.coerce.boolean().optional().describe("Force creation of a new root entry even if existing entries share tags. " +
        "Only use when you intentionally want a separate entry, not a child of an existing one."),
}, async ({ prefix, content, links, favorite, tags, pinned, store: storeName, min_role: minRole, force }) => {
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker");
    const isFirstTime = !AGENT_ID && !fs.existsSync(resolveHmemPath(PROJECT_DIR, ""));
    // O-prefix is reserved for flush_context
    if (prefix.toUpperCase() === "O") {
        return {
            content: [{ type: "text", text: "ERROR: O-prefix entries are created via flush_context, not write_memory." }],
            isError: true,
        };
    }
    // P-prefix: validate L2 structure against standard schema
    if (prefix.toUpperCase() === "P") {
        const VALID_L2_CATEGORIES = [
            "overview", "codebase", "usage", "context", "deployment",
            "bugs", "protocol", "open tasks", "ideas",
        ];
        const lines = content.split("\n");
        const l2Lines = lines.filter(l => /^\t[^\t]/.test(l)).map(l => l.replace(/^\t/, "").toLowerCase().trim());
        if (l2Lines.length > 0) {
            const invalid = l2Lines.filter(l => {
                const firstWord = l.split(/\s*[—\-:]/)[0].trim();
                return !VALID_L2_CATEGORIES.some(cat => firstWord.startsWith(cat));
            });
            if (invalid.length > 0) {
                return {
                    content: [{ type: "text", text: `WARNING: P-entry L2 nodes must use standard categories.\n` +
                                `Valid: ${VALID_L2_CATEGORIES.join(", ")}\n` +
                                `Invalid L2 nodes found: ${invalid.map(l => `"${l.substring(0, 50)}"`).join(", ")}\n\n` +
                                `See R0009 (P-Entry Standard Schema) for the full specification.\n` +
                                `Fix the L2 node names and retry. If this is intentional, explain why in the content.` }],
                    isError: true,
                };
            }
        }
    }
    // Company store: only AL+ can write
    if (storeName === "company") {
        const ROLE_LEVEL = { worker: 0, al: 1, pl: 2, ceo: 3 };
        if ((ROLE_LEVEL[agentRole] || 0) < 1) {
            return {
                content: [{ type: "text", text: "ERROR: Only AL, PL, and CEO roles can write to company memory." }],
                isError: true,
            };
        }
    }
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
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
            const effectiveMinRole = storeName === "company" ? minRole : "worker";
            const hmemPath = resolveHmemPath(PROJECT_DIR, templateName);
            if (storeName === "personal")
                syncPullThenPush(hmemPath);
            const result = hmemStore.write(prefix, content, links, effectiveMinRole, favorite, tags, pinned, force);
            const storeLabel = storeName === "company" ? "company" : (templateName || "memory");
            log(`write_memory [${storeLabel}]: ${result.id} (prefix=${prefix}, min_role=${effectiveMinRole})`);
            if (storeName === "personal")
                syncPush(hmemPath);
            const firstTimeNote = isFirstTime
                ? `\nMemory store created: ${hmemPath}\nTo use a custom name, set HMEM_AGENT_ID in your .mcp.json.`
                : "";
            return {
                content: [{
                        type: "text",
                        text: `Memory saved: ${result.id} (${result.timestamp.substring(0, 19)})\n` +
                            `Store: ${storeLabel} | Category: ${prefix}` +
                            (storeName === "company" ? ` | Clearance: ${effectiveMinRole}+` : "") +
                            firstTimeNote,
                    }],
            };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${e}` }],
            isError: true,
        };
    }
});
server.tool("update_memory", "Update the text of an existing memory entry or sub-node (your own personal memory). " +
    "Only modifies the text at the specified ID — children are preserved unchanged.\n\n" +
    "Supports > body format: 'New title\\n> Body line 1\\n> Body line 2' splits into title (shown in listings) + body (shown on drill-down).\n\n" +
    "Use cases:\n" +
    "- Correct outdated wording: update_memory(id='L0003', content='corrected summary')\n" +
    "- Add title/body split: update_memory(id='L0003', content='Short title\\n> Detailed body text')\n" +
    "- Fix a sub-node: update_memory(id='L0003.2', content='node title\\n> node body')\n" +
    "- Mark as obsolete: FIRST write the correction, THEN update with [✓ID] reference:\n" +
    "  1. write_memory(prefix='E', content='Correct fix is...') → E0076\n" +
    "  2. update_memory(id='E0042', content='Wrong — see [✓E0076]', obsolete=true)\n" +
    "- Mark as favorite: update_memory(id='D0010', content='...', favorite=true)\n" +
    "- Mark as irrelevant: update_memory(id='L0042', content='...', irrelevant=true)\n" +
    "  No correction entry needed (unlike obsolete). Hidden from bulk reads.\n\n" +
    "To add new child nodes, use append_memory. " +
    "To replace the entire tree, use delete_agent_memory + write_memory (curator only).", {
    id: z.string().describe("ID of the entry or node to update, e.g. 'L0003' or 'L0003.2'"),
    content: z.string().min(1).describe("New text content for this node (plain text, no indentation)"),
    links: z.array(z.string()).optional().describe("Optional: update linked entry IDs (root entries only). Replaces existing links."),
    obsolete: z.coerce.boolean().optional().describe("Mark this root entry as no longer valid (root entries only). " +
        "Requires [✓ID] correction reference in content (e.g. 'Wrong — see [✓E0076]')."),
    favorite: z.coerce.boolean().optional().describe("Set or clear the [♥] favorite flag. Works on root entries and sub-nodes. " +
        "Root favorites are always shown with L2 detail in bulk reads."),
    irrelevant: z.coerce.boolean().optional().describe("Mark as irrelevant [-]. Works on root entries and sub-nodes. " +
        "No correction entry needed (unlike obsolete). Irrelevant entries/nodes are hidden from output."),
    tags: z.array(z.string()).optional().describe("Set tags on this entry/node. Replaces all existing tags. " +
        "Pass empty array [] to remove all tags. E.g. ['#hmem', '#curation']."),
    pinned: z.coerce.boolean().optional().describe("Set or clear the [P] pinned flag (root entries only). " +
        "Pinned entries show full L2 content in bulk reads (super-favorite)."),
    active: z.coerce.boolean().optional().describe("Mark this root entry as actively relevant [*] (root entries only). " +
        "When any entry in a prefix has active=true, only active entries of that prefix are shown with children in bulk reads. " +
        "Non-active entries in the same prefix are shown as title-only (no children)."),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' or 'company'"),
}, async ({ id, content, links, obsolete, favorite, irrelevant, tags, pinned, active, store: storeName }) => {
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker");
    if (storeName === "company") {
        const ROLE_LEVEL = { worker: 0, al: 1, pl: 2, ceo: 3 };
        if ((ROLE_LEVEL[agentRole] || 0) < 1) {
            return {
                content: [{ type: "text", text: "ERROR: Only AL, PL, and CEO roles can write to company memory." }],
                isError: true,
            };
        }
    }
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
        try {
            if (hmemStore.corrupted) {
                return {
                    content: [{ type: "text", text: "WARNING: Memory database is corrupted! Aborting update to prevent further data loss." }],
                    isError: true,
                };
            }
            const hmemPath = resolveHmemPath(PROJECT_DIR, templateName);
            if (storeName === "personal")
                syncPullThenPush(hmemPath);
            const ok = hmemStore.updateNode(id, content, links, obsolete, favorite, undefined, irrelevant, tags, pinned, active);
            const storeLabel = storeName === "company" ? "company" : (templateName || "memory");
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
            if (storeName === "personal")
                syncPush(hmemPath);
            return { content: [{ type: "text", text: parts.join(" | ") }] };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${e}` }],
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
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
        try {
            const hmemPath = resolveHmemPath(PROJECT_DIR, templateName);
            if (storeName === "personal")
                syncPullThenPush(hmemPath);
            let updated = 0;
            let notFound = 0;
            for (const id of ids) {
                const ok = hmemStore.updateNode(id, undefined, undefined, undefined, favorite, undefined, irrelevant, undefined, pinned, active);
                if (ok)
                    updated++;
                else
                    notFound++;
            }
            const storeLabel = storeName === "company" ? "company" : (templateName || "memory");
            const flags = [
                irrelevant !== undefined ? `irrelevant=${irrelevant}` : "",
                favorite !== undefined ? `favorite=${favorite}` : "",
                active !== undefined ? `active=${active}` : "",
                pinned !== undefined ? `pinned=${pinned}` : "",
            ].filter(Boolean).join(", ");
            log(`update_many [${storeLabel}]: ${updated}/${ids.length} updated (${flags})`);
            if (storeName === "personal")
                syncPush(hmemPath);
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
            content: [{ type: "text", text: `ERROR: ${e}` }],
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
    tags: z.array(z.string()).min(1).describe("Required hashtags for discovery. E.g. ['#hmem', '#context-for', '#ux']"),
    links: z.array(z.string()).optional().describe("Link to related entries. E.g. ['P0029', 'D0120']"),
}, async ({ l1, l2, l3, l4, l5, tags, links }) => {
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    try {
        const hmemStore = openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
        try {
            const hmemPath = resolveHmemPath(PROJECT_DIR, templateName);
            syncPullThenPush(hmemPath);
            const result = hmemStore.writeLinear("O", { l1, l2, l3, l4, l5 }, tags, links);
            const levels = [l1, l2, l3, l4, l5].filter(Boolean).length;
            log(`flush_context: ${result.id} (${levels} levels, ${tags.join(" ")})`);
            syncPush(hmemPath);
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
            content: [{ type: "text", text: `ERROR: ${e}` }],
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
    "Use > for body text: 'Node title\\n> Body shown on drill-down\\n\\tChild node'\n\n" +
    "Examples:\n" +
    "  append_memory(id='L0003', content='New finding\\n> Detailed explanation\\n\\tSub-detail') " +
    "→ adds L2 node (with title + body) + L3 child\n" +
    "  append_memory(id='L0003.2', content='Extra note') " +
    "→ adds L3 node under the L2 node L0003.2", {
    id: z.string().describe("Root entry ID or parent node ID to append children to, e.g. 'L0003' or 'L0003.2'"),
    content: z.string().min(1).describe("Tab-indented content to append. 0 tabs = direct child of id.\n" +
        "Example: 'New point\\n\\tSub-detail'"),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' or 'company'"),
}, async ({ id, content, store: storeName }) => {
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker");
    if (storeName === "company") {
        const ROLE_LEVEL = { worker: 0, al: 1, pl: 2, ceo: 3 };
        if ((ROLE_LEVEL[agentRole] || 0) < 1) {
            return {
                content: [{ type: "text", text: "ERROR: Only AL, PL, and CEO roles can write to company memory." }],
                isError: true,
            };
        }
    }
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
        try {
            if (hmemStore.corrupted) {
                return {
                    content: [{ type: "text", text: "WARNING: Memory database is corrupted! Aborting append to prevent further data loss." }],
                    isError: true,
                };
            }
            const hmemPath = resolveHmemPath(PROJECT_DIR, templateName);
            if (storeName === "personal")
                syncPullThenPush(hmemPath);
            const result = hmemStore.appendChildren(id, content);
            const storeLabel = storeName === "company" ? "company" : (templateName || "memory");
            log(`append_memory [${storeLabel}]: ${id} + ${result.count} nodes → [${result.ids.join(", ")}]`);
            if (result.count === 0) {
                return {
                    content: [{ type: "text", text: "No nodes appended — content was empty or contained no valid lines." }],
                };
            }
            if (storeName === "personal")
                syncPush(hmemPath);
            return {
                content: [{
                        type: "text",
                        text: `Appended ${result.count} node${result.count === 1 ? "" : "s"} to ${id}.\n` +
                            `New top-level children: ${result.ids.join(", ")}`,
                    }],
            };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${e}` }],
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
}, async ({ id, depth, prefix, after, before, search, limit: maxResults, time, period, time_around, show_obsolete, show_obsolete_path, titles_only, expand, mode, store: storeName, curator, show_all, tag, stale_days, context_for, min_tag_score }) => {
    if (AGENT_ID === "UNKNOWN") {
        return {
            content: [{ type: "text", text: "ERROR: Agent-ID unknown. read_memory is only available for spawned agents." }],
            isError: true,
        };
    }
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker");
    // Pull before read to get latest from server (30s cooldown)
    const newEntries = storeName === "personal" ? syncPull(resolveHmemPath(PROJECT_DIR, templateName)) : [];
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
        try {
            const corruptionWarning = hmemStore.corrupted
                ? "⚠ WARNING: Memory database is corrupted! Reads may be incomplete. A backup (.corrupt) was saved.\n\n"
                : "";
            // Context-for: load source entry expanded + all related entries
            if (context_for) {
                const effectiveRole = storeName === "company" ? agentRole : undefined;
                const sourceEntries = hmemStore.read({
                    id: context_for,
                    expand: true,
                    agentRole: effectiveRole,
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
                const storeLabel = storeName === "company" ? "company" : templateName;
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
            const useCache = isBulkListing && storeName === "personal" && !show_all;
            const cachedIds = useCache ? sessionCache.getCachedIds() : undefined;
            const hiddenIds = useCache ? sessionCache.getHiddenIds() : undefined;
            const slotFraction = useCache ? sessionCache.getSlotFraction() : undefined;
            // Auto-select mode: first bulk read → discover, subsequent → essentials
            const effectiveMode = mode ?? (useCache && sessionCache.readCount > 0 ? "essentials" : "discover");
            const entries = hmemStore.read({
                id, depth: effectiveDepth, prefix, after, before, search,
                limit: maxResults,
                agentRole: storeName === "company" ? agentRole : undefined,
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
                const hmemPath = storeName === "company"
                    ? path.join(PROJECT_DIR, "company.hmem")
                    : resolveHmemPath(PROJECT_DIR, templateName);
                const dbExists = fs.existsSync(hmemPath);
                const label = storeName === "company" ? "company" : templateName;
                const storeInfo = `\nStore: ${label} | Agent: ${templateName || "(none)"} | DB: ${hmemPath}${dbExists ? "" : " [FILE NOT FOUND]"}`;
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
            const storeLabel = storeName === "company" ? "company" : templateName;
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
                    if (hmemConfig.recentOEntries > 0) {
                        const { text, ids } = formatRecentOEntries(hmemStore, hmemConfig.recentOEntries, 10);
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
            if (isBulkListing && storeName === "personal" && hmemConfig.recentOEntries > 0) {
                const cachedOIds = [...(cachedIds || []), ...(hiddenIds || [])].filter(id => id.startsWith("O"));
                if (cachedOIds.length === 0) {
                    const { text, ids } = formatRecentOEntries(hmemStore, hmemConfig.recentOEntries, 10);
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
                        `Standard schema (R0009): Overview → Codebase → Usage → Context → Deployment → Known issues → Protocol → Open tasks.\n` +
                        `Create new entry with write_memory(prefix="P", force=true), then mark old one obsolete.\n\n`;
                }
            }
            const header = `## Memory: ${storeLabel} (${stats.total} total entries)\n` +
                `Query: ${id ? `id=${id}` : ""}${prefix ? `prefix=${prefix}` : ""}${search ? `search="${search}"` : ""}${time_around ? `time_around=${time_around}` : ""}${after ? ` after=${after}` : ""}${before ? ` before=${before}` : ""}${time ? ` time=${time}` : ""} | Depth: ${effectiveDepth} | Results: ${visibleCount}${modeInfo}${cacheInfo}${tokenInfo}${staleHint}\n`;
            log(`read_memory [${storeLabel}]: ${visibleCount} results (depth=${effectiveDepth}, role=${agentRole}${cacheInfo})`);
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
            content: [{ type: "text", text: `ERROR: ${e}` }],
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
            : openAgentMemory(PROJECT_DIR, AGENT_ID.replace(/_\d+$/, ""), hmemConfig);
        try {
            if (format === "hmem") {
                const defaultPath = path.join(path.dirname(hmemStore.getDbPath()), "export.hmem");
                const outPath = output_path || defaultPath;
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
            content: [{ type: "text", text: `ERROR: ${e}` }],
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
            : openAgentMemory(PROJECT_DIR, AGENT_ID.replace(/_\d+$/, ""), hmemConfig);
        try {
            const result = hmemStore.importFromHmem(source_path, dry_run);
            const mode = dry_run ? "preview" : "imported";
            log(`import_memory: ${mode} from ${source_path} (${result.inserted} new, ${result.merged} merged)`);
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
            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        finally {
            hmemStore.close();
        }
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${e}` }],
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
            : openAgentMemory(PROJECT_DIR, AGENT_ID.replace(/_\d+$/, ""), hmemConfig);
        try {
            const s = hmemStore.getStats();
            const agentName = AGENT_ID.replace(/_\d+$/, "");
            const hmemPath = storeName === "company"
                ? path.join(PROJECT_DIR, "company.hmem")
                : resolveHmemPath(PROJECT_DIR, agentName);
            const lines = [];
            lines.push(`Memory stats (${storeName}):`);
            lines.push(`  Agent: ${agentName || "(none)"} | DB: ${hmemPath}`);
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
        return { content: [{ type: "text", text: `ERROR: ${e}` }], isError: true };
    }
});
server.tool("find_related", "Find entries related to the given entry. " +
    "Uses tag overlap first (intentional connections, marked [T]), " +
    "then FTS5 keyword matching as supplement (marked [~]). " +
    "Use to discover connections or spot potential duplicates.", {
    id: z.string().describe("Root entry ID to find related entries for, e.g. 'P0001'"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to return (default: 5)"),
    store: z.enum(["personal", "company"]).default("personal"),
}, async ({ id, limit, store: storeName }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : openAgentMemory(PROJECT_DIR, AGENT_ID.replace(/_\d+$/, ""), hmemConfig);
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
        return { content: [{ type: "text", text: `ERROR: ${e}` }], isError: true };
    }
});
server.tool("route_task", "Multi-agent only: find the best agent for a task based on memory content. " +
    "Scans all agent .hmem files in the Agents/ directory and scores them against tags + keywords. " +
    "Only useful in multi-agent setups (Heimdall, Das Althing) — single-agent users should ignore this tool.\n\n" +
    "Example: route_task(tags=['#backend', '#sqlite'], keywords='connection pooling bug')\n" +
    "Returns agents ranked by memory relevance with their top matching entries.", {
    tags: z.array(z.string()).min(1).describe("Tags to match against agent memories. E.g. ['#backend', '#sqlite', '#bug']"),
    keywords: z.string().optional().describe("Free-text keywords for FTS5 search supplement. E.g. 'connection pooling timeout'"),
    limit: z.number().min(1).max(20).default(5).describe("Max agents to return (default: 5)"),
}, async ({ tags, keywords, limit: maxResults }) => {
    try {
        const results = routeTask(PROJECT_DIR, tags, keywords, maxResults, hmemConfig);
        if (results.length <= 1) {
            return {
                content: [{ type: "text", text: results.length === 0
                            ? "No agents found. route_task requires a multi-agent setup with Agents/*/*.hmem files."
                            : `Only one agent found (${results[0].agent}). route_task is designed for multi-agent setups.` }],
            };
        }
        const lines = [`## Agent Routing (${results.length} matches)\n`];
        for (const r of results) {
            lines.push(`**${r.agent}** — score: ${r.score} (${r.entryCount} matching entries)`);
            for (const e of r.topEntries) {
                lines.push(`  ${e.id} (${e.score}) ${e.title}`);
            }
            lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    catch (e) {
        return { content: [{ type: "text", text: `ERROR: ${e}` }], isError: true };
    }
});
server.tool("load_project", "Load a project and activate it. Returns L2 content + L3 titles — the perfect project briefing. " +
    "Also marks the project as active (deactivates any previously active project in the same prefix).\n\n" +
    "Use this when starting work on a project. It combines read_memory(id, depth=3) + update_memory(active=true) in one call.\n\n" +
    "Example: load_project({ id: 'P0048' })\n" +
    "Returns: Overview, Codebase, Usage, Context, etc. with L3 subcategory titles.", {
    id: z.string().describe("Project entry ID, e.g. 'P0048'"),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' or 'company'"),
}, async ({ id, store: storeName }) => {
    try {
        const templateName = AGENT_ID.replace(/_\d+$/, "");
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
        try {
            // Validate it's a P-entry
            if (!id.startsWith("P")) {
                return {
                    content: [{ type: "text", text: `ERROR: load_project only works with P-prefix entries. Got: ${id}` }],
                    isError: true,
                };
            }
            // Activate the project
            hmemStore.update(id, { active: true });
            // Read with expand + depth 3 (L2 content + L3 titles + L4 hints)
            const entries = hmemStore.read({
                id,
                depth: 3,
                expand: true,
                agentRole: (ROLE || "worker"),
            });
            if (entries.length === 0) {
                return {
                    content: [{ type: "text", text: `ERROR: Project ${id} not found.` }],
                    isError: true,
                };
            }
            // Custom compact rendering for project briefing: L2 content + L3 titles, no dates, compact IDs
            const e = entries[0];
            const syncThreshold = getSyncThreshold();
            const syncTag = syncThreshold && e.updated_at && e.updated_at <= syncThreshold ? " ✓" : "";
            const lines = [];
            lines.push(`${e.id}${syncTag}  ${e.title}`);
            if (e.level_1 && e.level_1 !== e.title)
                lines.push(`  ${e.level_1}`);
            if (e.children) {
                const { withBody, withChildren } = hmemConfig.loadProjectExpand;
                for (const child of e.children.filter(c => !c.irrelevant)) {
                    const cId = child.id.replace(e.id, "");
                    const expandBody = withBody.includes(child.seq);
                    const expandChildTitles = withChildren.includes(child.seq);
                    lines.push(`  ${cId}  ${child.title || child.content.substring(0, 60)}`);
                    if (child.children && child.children.length > 0) {
                        for (const gc of child.children.filter((g) => !g.irrelevant)) {
                            const gcId = gc.id.replace(e.id, "");
                            if (expandBody) {
                                // Show L3 title + body content
                                lines.push(`    ${gcId}  ${gc.title || gc.content.substring(0, 80)}`);
                                if (gc.content && gc.content !== gc.title) {
                                    // Show body lines indented
                                    for (const bodyLine of gc.content.split("\n")) {
                                        lines.push(`      ${bodyLine}`);
                                    }
                                }
                            }
                            else if (expandChildTitles) {
                                // Show all L3 children as titles
                                const gcTitle = gc.title || (gc.content.length > 80 ? gc.content.substring(0, 80) : gc.content);
                                lines.push(`    ${gcId}  ${gcTitle}`);
                            }
                            else {
                                // Default: compact titles only
                                const gcTitle = gc.title || (gc.content.length > 80 ? gc.content.substring(0, 80) : gc.content);
                                lines.push(`    ${gcId}  ${gcTitle}`);
                            }
                            // L4 children titles (already loaded via depth=4)
                            if (gc.children && gc.children.length > 0) {
                                const visibleL4 = gc.children.filter((l4) => !l4.irrelevant);
                                for (const l4 of visibleL4) {
                                    const l4Id = l4.id.replace(e.id, "");
                                    const l4Title = l4.title || (l4.content?.length > 60 ? l4.content.substring(0, 60) + "…" : l4.content || "");
                                    lines.push(`      ${l4Id}  ${l4Title}`);
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
            // Links
            if (e.linkedEntries && e.linkedEntries.length > 0) {
                lines.push("  Links:");
                for (const le of e.linkedEntries) {
                    lines.push(`    ${le.id}  ${le.title}`);
                }
            }
            // Context injection: find related E/L entries by weighted tag scoring
            try {
                const ctx = hmemStore.findContext(id, 4, 10);
                const relatedEL = ctx.tagRelated.filter(r => (r.entry.prefix === "E" || r.entry.prefix === "L") && !r.entry.obsolete && !r.entry.irrelevant);
                if (relatedEL.length > 0) {
                    lines.push("  Related errors & lessons:");
                    for (const r of relatedEL) {
                        lines.push(`    ${r.entry.id} [⚡]  ${r.entry.title}`);
                    }
                }
            }
            catch { /* findContext may fail on empty/new entries */ }
            // Inject R-entries (rules) — always shown at project load
            const ruleEntries = hmemStore.read({
                prefix: "R",
                depth: 1,
                agentRole: (ROLE || "worker"),
            }).filter(r => !r.obsolete && !r.irrelevant);
            if (ruleEntries.length > 0) {
                lines.push("  Rules:");
                for (const r of ruleEntries) {
                    lines.push(`    ${r.id}  ${r.title}`);
                }
            }
            // Inject the most recent O-entry linked to this project with last N exchanges
            // Purpose: seamless continuation of the previous session's conversation
            if (hmemConfig.recentOEntries > 0) {
                const { text, ids } = formatRecentOEntries(hmemStore, 1, hmemConfig.recentOEntries, id, true);
                if (text) {
                    lines.push("  " + text.replace(/\n/g, "\n  "));
                    sessionCache.registerDelivered(ids);
                }
            }
            // Inject universal conventions (C-entries tagged #universal)
            try {
                const conventions = hmemStore.read({
                    prefix: "C", depth: 2, agentRole: (ROLE || "worker"),
                }).filter(c => !c.obsolete && !c.irrelevant && c.tags?.includes("#universal"));
                if (conventions.length > 0) {
                    lines.push("  Conventions (#universal):");
                    for (const c of conventions) {
                        lines.push(`    ${c.id}  ${c.title}`);
                        if (c.level_1 && c.level_1 !== c.title)
                            lines.push(`      ${c.level_1}`);
                    }
                }
            }
            catch { /* conventions are optional */ }
            const irrelevantTip = `Tip: update_memory(id, { irrelevant: true }) to hide noisy entries from future loads.`;
            const output = lines.join("\n");
            const outputTokens = Math.round(output.length / 4);
            const totalStats = hmemStore.stats();
            const totalTokens = Math.round(totalStats.totalChars / 4);
            const tokenInfo = ` | ${(outputTokens / 1000).toFixed(1)}k/${(totalTokens / 1000).toFixed(0)}k tokens`;
            log(`load_project: ${id} activated and loaded (depth=3)`);
            // Sync if enabled
            const hmemPath = resolveHmemPath(PROJECT_DIR, templateName);
            if (storeName === "personal")
                syncPush(hmemPath);
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
        return { content: [{ type: "text", text: `ERROR: ${e}` }], isError: true };
    }
});
server.tool("memory_health", "Audit report for your memory: broken links (links pointing to deleted entries), " +
    "orphaned entries (no sub-nodes), stale favorites/pinned (not accessed in 60 days), " +
    "broken obsolete chains ([✓ID] pointing to non-existent entries), " +
    "and tag orphans (tags with no matching entry). " +
    "Run before/after a curation session.", {
    store: z.enum(["personal", "company"]).default("personal"),
}, async ({ store: storeName }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : openAgentMemory(PROJECT_DIR, AGENT_ID.replace(/_\d+$/, ""), hmemConfig);
        try {
            const h = hmemStore.healthCheck();
            const lines = [`Memory health report (${storeName}):`];
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
        return { content: [{ type: "text", text: `ERROR: ${e}` }], isError: true };
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
            : openAgentMemory(PROJECT_DIR, AGENT_ID.replace(/_\d+$/, ""), hmemConfig);
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
        return { content: [{ type: "text", text: `ERROR: ${e}` }], isError: true };
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
            : openAgentMemory(PROJECT_DIR, AGENT_ID.replace(/_\d+$/, ""), hmemConfig);
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
        return { content: [{ type: "text", text: `ERROR: ${e}` }], isError: true };
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
            : openAgentMemory(PROJECT_DIR, AGENT_ID.replace(/_\d+$/, ""), hmemConfig);
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
        return { content: [{ type: "text", text: `ERROR: ${e}` }], isError: true };
    }
});
// ---- Curator Tools (ceo role only) ----
const AUDIT_STATE_FILE = process.env.HMEM_AUDIT_STATE_PATH
    || path.join(PROJECT_DIR, "audit_state.json");
function loadAuditState() {
    try {
        if (fs.existsSync(AUDIT_STATE_FILE)) {
            return JSON.parse(fs.readFileSync(AUDIT_STATE_FILE, "utf-8"));
        }
    }
    catch { /* ignore */ }
    return {};
}
function saveAuditState(state) {
    const dir = path.dirname(AUDIT_STATE_FILE);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const tmp = AUDIT_STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, AUDIT_STATE_FILE);
}
function isCurator() {
    return ROLE === "ceo";
}
server.tool("get_audit_queue", "CURATOR ONLY (ceo role). Returns agents whose .hmem has changed since last audit. " +
    "Use this at the start of each curation run to get the list of agents to process. " +
    "Each agent should be audited in a separate spawn to keep context bounded.", {}, async () => {
    if (!isCurator()) {
        return {
            content: [{ type: "text", text: "ERROR: get_audit_queue is only available to the ceo/curator role. Set HMEM_AGENT_ROLE=ceo in your MCP server config to use curation tools." }],
            isError: true,
        };
    }
    const auditState = loadAuditState();
    // Scan for .hmem files in PROJECT_DIR and subdirectories (1 level deep)
    const queue = [];
    // Check common agent directory patterns
    for (const subdir of ["Agents", "Assistenten", "agents", "."]) {
        const dir = path.join(PROJECT_DIR, subdir);
        if (!fs.existsSync(dir))
            continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const name = entry.name;
            const hmemPath = path.join(dir, name, `${name}.hmem`);
            if (!fs.existsSync(hmemPath))
                continue;
            const stat = fs.statSync(hmemPath);
            const modified = stat.mtime.toISOString();
            const lastAudit = auditState[name] || null;
            if (!lastAudit || new Date(modified) > new Date(lastAudit)) {
                queue.push({ name, hmemPath, modified, lastAudit });
            }
        }
    }
    // Also check for standalone memory.hmem in PROJECT_DIR
    const defaultHmem = path.join(PROJECT_DIR, "memory.hmem");
    if (fs.existsSync(defaultHmem)) {
        const stat = fs.statSync(defaultHmem);
        const modified = stat.mtime.toISOString();
        const lastAudit = auditState["default"] || null;
        if (!lastAudit || new Date(modified) > new Date(lastAudit)) {
            queue.push({ name: "default", hmemPath: defaultHmem, modified, lastAudit });
        }
    }
    if (queue.length === 0) {
        return {
            content: [{ type: "text", text: "Audit queue is empty — all agent memories are up to date." }],
        };
    }
    const lines = queue.map(a => `- **${a.name}**: modified ${a.modified.substring(0, 16)}` +
        (a.lastAudit ? ` | last audited ${a.lastAudit.substring(0, 16)}` : " | never audited"));
    return {
        content: [{
                type: "text",
                text: `## Audit Queue (${queue.length} agents to check)\n\n${lines.join("\n")}\n\n` +
                    `Process one agent per spawn: terminate after each to keep context bounded.`,
            }],
    };
});
server.tool("read_agent_memory", "CURATOR ONLY (ceo role). Read the full memory of any agent (for audit purposes). " +
    "Returns all entries at the specified depth. Use depth=3 for a thorough audit.", {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR', 'SIGURD'"),
    depth: z.number().int().min(1).max(5).optional().describe("Depth to read (1-5, default: 3)"),
}, async ({ agent_name, depth }) => {
    if (!isCurator()) {
        return {
            content: [{ type: "text", text: "ERROR: read_agent_memory is only available to the ceo/curator role." }],
            isError: true,
        };
    }
    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
        return {
            content: [{ type: "text", text: `No .hmem found for agent "${agent_name}" (expected: ${hmemPath}).` }],
        };
    }
    const store = new HmemStore(hmemPath, hmemConfig);
    try {
        const entries = store.read({ depth: depth || 3, limit: 500 });
        const stats = store.stats();
        if (entries.length === 0) {
            return { content: [{ type: "text", text: `Agent "${agent_name}" has no memory entries.` }] };
        }
        const lines = [`## Memory: ${agent_name} (${stats.total} entries, depth=${depth || 3})\n`];
        for (const e of entries) {
            const date = e.created_at.substring(0, 10);
            const role = e.min_role !== "worker" ? ` [${e.min_role}+]` : "";
            const access = e.access_count > 0 ? ` (${e.access_count}x)` : "";
            const obsoleteTag = e.obsolete ? " [⚠ OBSOLETE]" : "";
            const irrelevantTag = e.irrelevant ? " [- IRRELEVANT]" : "";
            const favTag = e.favorite ? " [♥]" : "";
            lines.push(`[${e.id}] ${date}${role}${favTag}${obsoleteTag}${irrelevantTag}${access}`);
            lines.push(`  ${e.title}`);
            if (e.level_1 && e.level_1 !== e.title) {
                for (const bodyLine of e.level_1.split("\n")) {
                    lines.push(`  ${bodyLine}`);
                }
            }
            if (e.children && e.children.length > 0) {
                for (const child of e.children) {
                    const indent = "  ".repeat(child.depth - 1);
                    const hint = (child.child_count ?? 0) > 0
                        ? `  (${child.child_count} — use id="${child.id}" to expand)`
                        : "";
                    lines.push(`${indent}[${child.id}] ${child.title}${hint}`);
                }
            }
            if (e.links?.length)
                lines.push(`  Links: ${e.links.join(", ")}`);
            lines.push("");
        }
        log(`read_agent_memory [CURATOR]: ${agent_name} depth=${depth || 3} → ${entries.length} entries`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    finally {
        store.close();
    }
});
server.tool("fix_agent_memory", "CURATOR ONLY (ceo role). Correct a specific entry or node in any agent's memory.\n\n" +
    "Accepts both root IDs ('L0003') and compound node IDs ('L0003.2'):\n" +
    "- Root ID: updates L1 summary text, min_role clearance, obsolete/irrelevant/favorite flags\n" +
    "- Compound node ID: updates the content of that specific node\n\n" +
    "To fix wrong prefix: delete + re-add (prefix cannot be changed in-place).\n" +
    "To consolidate fragmented P entries: use read_agent_memory to read them, " +
    "fix_agent_memory to update the keeper entry, delete_agent_memory to remove duplicates.", {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR'"),
    entry_id: z.string().describe("Root entry ID ('L0003') or compound node ID ('L0003.2'). " +
        "Node IDs update memory_nodes.content directly."),
    content: z.string().optional().describe("New text content. For root entries: replaces the L1 summary. " +
        "For node IDs: replaces that node's content."),
    min_role: z.enum(["worker", "al", "pl", "ceo"]).optional().describe("Update access clearance (root entries only)."),
    obsolete: z.coerce.boolean().optional().describe("Mark or unmark as obsolete (root entries only). " +
        "Obsolete entries stay in memory but are shown with [⚠ OBSOLETE]."),
    favorite: z.coerce.boolean().optional().describe("Set or clear the [♥] favorite flag (root entries only)."),
    irrelevant: z.coerce.boolean().optional().describe("Mark or unmark as irrelevant (root entries only). Irrelevant entries are hidden from bulk reads. No correction entry needed."),
}, async ({ agent_name, entry_id, content, min_role, obsolete, favorite, irrelevant }) => {
    if (!isCurator()) {
        return {
            content: [{ type: "text", text: "ERROR: fix_agent_memory is only available to the ceo/curator role." }],
            isError: true,
        };
    }
    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
        return {
            content: [{ type: "text", text: `No .hmem found for agent "${agent_name}".` }],
            isError: true,
        };
    }
    const store = new HmemStore(hmemPath, hmemConfig);
    try {
        const isNode = entry_id.includes(".");
        let ok = false;
        const changed = [];
        if (isNode) {
            // Compound node ID — update memory_nodes.content
            if (!content) {
                return {
                    content: [{ type: "text", text: "ERROR: 'content' is required when fixing a compound node ID." }],
                    isError: true,
                };
            }
            ok = store.updateNode(entry_id, content);
            if (ok)
                changed.push("content");
        }
        else {
            // Root entry — update memories table
            if (!content && min_role === undefined && obsolete === undefined && favorite === undefined && irrelevant === undefined) {
                return {
                    content: [{ type: "text", text: "ERROR: Provide at least one of: content, min_role, obsolete, favorite, irrelevant." }],
                    isError: true,
                };
            }
            if (content) {
                ok = store.updateNode(entry_id, content, undefined, obsolete, favorite, true /* curatorBypass */, irrelevant);
                changed.push("L1");
                if (obsolete !== undefined)
                    changed.push("obsolete");
                if (favorite !== undefined)
                    changed.push("favorite");
                if (irrelevant !== undefined)
                    changed.push("irrelevant");
            }
            else {
                const fields = {};
                if (min_role !== undefined)
                    fields.min_role = min_role;
                if (obsolete !== undefined)
                    fields.obsolete = obsolete;
                if (favorite !== undefined)
                    fields.favorite = favorite;
                if (irrelevant !== undefined)
                    fields.irrelevant = irrelevant;
                ok = store.update(entry_id, fields);
            }
            if (min_role !== undefined)
                changed.push("min_role");
            if (!content && obsolete !== undefined)
                changed.push("obsolete");
            if (!content && favorite !== undefined)
                changed.push("favorite");
            if (!content && irrelevant !== undefined)
                changed.push("irrelevant");
        }
        log(`fix_agent_memory [CURATOR]: ${agent_name} ${entry_id} → ${ok ? "updated" : "not found"} (${changed.join(", ")})`);
        return {
            content: [{
                    type: "text",
                    text: ok
                        ? `Fixed: ${agent_name}/${entry_id} (${changed.join(", ")})`
                        : `ERROR: Entry "${entry_id}" not found in ${agent_name}'s memory.`,
                }],
            isError: !ok,
        };
    }
    finally {
        store.close();
    }
});
server.tool("append_agent_memory", "CURATOR ONLY (ceo role). Append new child nodes to an existing entry in any agent's memory. " +
    "Use exclusively for merging/consolidating entries — e.g. when collapsing two P entries into one, " +
    "carry over the best content from the entry being deleted into the keeper before deleting.\n\n" +
    "Content is tab-indented relative to the parent (same as append_memory):\n" +
    "  0 tabs = direct child of id\n" +
    "  1 tab  = grandchild, etc.", {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR'"),
    id: z.string().describe("Root entry ID or parent node ID to append children to, e.g. 'P0004' or 'P0004.2'"),
    content: z.string().min(1).describe("Tab-indented content to append. 0 tabs = direct child of id."),
}, async ({ agent_name, id, content }) => {
    if (!isCurator()) {
        return {
            content: [{ type: "text", text: "ERROR: append_agent_memory is only available to the ceo/curator role." }],
            isError: true,
        };
    }
    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
        return {
            content: [{ type: "text", text: `No .hmem found for agent "${agent_name}".` }],
            isError: true,
        };
    }
    const store = new HmemStore(hmemPath, hmemConfig);
    try {
        const result = store.appendChildren(id, content);
        log(`append_agent_memory [CURATOR]: ${agent_name} ${id} + ${result.count} nodes → [${result.ids.join(", ")}]`);
        if (result.count === 0) {
            return {
                content: [{ type: "text", text: "No nodes appended — content was empty or contained no valid lines." }],
            };
        }
        return {
            content: [{
                    type: "text",
                    text: `Appended ${result.count} node${result.count === 1 ? "" : "s"} to ${agent_name}/${id}.\n` +
                        `New top-level children: ${result.ids.join(", ")}`,
                }],
        };
    }
    catch (e) {
        return {
            content: [{ type: "text", text: `ERROR: ${e}` }],
            isError: true,
        };
    }
    finally {
        store.close();
    }
});
server.tool("delete_agent_memory", "CURATOR ONLY (ceo role). Delete an entry from any agent's memory. " +
    "Use sparingly — only for exact duplicates or entries that are factually wrong and cannot be fixed.", {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR'"),
    entry_id: z.string().describe("Entry ID to delete, e.g. 'E0007'"),
}, async ({ agent_name, entry_id }) => {
    if (!isCurator()) {
        return {
            content: [{ type: "text", text: "ERROR: delete_agent_memory is only available to the ceo/curator role." }],
            isError: true,
        };
    }
    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
        return {
            content: [{ type: "text", text: `No .hmem found for agent "${agent_name}".` }],
            isError: true,
        };
    }
    const store = new HmemStore(hmemPath, hmemConfig);
    try {
        const ok = store.delete(entry_id);
        log(`delete_agent_memory [CURATOR]: ${agent_name} ${entry_id} → ${ok ? "deleted" : "not found"}`);
        return {
            content: [{
                    type: "text",
                    text: ok
                        ? `Deleted: ${agent_name}/${entry_id}`
                        : `ERROR: Entry "${entry_id}" not found in ${agent_name}'s memory.`,
                }],
            isError: !ok,
        };
    }
    finally {
        store.close();
    }
});
server.tool("mark_audited", "CURATOR ONLY (ceo role). Mark an agent as audited (updates timestamp in audit_state.json). " +
    "Call this after finishing each agent in the audit queue.", {
    agent_name: z.string().describe("Template name of the agent that was audited, e.g. 'THOR'"),
}, async ({ agent_name }) => {
    if (!isCurator()) {
        return {
            content: [{ type: "text", text: "ERROR: mark_audited is only available to the ceo/curator role." }],
            isError: true,
        };
    }
    const state = loadAuditState();
    state[agent_name] = new Date().toISOString();
    saveAuditState(state);
    log(`mark_audited [CURATOR]: ${agent_name}`);
    return {
        content: [{ type: "text", text: `Marked as audited: ${agent_name} (${state[agent_name].substring(0, 16)})` }],
    };
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
        const childCount = e.children?.length ?? 0;
        lines.push(`${e.id} ${mmdd}  ${e.title}${childCount > 0 ? ` (${childCount} exchanges)` : ""}`);
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
            const roleTag = e.min_role !== "worker" ? ` [${e.min_role}+]` : "";
            lines.push(`[${e.id}] ${date}${roleTag}${promotedTag}${activeTag}${pinnedTag}${obsoleteTag}${irrelevantTag}${accessed}`);
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
        const child = spawn("npm", ["show", "hmem-mcp", "version"], {
            stdio: ["ignore", "pipe", "ignore"],
            detached: true,
            shell: process.platform === "win32",
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
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const hmemPath = resolveHmemPath(PROJECT_DIR, templateName);
    const dbExists = fs.existsSync(hmemPath);
    let entryCount = 0;
    if (dbExists) {
        try {
            const store = openAgentMemory(PROJECT_DIR, templateName, hmemConfig);
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
        log(`WARNING: DB not found at ${hmemPath}`);
        if (templateName && templateName !== "UNKNOWN") {
            log(`  HMEM_AGENT_ID="${templateName}" → expects: ${PROJECT_DIR}/Agents/${templateName}/${templateName}.hmem`);
            log(`  Without HMEM_AGENT_ID: would use ${PROJECT_DIR}/memory.hmem`);
        }
        log(`  Check HMEM_PROJECT_DIR and HMEM_AGENT_ID in your .mcp.json`);
        log(`  The DB will be created on first write_memory() call.`);
    }
    log(`MCP Server running on stdio | Agent: ${templateName || "(none)"} | Role: ${ROLE || "worker"} | DB: ${hmemPath}${dbExists ? ` (${entryCount} entries)` : " [NOT FOUND — see warnings above]"}`);
    checkForUpdates();
}
main().catch((error) => {
    console.error("Fatal error in MCP Server:", error);
    process.exit(1);
});
//# sourceMappingURL=mcp-server.js.map
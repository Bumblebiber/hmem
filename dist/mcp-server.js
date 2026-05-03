#!/usr/bin/env node
/**
 * hmem — Humanlike Memory MCP Server (daily-use tools).
 *
 * Provides persistent, hierarchical memory for AI agents via MCP.
 * SQLite-backed, 5-level lazy loading.
 *
 * Curation/maintenance tools (memory_health, tag_bulk, rename_id, etc.) live in
 * the separate hmem-curate-server. Activate it with /mcp when needed.
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { searchMemory } from "./memory-search.js";
import { openCompanyMemory, HmemStore, SimilarEntriesError } from "./hmem-store.js";
import { formatPrefixList, getSyncServers, loadHmemConfig } from "./hmem-config.js";
import { SessionCache } from "./session-cache.js";
import { currentSessionId, writeActiveProjectFile, setActiveDevice } from "./session-state.js";
import { HMEM_PATH, PROJECT_DIR, hmemConfig, log, jsonArrayString, safeError, activeProjectLine, syncPull, syncPullThenPush, syncPush, syncPushWithRetry, reserveNextId, reserveNextSubIds, resolveStore, } from "./mcp-shared.js";
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
// ---- Depth override (legacy Althing orchestrator) ----
let DEPTH = parseInt(process.env.HMEM_DEPTH || "0", 10);
{
    const ppid = process.ppid;
    const ctxFile = path.join(PROJECT_DIR, "orchestrator", ".mcp_contexts", `${ppid}.json`);
    try {
        if (fs.existsSync(ctxFile)) {
            const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf-8"));
            DEPTH = ctx.depth ?? DEPTH;
        }
    }
    catch { }
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
    const full = lines.join(" | ");
    if (full.length <= maxLen)
        return full;
    // Head+tail: keep first 60% (intent/context) + last 35% (conclusions/decisions)
    const sep = " … ";
    const headLen = Math.floor((maxLen - sep.length) * 0.6);
    const tailLen = maxLen - sep.length - headLen;
    return full.substring(0, headLen) + sep + full.substring(full.length - tailLen);
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
    version: PKG_VERSION,
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
    "  write_memory(prefix='L', title='My Lesson', body='Detailed body text.', content='\\tSection\\n\\t\\tDetails')\n" +
    "  write_memory(prefix='L', content='My Lesson\\n\\nBody text.\\n\\tSection\\n\\t\\tDetails')  ← legacy format\n" +
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
            if (storeName === "personal")
                syncPush(HMEM_PATH);
            const firstTimeNote = isFirstTime
                ? `\nMemory store created: ${HMEM_PATH}`
                : "";
            // For E and D entries: show related errors/decisions by tag overlap
            let relatedHint = "";
            if ((prefix === "E" || prefix === "D") && tags && tags.length > 0) {
                const related = hmemStore.findRelated(result.id, tags, 5);
                // Filter to E/D entries only for cross-referencing
                const relevantRelated = related.filter(r => r.id.startsWith("E") || r.id.startsWith("D"));
                if (relevantRelated.length > 0) {
                    relatedHint = "\n\nSimilar errors/decisions (by tag overlap):\n" +
                        relevantRelated.map(r => `  ${r.id}  ${r.title}`).join("\n");
                }
            }
            // Note auto-scaffolded structure for schema prefixes
            let schemaNote = "";
            if (prefix === "E") {
                schemaNote = `\nSchema: .1 Analysis, .2 Possible fixes, .3 Fixing attempts, .4 Solution, .5 Cause, .6 Key Learnings`;
            }
            else {
                const scaffoldSchema = hmemConfig.schemas?.[prefix];
                if (scaffoldSchema) {
                    const sectionList = scaffoldSchema.sections.map((s, i) => `.${i + 1} ${s.name}`).join(", ");
                    schemaNote = `\nSchema: ${sectionList}`;
                }
            }
            const activeLine = storeName === "personal" ? `\n${activeProjectLine(hmemStore)}` : "";
            return {
                content: [{
                        type: "text",
                        text: `Memory saved: ${result.id} (${result.timestamp.substring(0, 19)})\n` +
                            `Store: ${storeLabel} | Category: ${prefix}` +
                            firstTimeNote + schemaNote + relatedHint + activeLine,
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
    content: z.string().optional().describe("New title (plain text, no indentation). " +
        "If 'body' is also provided, this becomes the new title and 'body' the new body. " +
        "Omit to update only body text (existing title is preserved)."),
    body: z.string().optional().describe("New body text (shown on drill-down). " +
        "If 'content' is also provided: content=new title, body=new body. " +
        "If only 'body': existing title is preserved, only body is updated."),
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
        try {
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
            if (storeName === "personal" && !isExternal) {
                const retry = syncPushWithRetry(HMEM_PATH);
                if (!retry.resolved) {
                    parts.push(`⚠ unresolved push conflicts after ${retry.attempts} attempts`);
                }
                else if (retry.attempts > 1) {
                    parts.push(`(resolved push conflict after ${retry.attempts} attempts)`);
                }
            }
            const activeLine = storeName === "personal" && !isExternal ? `\n${activeProjectLine(hmemStore)}` : "";
            return { content: [{ type: "text", text: parts.join(" | ") + activeLine + crossProjectNotice }] };
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
    "  append_memory(id='P0048.6', title='Crash on startup', body='Steps: open app, click X') → adds child with body\n" +
    "  append_memory(id='L0003.2', content='Extra note') → adds child under L0003.2", {
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
    // Schema enforcement: if a schema is defined for this prefix, block appends to root
    // entries unless the content starts with a valid schema section name. This allows
    // adding newly-configured sections (e.g. "Rules") to existing entries (reconcile).
    if (!id.includes(".")) {
        const appendPrefix = id.match(/^([A-Z])/)?.[1];
        if (appendPrefix && hmemConfig.schemas?.[appendPrefix]) {
            const appendSchema = hmemConfig.schemas[appendPrefix];
            const firstLine = content.split("\n")[0].trim();
            const isValidSection = appendSchema.sections.some((s) => s.name.toLowerCase() === firstLine.toLowerCase());
            if (!isValidSection) {
                const sections = appendSchema.sections.map((s, i) => `  .${i + 1}  ${s.name}`).join("\n");
                return {
                    content: [{ type: "text", text: `ERROR: ${id} uses a fixed schema — cannot add new L2 nodes directly.\n` +
                                `Defined sections:\n${sections}\n\n` +
                                `Append to a specific section instead, e.g.:\n` +
                                `  append_memory(id="${id}.1", content="...")  → ${appendSchema.sections[0]?.name ?? "first section"}` }],
                    isError: true,
                };
            }
            // Valid schema section name — allow append to add a missing section to existing entry
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
            // checkpointPolicy enforcement: block writes to readonly/pointer-protected schema sections
            if (id.includes(".")) {
                const idParts = id.split(".");
                const appendPrefix = idParts[0].match(/^([A-Z]+)/)?.[1];
                const sectionSchema = appendPrefix ? hmemConfig.schemas?.[appendPrefix] : undefined;
                if (sectionSchema && idParts.length >= 2) {
                    const sectionNodeId = `${idParts[0]}.${idParts[1]}`;
                    const sectionTitle = hmemStore.getTitle(sectionNodeId);
                    const section = sectionTitle
                        ? sectionSchema.sections.find(s => s.name.toLowerCase() === sectionTitle.toLowerCase())
                        : undefined;
                    if (section?.checkpointPolicy === "readonly") {
                        return {
                            content: [{ type: "text", text: `ERROR: "${section.name}" is read-only (checkpointPolicy: readonly).\n` +
                                        `This section is maintained manually — automated appends are not allowed.` }],
                            isError: true,
                        };
                    }
                    if (section?.checkpointPolicy === "pointer") {
                        if (!/[A-Z]\d{4}/.test(content)) {
                            return {
                                content: [{ type: "text", text: `ERROR: "${section.name}" only accepts entry pointer nodes (checkpointPolicy: pointer).\n` +
                                            `Content must reference a memory entry ID (e.g., [E0124] description).\n` +
                                            `Example: append_memory(id="${sectionNodeId}", content="[E0124] Short description")` }],
                                isError: true,
                            };
                        }
                    }
                }
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
            const result = hmemStore.appendChildren(id, content);
            const storeLabel = storeName === "company" ? "company" : path.basename(HMEM_PATH, ".hmem");
            log(`append_memory [${storeLabel}]: ${id} + ${result.count} nodes → [${result.ids.join(", ")}]`);
            if (result.count === 0) {
                return {
                    content: [{ type: "text", text: "No nodes appended — content was empty or contained no valid lines." }],
                };
            }
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
            const activeLine = storeName === "personal" ? `\n${activeProjectLine(hmemStore)}` : "";
            return {
                content: [{
                        type: "text",
                        text: `Appended ${result.count} node${result.count === 1 ? "" : "s"} to ${id}.\n` +
                            `New top-level children: ${result.ids.join(", ")}` + conflictNote + activeLine + crossProjectNotice,
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
            // Auto-invalidate if session changed (e.g. after /clear while MCP server persists)
            sessionCache.bindSession(currentSessionId());
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
                        `Standard schema (R0009): Overview → Codebase → Usage → Context → Deployment → Known issues → Protocol → Open tasks.\n` +
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
            // bindSession auto-resets cache on session change (after /clear)
            sessionCache.bindSession(currentSessionId());
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
                    // ── Schema-driven rendering ──
                    const sectionMap = new Map();
                    for (const sec of pSchema.sections) {
                        sectionMap.set(sec.name.toLowerCase(), { loadDepth: sec.loadDepth });
                    }
                    for (const child of e.children.filter(c => !c.irrelevant)) {
                        const childTitle = (child.title || child.content || "").trim();
                        const match = sectionMap.get(childTitle.toLowerCase());
                        const depth = match ? match.loadDepth : 1; // unmatched → title only
                        if (depth === 0)
                            continue; // skip entirely
                        const cId = lastSeg(child.id);
                        lines.push(`  ${cId}  ${cleanTitle(childTitle, 60)}`);
                        if (depth === 1) {
                            // Title only — show child count hint if present
                            const childCount = child.children ? child.children.filter((g) => !g.irrelevant).length : 0;
                            if (childCount > 0)
                                lines[lines.length - 1] += ` (${childCount} entries)`;
                            continue;
                        }
                        if (child.children && child.children.length > 0) {
                            const DONE_FILTER_SECTIONS = ["roadmap", "next steps"];
                            const filterDone = DONE_FILTER_SECTIONS.includes(childTitle.toLowerCase());
                            let grandchildren = child.children.filter((g) => !g.irrelevant);
                            if (filterDone) {
                                grandchildren = grandchildren.filter((g) => {
                                    const t = (g.title || g.content || "").trim();
                                    return !t.startsWith("✓") && !t.startsWith("DONE");
                                });
                            }
                            for (const gc of grandchildren) {
                                const gcId = lastSeg(gc.id);
                                if (depth >= 3) {
                                    // L3 title + body
                                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                                    if (gc.content && gc.content !== gc.title) {
                                        for (const bodyLine of gc.content.split("\n")) {
                                            lines.push(`      ${bodyLine}`);
                                        }
                                    }
                                }
                                else {
                                    // depth === 2: L3 title only
                                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                                }
                                // depth >= 4: L4 children
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
            // Inject R-entries (rules) — only project-specific rules (linked to this project)
            const ruleEntries = hmemStore.read({
                prefix: "R",
                depth: 2,
            }).filter(r => !r.obsolete && !r.irrelevant && Array.isArray(r.links) && r.links.includes(id));
            if (ruleEntries.length > 0) {
                lines.push("  Rules:");
                for (const r of ruleEntries) {
                    lines.push(`    ${r.id}  ${cleanTitle(r.title)}`);
                    if (r.level_1 && r.level_1 !== r.title) {
                        lines.push(`      ${r.level_1}`);
                    }
                }
            }
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
            // Inject global context — configurable via hmem.config.json `globalLoad`.
            // Default (when not set): C#universal (depth 2). R-entries excluded — project-specific rules shown above.
            {
                const globalItems = hmemConfig.globalLoad ?? [
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
                        const heading = item.tagFilter ? `${prefixName} (${item.tagFilter}):` : `${prefixName}:`;
                        lines.push(`  ${heading}`);
                        for (const entry of entries) {
                            lines.push(`    ${entry.id}  ${cleanTitle(entry.title)}`);
                            if (item.loadDepth >= 2 && entry.level_1 && entry.level_1 !== entry.title) {
                                lines.push(`      ${entry.level_1}`);
                            }
                            if (item.loadDepth >= 3 && entry.children) {
                                for (const child of entry.children.filter(c => !c.irrelevant)) {
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
            // Onboarding hints: show when no I/A-entries exist or no active I-entry
            const onboardingHints = [];
            const hasAnyI = !!totalStats.byPrefix["I"];
            const hasActiveI = hasAnyI && !!(hmemStore.db.prepare("SELECT 1 FROM memories WHERE prefix = 'I' AND active = 1 AND irrelevant != 1 AND obsolete != 1 LIMIT 1").get());
            if (!hasAnyI || !hasActiveI) {
                const reason = !hasAnyI ? "No I-entries found" : "No active I-entry";
                onboardingHints.push(`Hint: ${reason}. Document your devices: write_memory(prefix="I", content="Device Name | Active | OS | hostname\\n\\ndetails")`);
            }
            if (!totalStats.byPrefix["A"]) {
                onboardingHints.push(`Hint: No A-entries found. Document installed apps/tools: write_memory(prefix="A", content="App Name | Active | version | install-path\\n\\ndetails")`);
            }
            const onboardingSection = onboardingHints.length > 0
                ? "\n\n" + onboardingHints.join("\n")
                : "";
            log(`load_project: ${id} activated and loaded (depth=3)`);
            // Register in session cache to prevent redundant full loads
            sessionCache.registerDelivered([id]);
            // Sync if enabled
            if (storeName === "personal")
                syncPush(HMEM_PATH);
            return trackTokens({
                content: [{
                        type: "text",
                        text: `✓ Project ${id} activated.${tokenInfo}\n${irrelevantTip}\n\n${output}\n\n${irrelevantTip}${onboardingSection}`,
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
server.tool("read_project", "Read a project's context without activating it — for cross-project reference. " +
    "Returns a focused briefing (Overview, Codebase titles, Usage, Context, Requirements titles, Roadmap titles) " +
    "without session history, rules injection, or changing the active project.\n\n" +
    "Example: read_project({ id: 'P0048' })\n" +
    "Use this when working on Project A but needing context about Project B.", {
    id: z.string().describe("Project entry ID, e.g. 'P0048'"),
    store: z.enum(["personal", "company"]).default("personal").describe("Target store: 'personal' or 'company'"),
}, async ({ id, store: storeName }) => {
    try {
        const hmemStore = storeName === "company"
            ? openCompanyMemory(PROJECT_DIR, hmemConfig)
            : new HmemStore(HMEM_PATH, hmemConfig);
        try {
            if (!id.startsWith("P")) {
                return {
                    content: [{ type: "text", text: `ERROR: read_project only works with P-prefix entries. Got: ${id}` }],
                    isError: true,
                };
            }
            const isObsolete = hmemStore.db.prepare("SELECT obsolete FROM memories WHERE id = ? AND obsolete = 1").get(id);
            if (isObsolete) {
                return {
                    content: [{ type: "text", text: `ERROR: ${id} is obsolete. Use the current version instead.` }],
                    isError: true,
                };
            }
            const entries = hmemStore.read({ id, depth: 3, expand: true });
            if (entries.length === 0) {
                return {
                    content: [{ type: "text", text: `ERROR: Project ${id} not found.` }],
                    isError: true,
                };
            }
            // depth 0=skip, 1=title+count, 2=L3 titles, 3=L3 title+body
            const SECTION_DEPTHS = {
                "overview": 3,
                "codebase": 2,
                "usage": 3,
                "context": 3,
                "requirements": 2,
                "roadmap": 1,
            };
            const e = entries[0];
            const lines = [];
            const lastSeg = (nodeId) => "." + nodeId.split(".").pop();
            lines.push(`${e.id}  ${e.title}`);
            if (e.level_1 && e.level_1 !== e.title)
                lines.push(`  ${e.level_1}`);
            if (e.children) {
                for (const child of e.children.filter(c => !c.irrelevant)) {
                    const childTitle = (child.title || child.content || "").trim();
                    const depth = SECTION_DEPTHS[childTitle.toLowerCase()] ?? 0;
                    if (depth === 0)
                        continue;
                    const cId = lastSeg(child.id);
                    lines.push(`  ${cId}  ${cleanTitle(childTitle, 60)}`);
                    if (depth === 1) {
                        const childCount = child.children ? child.children.filter((g) => !g.irrelevant).length : 0;
                        if (childCount > 0)
                            lines[lines.length - 1] += ` (${childCount} entries)`;
                        continue;
                    }
                    if (child.children && child.children.length > 0) {
                        for (const gc of child.children.filter((g) => !g.irrelevant)) {
                            const gcId = lastSeg(gc.id);
                            lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                            if (depth >= 3 && gc.content && gc.content !== gc.title) {
                                for (const bodyLine of gc.content.split("\n")) {
                                    lines.push(`      ${bodyLine}`);
                                }
                            }
                            if (gc.child_count && gc.child_count > 0) {
                                lines.push(`      [+${gc.child_count}]`);
                            }
                        }
                    }
                    else if (child.child_count && child.child_count > 0) {
                        lines.push(`    [+${child.child_count}]`);
                    }
                }
            }
            // Related E/L entries (useful for cross-project debugging)
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
            catch { /* optional */ }
            const output = lines.join("\n");
            const outputTokens = Math.round(output.length / 4);
            const totalStats = hmemStore.stats();
            const totalTokens = Math.round(totalStats.totalChars / 4);
            const tokenInfo = ` | ${(outputTokens / 1000).toFixed(1)}k/${(totalTokens / 1000).toFixed(0)}k tokens`;
            log(`read_project: ${id} loaded (reference mode, not activated)`);
            return trackTokens({
                content: [{
                        type: "text",
                        text: `✓ Project ${id} loaded (reference — not activated).${tokenInfo}\n\n${output}`,
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
    "1. P-entry with all 9 L2 sections (Overview, Codebase, Usage, Context, Deployment, Bugs, Protocol, Open tasks, Ideas)\n" +
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
                sections.push(`\tOpen tasks`);
                sections.push(`\tIdeas`);
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
                : "Overview, Codebase, Usage, Context, Deployment, Bugs, Protocol, Open tasks, Ideas";
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
// ---- Tool: set_active_device ----
server.tool("set_active_device", "Set the active device for this machine. Call this once after identifying which machine you are on. " +
    "The device ID must be an I-entry (Infrastructure entry) in hmem. " +
    "Writes ~/.hmem/active-device so all future sessions on this machine know their device. " +
    "Also updates the statusline display immediately.\n\n" +
    "Example: set_active_device({ id: 'I0002' })", {
    id: z.string().describe("I-entry ID, e.g. 'I0002'"),
}, async ({ id }) => {
    try {
        if (!id.startsWith("I")) {
            return {
                content: [{ type: "text", text: `ERROR: set_active_device only works with I-prefix entries. Got: ${id}` }],
                isError: true,
            };
        }
        const store = new HmemStore(HMEM_PATH, hmemConfig);
        let title = id;
        try {
            const row = store.db.prepare("SELECT title FROM memories WHERE id = ? AND obsolete != 1 LIMIT 1").get(id);
            if (!row) {
                return {
                    content: [{ type: "text", text: `ERROR: Entry ${id} not found or obsolete.` }],
                    isError: true,
                };
            }
            title = (row.title ?? id).split("|")[0].trim();
        }
        finally {
            store.close();
        }
        setActiveDevice(id);
        // Clear all statusline caches so the new device shows immediately
        try {
            const tmpDir = os.tmpdir();
            for (const f of fs.readdirSync(tmpDir)) {
                if (f.startsWith(".hmem_statusline_")) {
                    try {
                        fs.unlinkSync(path.join(tmpDir, f));
                    }
                    catch { /* ignore */ }
                }
            }
        }
        catch { /* ignore */ }
        log(`set_active_device: ${id} (${title})`);
        return { content: [{ type: "text", text: `Active device set to: ${id} ${title}` }] };
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
    // Search-matched sub-nodes (from FTS). Shown before children so the user
    // sees WHERE in the entry the query hit, not just the root title.
    if (e.matchedNodes && e.matchedNodes.length > 0) {
        const matchRootId = e.id.includes(".") ? e.id.split(".")[0] : e.id;
        lines.push(`  ↳ matched in ${e.matchedNodes.length} sub-node${e.matchedNodes.length === 1 ? "" : "s"}:`);
        for (const m of e.matchedNodes) {
            const compactId = m.id.replace(matchRootId, "");
            lines.push(`    ${compactId}  ${m.preview}`);
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
            if (latest !== PKG_VERSION) {
                const [ci, cj, ck] = PKG_VERSION.split(".").map(Number);
                const [li, lj, lk] = latest.split(".").map(Number);
                const isNewer = li > ci || (li === ci && lj > cj) || (li === ci && lj === cj && lk > ck);
                if (isNewer) {
                    log(`⚠ hmem-mcp update available: ${PKG_VERSION} → ${latest}. Run: npm install -g hmem-mcp@latest`);
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
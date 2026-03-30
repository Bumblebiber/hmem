/**
 * cli-log-exchange.ts
 *
 * Called by Claude Code's Stop hook after every agent response.
 * Reads the last user message from the session JSONL transcript,
 * combines it with the agent's response (from stdin hook JSON),
 * and appends both to the currently active O-entry.
 *
 * Usage: echo '{"transcript_path":"...","last_assistant_message":"..."}' | hmem log-exchange
 *
 * Requires env:
 *   HMEM_PROJECT_DIR — root directory for .hmem files
 *   HMEM_AGENT_ID    — agent identifier (optional)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { HmemStore, resolveHmemPath } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HMEM_BIN = path.resolve(__dirname, "../dist/cli.js");
/** Read the last real user message from a JSONL transcript file.
 *  Only reads the last 500KB to avoid loading huge files into memory. */
function readLastUserMessage(transcriptPath) {
    if (!fs.existsSync(transcriptPath))
        return null;
    const stat = fs.statSync(transcriptPath);
    const TAIL_BYTES = 5 * 1024 * 1024; // 5MB — large tool outputs can push user messages far back
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const content = buf.toString("utf8");
    // If we started mid-file, skip the first (likely partial) line
    const lines = start > 0 ? content.substring(content.indexOf("\n") + 1).split("\n") : content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line)
            continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === "user" &&
                entry.message?.role === "user" &&
                !entry.toolUseResult &&
                !entry.isCompactSummary &&
                !entry.isVisibleInTranscriptOnly) {
                const msg = entry.message.content;
                if (typeof msg === "string")
                    return msg;
                if (Array.isArray(msg)) {
                    return msg.filter((b) => b.type === "text").map((b) => b.text).join("\n");
                }
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
/** Read the last assistant message from the transcript (fallback when hook input lacks it). */
function readLastAssistantMessage(transcriptPath) {
    if (!fs.existsSync(transcriptPath))
        return null;
    const stat = fs.statSync(transcriptPath);
    const TAIL_BYTES = 2 * 1024 * 1024;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const content = buf.toString("utf8");
    const lines = start > 0 ? content.substring(content.indexOf("\n") + 1).split("\n") : content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line)
            continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === "assistant" && entry.message?.role === "assistant") {
                const msg = entry.message.content;
                if (typeof msg === "string")
                    return msg;
                if (Array.isArray(msg)) {
                    const text = msg.filter((b) => b.type === "text").map((b) => b.text).join("\n");
                    if (text)
                        return text;
                }
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
/** Auto-extract a short title from text (first line, max 80 chars). */
function extractTitle(text) {
    const firstLine = text.split("\n")[0].trim().replace(/[<>\[\]]/g, "");
    if (firstLine.length <= 80)
        return firstLine;
    const lastSpace = firstLine.substring(0, 80).lastIndexOf(" ");
    return (lastSpace > 40 ? firstLine.substring(0, lastSpace) : firstLine.substring(0, 80));
}
export async function logExchange() {
    // Read hook JSON from stdin synchronously (hook pipes JSON in one shot)
    let input;
    try {
        const data = fs.readFileSync(0, "utf8"); // fd 0 = stdin
        input = JSON.parse(data || "{}");
    }
    catch {
        process.exit(0);
    }
    // Resolve env defaults (HMEM_PROJECT_DIR, HMEM_AGENT_ID)
    resolveEnvDefaults();
    // Guards
    if (input.stop_hook_active)
        process.exit(0);
    if (process.env.HMEM_NO_SESSION === "1")
        process.exit(0);
    if (!input.transcript_path)
        process.exit(0);
    // Fallback: if last_assistant_message is missing (e.g. channel sessions),
    // read it from the transcript
    if (!input.last_assistant_message && input.transcript_path) {
        input.last_assistant_message = readLastAssistantMessage(input.transcript_path) || "";
    }
    if (!input.last_assistant_message)
        process.exit(0);
    // Skip subagent sessions — their transcripts are in /tmp/claude-* task directories
    // and contain MCP tool calls, not real user conversation
    if (input.transcript_path && input.transcript_path.includes("/tasks/"))
        process.exit(0);
    const userMessage = readLastUserMessage(input.transcript_path);
    if (!userMessage)
        process.exit(0);
    // Skip empty exchanges and internal hook prompts
    if (userMessage.length < 2)
        process.exit(0);
    if (userMessage.startsWith("Generate a concise one-line title"))
        process.exit(0);
    // Open hmem store
    const projectDir = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR;
    if (!projectDir)
        process.exit(0);
    const agentId = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
    const templateName = agentId.replace(/_\d+$/, "");
    const hmemPath = resolveHmemPath(projectDir, templateName);
    if (!fs.existsSync(hmemPath))
        process.exit(0);
    const hmemConfig = loadHmemConfig(path.dirname(hmemPath));
    const store = new HmemStore(hmemPath, hmemConfig);
    try {
        // Auto-purge irrelevant entries older than 30 days (~1% chance per exchange to avoid overhead)
        if (Math.random() < 0.01) {
            const purged = store.purgeIrrelevant(30);
            if (purged > 0)
                console.error(`[hmem] purged ${purged} irrelevant entries`);
        }
        // Find or create active O-entry
        const activeOId = store.getActiveO();
        // appendExchange stores raw text without newline parsing
        store.appendExchange(activeOId, userMessage, input.last_assistant_message);
        // Periodic checkpoint: count exchanges in active O-entry (project-based, not session-based)
        const saveInterval = hmemConfig.checkpointInterval;
        const checkpointMode = hmemConfig.checkpointMode;
        if (saveInterval > 0) {
            const exchangeCount = store.countDirectChildren(activeOId);
            if (exchangeCount > 0 && exchangeCount % saveInterval === 0) {
                if (checkpointMode === "auto") {
                    // Spawn background checkpoint — Haiku extracts L/D/E + titles + P-updates
                    const child = spawn(process.execPath, [HMEM_BIN, "checkpoint"], {
                        detached: true,
                        stdio: "ignore",
                        env: { ...process.env, HMEM_PROJECT_DIR: projectDir, HMEM_AGENT_ID: agentId },
                    });
                    child.unref();
                }
                else {
                    // "remind" mode: block agent and ask it to save manually
                    const nudge = {
                        decision: "block",
                        reason: `${exchangeCount} exchanges in this project session. Write key learnings to memory using write_memory (L for lessons, E for errors, D for decisions) before continuing. Keep it brief — just the important stuff.`,
                    };
                    process.stdout.write(JSON.stringify(nudge));
                }
            }
        }
    }
    catch (e) {
        console.error(`[hmem log-exchange] ${e}`);
    }
    finally {
        store.close();
    }
}
//# sourceMappingURL=cli-log-exchange.js.map
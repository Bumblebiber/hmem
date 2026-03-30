/**
 * Script:    cli-init.ts
 * Purpose:   Interactive installer for hmem MCP — configures AI coding tools
 * Author:    DEVELOPER
 * Created:   2026-02-21
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { saveHmemConfig, DEFAULT_CONFIG } from "./hmem-config.js";
// In WSL, os.homedir() may return the Windows path — prefer the Linux home directory
const HOME = (process.env.WSL_DISTRO_NAME || process.env.WSLENV)
    ? (process.env.HOME ?? os.homedir())
    : os.homedir();
const TOOLS = {
    "claude-code": {
        name: "Claude Code",
        globalDir: path.join(HOME, ".claude"),
        globalFile: ".mcp.json",
        projectDir: ".",
        projectFile: ".mcp.json",
        format: "standard",
        detect: () => fs.existsSync(path.join(HOME, ".claude")),
        globalInstructions: {
            path: path.join(HOME, ".claude", "CLAUDE.md"),
            mode: "append",
        },
        projectInstructions: {
            path: "CLAUDE.md",
            mode: "append",
        },
        skillsDir: path.join(HOME, ".claude", "skills"),
    },
    "opencode": {
        name: "OpenCode",
        globalDir: path.join(HOME, ".config", "opencode"),
        globalFile: "opencode.json",
        projectDir: ".",
        projectFile: "opencode.json",
        format: "opencode",
        detect: () => fs.existsSync(path.join(HOME, ".config", "opencode")),
        // OpenCode reads CLAUDE.md as fallback — skip to avoid duplicate writes
        globalInstructions: null,
        projectInstructions: null,
        instructionsManual: "OpenCode reads CLAUDE.md automatically — no separate file needed.",
        skillsDir: path.join(HOME, ".config", "opencode", "skills"),
    },
    "cursor": {
        name: "Cursor",
        globalDir: path.join(HOME, ".cursor"),
        globalFile: "mcp.json",
        projectDir: ".cursor",
        projectFile: "mcp.json",
        format: "standard",
        detect: () => fs.existsSync(path.join(HOME, ".cursor")),
        // Cursor has no global instructions file — only GUI (Settings > Rules)
        globalInstructions: null,
        projectInstructions: {
            path: path.join(".cursor", "rules", "hmem.mdc"),
            mode: "standalone",
        },
        instructionsManual: "Cursor: add the following to Settings → Rules (cursor.com/settings):\n" +
            "  \"At the start of every session, call read_memory() to load your long-term memory.\"",
        skillsDir: null, // Cursor doesn't support skills
    },
    "windsurf": {
        name: "Windsurf",
        globalDir: path.join(HOME, ".codeium", "windsurf"),
        globalFile: "mcp_config.json",
        projectDir: ".windsurf",
        projectFile: "mcp.json",
        format: "standard",
        detect: () => fs.existsSync(path.join(HOME, ".codeium", "windsurf")) ||
            fs.existsSync(path.join(HOME, ".windsurf")),
        globalInstructions: {
            path: path.join(HOME, ".codeium", "windsurf", "memories", "global_rules.md"),
            mode: "append",
        },
        projectInstructions: {
            path: path.join(".windsurf", "rules", "hmem.md"),
            mode: "standalone",
        },
        skillsDir: null, // Windsurf doesn't support skills
    },
    "cline": {
        name: "Cline / Roo Code (VS Code)",
        globalDir: null,
        globalFile: null,
        projectDir: ".vscode",
        projectFile: "mcp.json",
        format: "standard",
        detect: () => fs.existsSync(path.join(HOME, ".vscode")),
        // Cline: ~/Documents/Cline/Rules/  |  Roo Code: ~/.roo/rules/
        // Both are directory-based → create a dedicated hmem.md file in each
        globalInstructions: {
            path: path.join(HOME, "Documents", "Cline", "Rules", "hmem.md"),
            mode: "standalone",
        },
        projectInstructions: {
            path: path.join(".clinerules", "hmem.md"),
            mode: "standalone",
        },
        skillsDir: null, // Cline doesn't support skills natively
    },
    "gemini-cli": {
        name: "Gemini CLI",
        globalDir: path.join(HOME, ".gemini"),
        globalFile: "settings.json",
        projectDir: ".gemini",
        projectFile: "settings.json",
        format: "standard",
        detect: () => fs.existsSync(path.join(HOME, ".gemini")),
        globalInstructions: {
            path: path.join(HOME, ".gemini", "GEMINI.md"),
            mode: "append",
        },
        projectInstructions: {
            path: "GEMINI.md",
            mode: "append",
        },
        skillsDir: path.join(HOME, ".gemini", "skills"),
    },
};
// ---- Instructions content ----
const HMEM_MARKER = "## hmem — Persistent Memory";
const HMEM_APPEND_SECTION = `

## hmem — Persistent Memory

At the start of every session, call \`read_memory()\` to load your long-term memory before doing anything else.
`;
const HMEM_STANDALONE_CONTENT = `# hmem — Persistent Memory

At the start of every session, call \`read_memory()\` to load your long-term memory before doing anything else.
`;
/**
 * Writes hmem instructions to a file.
 * - append mode:     appends a section to an existing file; skips if already present.
 * - standalone mode: creates a dedicated file; skips if already exists.
 * Returns "created" | "updated" | "skipped".
 */
function writeInstructions(target) {
    const dir = path.dirname(target.path);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (target.mode === "standalone") {
        if (fs.existsSync(target.path))
            return "skipped";
        fs.writeFileSync(target.path, HMEM_STANDALONE_CONTENT, "utf-8");
        return "created";
    }
    // append mode
    if (fs.existsSync(target.path)) {
        const content = fs.readFileSync(target.path, "utf-8");
        if (content.includes(HMEM_MARKER))
            return "skipped";
        fs.appendFileSync(target.path, HMEM_APPEND_SECTION, "utf-8");
        return "updated";
    }
    else {
        fs.writeFileSync(target.path, HMEM_APPEND_SECTION.trimStart(), "utf-8");
        return "created";
    }
}
// ---- Readline helpers ----
let rl;
function ask(question) {
    return new Promise(resolve => {
        rl.question(question, answer => resolve(answer.trim()));
    });
}
async function askChoice(question, choices) {
    console.log(`\n${question}`);
    for (let i = 0; i < choices.length; i++) {
        console.log(`  ${i + 1}) ${choices[i]}`);
    }
    while (true) {
        const answer = await ask(`Choice [1-${choices.length}]: `);
        const num = parseInt(answer, 10);
        if (num >= 1 && num <= choices.length)
            return num - 1;
        console.log(`  Please enter a number between 1 and ${choices.length}.`);
    }
}
async function askMultiChoice(question, choices) {
    console.log(`\n${question}`);
    for (let i = 0; i < choices.length; i++) {
        console.log(`  ${i + 1}) ${choices[i]}`);
    }
    console.log(`  a) All`);
    while (true) {
        const answer = await ask(`Selection (e.g. 1,3 or a for all): `);
        if (answer.toLowerCase() === "a")
            return choices.map((_, i) => i);
        const nums = answer.split(/[,\s]+/).map(s => parseInt(s.trim(), 10));
        if (nums.every(n => n >= 1 && n <= choices.length))
            return nums.map(n => n - 1);
        console.log(`  Invalid selection. Enter numbers separated by commas (e.g. 1,3) or 'a' for all.`);
    }
}
// ---- Config generation ----
/**
 * Generates the MCP config entry for standard tools (Claude Code, Cursor, Windsurf, Cline).
 */
/**
 * Resolve the absolute path to the node binary.
 * Handles nvm environments where 'node' is not in PATH for non-interactive shells.
 */
function resolveNodePath() {
    // process.execPath is always the absolute path to the current node binary
    return process.execPath;
}
/**
 * Resolve the absolute path to hmem's mcp-server.js.
 * Works whether installed globally or locally.
 */
function resolveMcpServerPath() {
    // This file (cli-init.js) is in dist/ — mcp-server.js is a sibling
    return path.join(path.dirname(new URL(import.meta.url).pathname), "mcp-server.js");
}
function standardMcpEntry(projectDir, agentId) {
    const env = {
        HMEM_PROJECT_DIR: projectDir,
    };
    if (agentId)
        env.HMEM_AGENT_ID = agentId;
    return {
        mcpServers: {
            hmem: {
                command: resolveNodePath(),
                args: [resolveMcpServerPath()],
                env,
            },
        },
    };
}
/**
 * Generates the MCP config entry for OpenCode (different schema).
 */
function opencodeMcpEntry(projectDir, agentId) {
    const env = {
        HMEM_PROJECT_DIR: projectDir,
    };
    if (agentId)
        env.HMEM_AGENT_ID = agentId;
    return {
        mcp: {
            hmem: {
                type: "local",
                command: [resolveNodePath(), resolveMcpServerPath()],
                environment: env,
                enabled: true,
                timeout: 30000,
            },
        },
    };
}
/**
 * Deep-merges an MCP entry into an existing config object.
 * Never overwrites non-hmem keys.
 */
function mergeConfig(existing, entry) {
    const result = { ...existing };
    for (const [key, value] of Object.entries(entry)) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const existingVal = result[key];
            if (typeof existingVal === "object" && existingVal !== null && !Array.isArray(existingVal)) {
                result[key] = mergeConfig(existingVal, value);
            }
            else {
                result[key] = value;
            }
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
/**
 * Writes a config file, creating parent directories if needed.
 */
function writeConfigFile(filePath, config) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
// ---- Main ----
/**
 * Parse CLI flags for non-interactive mode.
 * Flags: --global, --local, --tools tool1,tool2, --dir /path, --no-example
 */
function parseInitFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--global")
            flags["scope"] = "global";
        else if (args[i] === "--local")
            flags["scope"] = "local";
        else if (args[i] === "--tools" && args[i + 1])
            flags["tools"] = args[++i];
        else if (args[i] === "--dir" && args[i + 1])
            flags["dir"] = args[++i];
        else if (args[i] === "--no-example")
            flags["no-example"] = "true";
        else if (args[i] === "--agent-id" && args[i + 1])
            flags["agent-id"] = args[++i];
    }
    return flags;
}
export async function runInit(args = []) {
    const flags = parseInitFlags(args);
    const nonInteractive = Object.keys(flags).length > 0;
    // Non-interactive: skip readline entirely
    if (!nonInteractive) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    try {
        console.log("\n  hmem — Humanlike Memory for AI Agents\n");
        if (!nonInteractive)
            console.log("  This installer configures your AI coding tools to use hmem.\n");
        // Step 1: Detect installed tools
        const detected = [];
        const notDetected = [];
        for (const [id, tool] of Object.entries(TOOLS)) {
            if (tool.detect()) {
                detected.push(id);
            }
            else {
                notDetected.push(id);
            }
        }
        if (!nonInteractive) {
            if (detected.length > 0) {
                console.log("  Detected tools:");
                for (const id of detected) {
                    console.log(`    [x] ${TOOLS[id].name}`);
                }
            }
            if (notDetected.length > 0) {
                for (const id of notDetected) {
                    console.log(`    [ ] ${TOOLS[id].name} (not found)`);
                }
            }
        }
        // Step 2: System-wide or project-local?
        let isGlobal;
        if (nonInteractive) {
            isGlobal = flags["scope"] !== "local"; // default: global
        }
        else {
            const scopeIdx = await askChoice("Installation scope:", [
                "System-wide (global — works in any directory)",
                "Project-local (only in current directory)",
            ]);
            isGlobal = scopeIdx === 0;
        }
        // Step 3: Which tools?
        const allToolIds = isGlobal
            ? detected.filter(id => TOOLS[id].globalDir !== null)
            : detected;
        if (allToolIds.length === 0) {
            console.log("\n  No supported tools detected for this scope.");
            console.log("  Install Claude Code, OpenCode, Cursor, Windsurf, Gemini CLI, or Cline first.\n");
            return;
        }
        let selectedTools;
        if (nonInteractive && flags["tools"]) {
            // Match tool names/ids from comma-separated list
            const requested = flags["tools"].split(",").map(t => t.trim().toLowerCase());
            selectedTools = allToolIds.filter(id => requested.includes(id) || requested.includes(TOOLS[id].name.toLowerCase()));
            if (selectedTools.length === 0)
                selectedTools = allToolIds; // fallback: all detected
        }
        else if (nonInteractive) {
            selectedTools = allToolIds; // default: all detected
        }
        else {
            const toolChoices = allToolIds.map(id => TOOLS[id].name);
            const selectedIndices = await askMultiChoice("Configure hmem for which tools?", toolChoices);
            selectedTools = selectedIndices.map(i => allToolIds[i]);
        }
        // Step 4: Memory directory
        const defaultDir = isGlobal ? path.join(HOME, ".hmem") : process.cwd();
        const absMemDir = nonInteractive
            ? path.resolve(flags["dir"] || defaultDir)
            : path.resolve((await ask(`\nMemory directory (press Enter to use default):\n  [${defaultDir}]: `)) || defaultDir);
        // Create memory directory if it doesn't exist
        if (!fs.existsSync(absMemDir)) {
            fs.mkdirSync(absMemDir, { recursive: true });
            console.log(`  Created: ${absMemDir}`);
        }
        // Step 4b: Example memory
        const memoryPath = path.join(absMemDir, "memory.hmem");
        if (!fs.existsSync(memoryPath)) {
            const installExample = nonInteractive
                ? flags["no-example"] !== "true" // default: install example in non-interactive
                : (await askChoice("Start with an example memory? (67 real entries from hmem development — lessons, decisions, errors, milestones)", ["Start fresh (empty memory)", "Install example (recommended for first-time users)"])) === 1;
            if (installExample) {
                // Find the bundled example file relative to this script (dist/cli-init.js → ../hmem_developer.hmem)
                const exampleSrc = path.join(import.meta.dirname, "..", "hmem_developer.hmem");
                if (fs.existsSync(exampleSrc)) {
                    fs.copyFileSync(exampleSrc, memoryPath);
                    console.log(`\n  Installed example memory: ${memoryPath}`);
                    console.log(`  67 entries, 287 nodes — call read_memory() to explore.`);
                }
                else {
                    console.log(`\n  Example file not found (${exampleSrc}) — starting fresh.`);
                }
            }
        }
        // Step 4c: Agent ID
        // Auto-detect from existing Agents/ directory, or ask interactively
        let agentId;
        if (nonInteractive) {
            agentId = flags["agent-id"] || undefined;
        }
        else {
            const agentsDir = path.join(absMemDir, "Agents");
            const existingAgents = fs.existsSync(agentsDir)
                ? fs.readdirSync(agentsDir).filter(d => fs.statSync(path.join(agentsDir, d)).isDirectory())
                : [];
            if (existingAgents.length === 1) {
                agentId = existingAgents[0];
                console.log(`\n  Auto-detected agent: ${agentId}`);
            }
            else if (existingAgents.length > 1) {
                const agentIdx = await askChoice("Multiple agents found. Which one should the MCP server use?", existingAgents);
                agentId = existingAgents[agentIdx];
            }
            else {
                const inputId = await ask("\n  Agent ID (name for your memory partition, e.g. 'DEVELOPER'; press Enter to skip): ");
                agentId = inputId.trim() || undefined;
            }
        }
        if (agentId) {
            // Ensure agent directory exists
            const agentDir = path.join(absMemDir, "Agents", agentId);
            if (!fs.existsSync(agentDir)) {
                fs.mkdirSync(agentDir, { recursive: true });
                console.log(`  Created agent directory: ${agentDir}`);
            }
        }
        // Step 5: Write MCP configs
        console.log("\n  Writing MCP configuration...\n");
        for (const toolId of selectedTools) {
            const tool = TOOLS[toolId];
            // Determine file path
            let configPath;
            if (isGlobal) {
                configPath = path.join(tool.globalDir, tool.globalFile);
            }
            else {
                const projDir = path.join(process.cwd(), tool.projectDir);
                configPath = path.join(projDir, tool.projectFile);
            }
            // Generate MCP entry
            const entry = tool.format === "opencode"
                ? opencodeMcpEntry(absMemDir, agentId)
                : standardMcpEntry(absMemDir, agentId);
            // Read existing config (if any) and merge
            let existing = {};
            if (fs.existsSync(configPath)) {
                try {
                    existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                }
                catch {
                    console.log(`  WARNING: Could not parse ${configPath} — creating new file.`);
                }
            }
            const merged = mergeConfig(existing, entry);
            writeConfigFile(configPath, merged);
            console.log(`  [ok] ${tool.name}: ${configPath}`);
        }
        // Step 6: Write instructions files (session-start memory trigger)
        console.log("\n  Writing session-start instructions...\n");
        const manualHints = [];
        for (const toolId of selectedTools) {
            const tool = TOOLS[toolId];
            const target = isGlobal ? tool.globalInstructions : tool.projectInstructions;
            if (target) {
                // Resolve project-local paths against cwd
                const resolvedTarget = isGlobal
                    ? target
                    : { ...target, path: path.resolve(process.cwd(), target.path) };
                const result = writeInstructions(resolvedTarget);
                const label = result === "skipped" ? "already set" : result;
                console.log(`  [${label}] ${tool.name}: ${resolvedTarget.path}`);
            }
            else if (tool.instructionsManual) {
                manualHints.push(`  ${tool.name}: ${tool.instructionsManual}`);
            }
        }
        // Also write Roo Code global instructions alongside Cline (both use cline toolId)
        if (selectedTools.includes("cline") && isGlobal) {
            const rooTarget = {
                path: path.join(HOME, ".roo", "rules", "hmem.md"),
                mode: "standalone",
            };
            const result = writeInstructions(rooTarget);
            const label = result === "skipped" ? "already set" : result;
            console.log(`  [${label}] Roo Code: ${rooTarget.path}`);
        }
        if (manualHints.length > 0) {
            console.log("\n  Manual steps required:");
            for (const hint of manualHints) {
                console.log(`\n${hint}`);
            }
        }
        // Step 7: Create default hmem.config.json if not exists
        const hmemConfigPath = path.join(absMemDir, "hmem.config.json");
        if (!fs.existsSync(hmemConfigPath)) {
            saveHmemConfig(absMemDir, { ...DEFAULT_CONFIG });
            console.log(`\n  [ok] Config: ${hmemConfigPath}`);
        }
        // Step 8: Install auto-memory hooks (Claude Code only)
        if (selectedTools.includes("claude-code")) {
            const hookChoice = await askChoice("Install auto-memory hooks? (Claude Code only)\n" +
                "  This adds hooks for:\n" +
                "  - Session start: remind agent to call read_memory()\n" +
                "  - Every N messages: remind agent to save knowledge (configurable)\n" +
                "  - Every response: log user/agent exchanges to session history (O-entries)\n" +
                "  - After /clear: re-inject project context automatically\n" +
                "  - Async: auto-title untitled session logs via Haiku", ["Yes — install hooks", "No — I'll set them up manually"]);
            if (hookChoice === 0) {
                const hooksDir = path.join(HOME, ".claude", "hooks");
                fs.mkdirSync(hooksDir, { recursive: true });
                // Resolve hmem binary path (npx or global)
                const hmemBin = "hmem";
                // --- Hook 1: UserPromptSubmit (startup + checkpoint reminder) ---
                const startupScript = `#!/bin/bash
# hmem memory hook (installed by hmem init):
# - First message: remind agent to call read_memory()
# - Every N messages: remind agent to save knowledge (configurable)
# - Config: checkpointInterval (default 20, 0=off), checkpointMode ("remind"|"auto")
# - Subagents are skipped (they have parentUuid set)

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$SESSION_ID" ] && SESSION_ID="global"

# Skip subagents
IS_SUBAGENT=$(echo "$INPUT" | grep -o '"parentUuid":"[^"]*"' | head -1)
[ -n "$IS_SUBAGENT" ] && exit 0

INTERVAL=20
MODE="remind"
for CFG in "$HOME/.hmem/hmem.config.json" "$HOME/.hmem/Agents/*/hmem.config.json"; do
  if [ -f "$CFG" ]; then
    VAL=$(grep -o '"checkpointInterval" *: *[0-9]*' "$CFG" 2>/dev/null | head -1 | grep -o '[0-9]*$')
    [ -n "$VAL" ] && INTERVAL=$VAL
    MVAL=$(grep -o '"checkpointMode" *: *"[^"]*"' "$CFG" 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"')
    [ -n "$MVAL" ] && MODE=$MVAL
    break
  fi
done

COUNTER_FILE="/tmp/claude-hmem-counter-\${SESSION_ID}"
if [ -f "$COUNTER_FILE" ]; then COUNT=$(cat "$COUNTER_FILE"); else COUNT=0; fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

if [ "$COUNT" -eq 1 ]; then
  cat <<'HOOK_EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "IMPORTANT: This is the first message of the session. Before responding, call read_memory() (no parameters) to load your L1 memory overview. Do this silently."
  }
}
HOOK_EOF
elif [ "$MODE" = "remind" ] && [ "$INTERVAL" -gt 0 ] && [ $((COUNT % INTERVAL)) -eq 0 ]; then
  # Remind mode only — auto mode is handled by Stop hook (hmem log-exchange + hmem checkpoint)
  cat <<'HOOK_EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "CHECKPOINT: AFTER responding to this message, you MUST save new knowledge from this session via write_memory or append_memory."
  }
}
HOOK_EOF
elif [ -f /tmp/hmem-context-warning ] && [ $((COUNT % 5)) -eq 0 ]; then
  CTX_TOKENS=$(cat /tmp/hmem-context-warning 2>/dev/null)
  cat <<HOOK_EOF
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "CONTEXT WARNING: Estimated ~\${CTX_TOKENS} tokens in context window. Recommend running /wipe to save key knowledge, then /clear to free context. Performance degrades significantly beyond this point."
  }
}
HOOK_EOF
fi
`;
                // --- Hook 2: Stop — log-exchange (synchronous, every response) ---
                const logExchangeScript = `#!/bin/bash
# hmem Stop hook (installed by hmem init):
# Logs every user/agent exchange to the active O-entry (session history).
# Reads Claude Code's Stop hook JSON from stdin and pipes it to hmem log-exchange.
# Also handles checkpoint reminders (every N messages, configurable).

export HMEM_PROJECT_DIR="\${HMEM_PROJECT_DIR:-$HOME/.hmem}"

# Auto-detect agent ID from Agents/ directory (first agent found)
if [ -z "$HMEM_AGENT_ID" ]; then
  for D in "$HMEM_PROJECT_DIR"/Agents/*/; do
    [ -d "$D" ] && export HMEM_AGENT_ID="\\$(basename "$D")" && break
  done
fi

# Skip if hmem is not installed
command -v ${hmemBin} >/dev/null 2>&1 || exit 0

# Pass stdin through to hmem log-exchange (it reads the hook JSON)
exec ${hmemBin} log-exchange
`;
                // --- Hook 3: SessionStart[clear] — context inject ---
                const contextInjectScript = `#!/bin/bash
# hmem SessionStart hook (installed by hmem init):
# Re-injects project context after /clear.
# Reads session JSON from stdin and outputs additionalContext with project state.

export HMEM_PROJECT_DIR="\${HMEM_PROJECT_DIR:-$HOME/.hmem}"

# Skip if hmem is not installed
command -v ${hmemBin} >/dev/null 2>&1 || exit 0

# Pass stdin through to hmem context-inject
exec ${hmemBin} context-inject
`;
                // Write all hook scripts
                const hooks = [
                    { name: "hmem-startup.sh", content: startupScript },
                    { name: "hmem-log-exchange.sh", content: logExchangeScript },
                    { name: "hmem-context-inject.sh", content: contextInjectScript },
                ];
                for (const h of hooks) {
                    const p = path.join(hooksDir, h.name);
                    fs.writeFileSync(p, h.content, { mode: 0o755 });
                    console.log(`\n  [ok] Hook script: ${p}`);
                }
                // Register hooks in settings.json
                const settingsPath = path.join(HOME, ".claude", "settings.json");
                let settings = {};
                try {
                    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
                }
                catch { }
                if (!settings.hooks)
                    settings.hooks = {};
                // Helper: check if a hook command is already registered
                const hasHookCmd = (event, match) => (settings.hooks[event] || []).some((h) => h.hooks?.some((hh) => hh.command?.includes(match)));
                let changed = false;
                // UserPromptSubmit — startup + checkpoint
                if (!settings.hooks.UserPromptSubmit)
                    settings.hooks.UserPromptSubmit = [];
                if (!hasHookCmd("UserPromptSubmit", "hmem-startup")) {
                    settings.hooks.UserPromptSubmit.push({
                        hooks: [{ type: "command", command: path.join(hooksDir, "hmem-startup.sh"), timeout: 5 }],
                    });
                    changed = true;
                }
                // Stop — log-exchange (async — avoid blocking Claude with Node.js cold start)
                if (!settings.hooks.Stop)
                    settings.hooks.Stop = [];
                if (!hasHookCmd("Stop", "hmem-log-exchange")) {
                    settings.hooks.Stop.unshift({
                        hooks: [{ type: "command", command: path.join(hooksDir, "hmem-log-exchange.sh"), timeout: 10, async: true }],
                    });
                    changed = true;
                }
                // SessionStart[clear] — context inject
                if (!settings.hooks.SessionStart)
                    settings.hooks.SessionStart = [];
                if (!hasHookCmd("SessionStart", "hmem-context-inject")) {
                    settings.hooks.SessionStart.push({
                        matcher: "clear",
                        hooks: [{ type: "command", command: path.join(hooksDir, "hmem-context-inject.sh"), timeout: 10 }],
                    });
                    changed = true;
                }
                if (changed) {
                    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
                    console.log(`  [ok] All hooks registered in: ${settingsPath}`);
                }
                else {
                    console.log(`  [ok] All hooks already registered in settings.json`);
                }
                // --- Statusline: context window bar + active hmem project ---
                if (!settings.statusLine) {
                    const statuslineSrc = path.join(import.meta.dirname, "..", "scripts", "hmem-statusline.sh");
                    const statuslineDst = path.join(hooksDir, "hmem-statusline.sh");
                    if (fs.existsSync(statuslineSrc)) {
                        fs.copyFileSync(statuslineSrc, statuslineDst);
                        fs.chmodSync(statuslineDst, 0o755);
                        settings.statusLine = { type: "command", command: `bash ${statuslineDst}` };
                        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
                        console.log(`  [ok] Statusline: ${statuslineDst}`);
                    }
                }
            }
        }
        console.log(`\n  Done! Restart your AI tool(s) to activate hmem.\n`);
        console.log(`  Memory directory: ${absMemDir}`);
        console.log(`\n  Install skills (slash commands):\n`);
        console.log(`    npx hmem update-skills\n`);
        console.log(`  This copies skill files to your AI tool(s). Available commands after install:\n`);
        console.log(`    /hmem-read     — Load your memory at session start`);
        console.log(`    /save          — Save session learnings to memory`);
        console.log(`    /hmem-config   — View and adjust memory settings\n`);
        console.log(`  Update hmem (always use -g for global packages, NOT inside a project):\n`);
        console.log(`    npm update -g hmem-mcp          # update MCP server`);
        console.log(`    npm update -g hmem-sync          # update sync (if installed)`);
        console.log(`    npx hmem update-skills           # update skill files after upgrade\n`);
        console.log(`  Test: Open your AI tool and call read_memory() — it should respond.\n`);
        console.log(`  Sync memories across devices (optional):\n`);
        console.log(`    npm install -g hmem-sync`);
        console.log(`    npx hmem-sync connect\n`);
        console.log(`  This lets you work on multiple devices with the same memory.`);
    }
    finally {
        if (rl)
            rl.close();
    }
}
/**
 * Copy bundled skill files to detected AI tool skill directories.
 * Overwrites existing skills with the version from the npm package.
 */
export function updateSkills() {
    const bundledSkillsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "skills");
    if (!fs.existsSync(bundledSkillsDir)) {
        console.error("Error: bundled skills directory not found at", bundledSkillsDir);
        process.exit(1);
    }
    const skillNames = fs.readdirSync(bundledSkillsDir).filter(name => fs.statSync(path.join(bundledSkillsDir, name)).isDirectory());
    if (skillNames.length === 0) {
        console.error("Error: no skills found in", bundledSkillsDir);
        process.exit(1);
    }
    // Detect installed tools and collect unique skill directories
    const targets = [];
    for (const [key, tool] of Object.entries(TOOLS)) {
        if (tool.skillsDir && tool.detect()) {
            targets.push({ tool: tool.name, dir: tool.skillsDir });
        }
    }
    if (targets.length === 0) {
        console.log("No supported AI tools detected. Skills can be manually copied from:");
        console.log(`  ${bundledSkillsDir}/`);
        console.log("\nSupported skill directories:");
        for (const [key, tool] of Object.entries(TOOLS)) {
            if (tool.skillsDir)
                console.log(`  ${tool.name}: ${tool.skillsDir}/`);
        }
        return;
    }
    console.log(`Found ${skillNames.length} skills: ${skillNames.join(", ")}\n`);
    let totalCopied = 0;
    for (const { tool, dir } of targets) {
        console.log(`${tool}: ${dir}/`);
        fs.mkdirSync(dir, { recursive: true });
        for (const skillName of skillNames) {
            const src = path.join(bundledSkillsDir, skillName);
            const dest = path.join(dir, skillName);
            fs.mkdirSync(dest, { recursive: true });
            // Copy all files in the skill directory
            const files = fs.readdirSync(src);
            for (const file of files) {
                const srcFile = path.join(src, file);
                const destFile = path.join(dest, file);
                if (fs.statSync(srcFile).isFile()) {
                    fs.copyFileSync(srcFile, destFile);
                }
            }
            totalCopied++;
            console.log(`  ✓ ${skillName}`);
        }
        console.log();
    }
    console.log(`Done — ${totalCopied} skills updated across ${targets.length} tool(s).`);
}
//# sourceMappingURL=cli-init.js.map
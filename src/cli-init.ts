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

// ---- Tool definitions ----

interface InstructionsTarget {
  /** Absolute path to the file to write. */
  path: string;
  /**
   * standalone = create a dedicated hmem.md file inside a rules directory.
   * append     = append an ## hmem section to an existing shared file (CLAUDE.md etc.)
   */
  mode: "standalone" | "append";
}

interface ToolConfig {
  name: string;
  globalDir: string | null;      // null = no global MCP config supported
  globalFile: string | null;
  projectDir: string;
  projectFile: string;
  format: "standard" | "opencode";
  detect: () => boolean;
  /** Global instructions file. null = show manual hint instead. */
  globalInstructions: InstructionsTarget | null;
  /** Project-local instructions file (relative paths resolved against cwd). */
  projectInstructions: InstructionsTarget | null;
  /** Shown when globalInstructions is null (e.g. Cursor). */
  instructionsManual?: string;
  /** Directory where skills (slash commands) are stored for this tool. */
  skillsDir: string | null;
}

// In WSL, os.homedir() may return the Windows path — prefer the Linux home directory
const HOME = (process.env.WSL_DISTRO_NAME || process.env.WSLENV)
  ? (process.env.HOME ?? os.homedir())
  : os.homedir();

const TOOLS: Record<string, ToolConfig> = {
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
    instructionsManual:
      "OpenCode reads CLAUDE.md automatically — no separate file needed.",
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
    instructionsManual:
      "Cursor: add the following to Settings → Rules (cursor.com/settings):\n" +
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
    detect: () =>
      fs.existsSync(path.join(HOME, ".codeium", "windsurf")) ||
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
function writeInstructions(target: InstructionsTarget): "created" | "updated" | "skipped" {
  const dir = path.dirname(target.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (target.mode === "standalone") {
    if (fs.existsSync(target.path)) return "skipped";
    fs.writeFileSync(target.path, HMEM_STANDALONE_CONTENT, "utf-8");
    return "created";
  }

  // append mode
  if (fs.existsSync(target.path)) {
    const content = fs.readFileSync(target.path, "utf-8");
    if (content.includes(HMEM_MARKER)) return "skipped";
    fs.appendFileSync(target.path, HMEM_APPEND_SECTION, "utf-8");
    return "updated";
  } else {
    fs.writeFileSync(target.path, HMEM_APPEND_SECTION.trimStart(), "utf-8");
    return "created";
  }
}

// ---- Readline helpers ----

let rl: readline.Interface;

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

async function askChoice(question: string, choices: string[]): Promise<number> {
  console.log(`\n${question}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i]}`);
  }
  while (true) {
    const answer = await ask(`Choice [1-${choices.length}]: `);
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= choices.length) return num - 1;
    console.log(`  Please enter a number between 1 and ${choices.length}.`);
  }
}

async function askMultiChoice(question: string, choices: string[]): Promise<number[]> {
  console.log(`\n${question}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i]}`);
  }
  console.log(`  a) All`);
  while (true) {
    const answer = await ask(`Selection (e.g. 1,3 or a for all): `);
    if (answer.toLowerCase() === "a") return choices.map((_, i) => i);
    const nums = answer.split(/[,\s]+/).map(s => parseInt(s.trim(), 10));
    if (nums.every(n => n >= 1 && n <= choices.length)) return nums.map(n => n - 1);
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
function resolveNodePath(): string {
  // process.execPath is always the absolute path to the current node binary
  return process.execPath;
}

/**
 * Resolve the absolute path to hmem's mcp-server.js.
 * Works whether installed globally or locally.
 */
function resolveMcpServerPath(): string {
  // This file (cli-init.js) is in dist/ — mcp-server.js is a sibling
  return path.join(path.dirname(new URL(import.meta.url).pathname), "mcp-server.js");
}

function standardMcpEntry(projectDir: string, agentId?: string): Record<string, unknown> {
  const env: Record<string, string> = {
    HMEM_PROJECT_DIR: projectDir,
  };
  if (agentId) env.HMEM_AGENT_ID = agentId;
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
function opencodeMcpEntry(projectDir: string, agentId?: string): Record<string, unknown> {
  const env: Record<string, string> = {
    HMEM_PROJECT_DIR: projectDir,
  };
  if (agentId) env.HMEM_AGENT_ID = agentId;
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
function mergeConfig(existing: Record<string, unknown>, entry: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const existingVal = result[key];
      if (typeof existingVal === "object" && existingVal !== null && !Array.isArray(existingVal)) {
        result[key] = mergeConfig(existingVal as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Writes a config file, creating parent directories if needed.
 */
function writeConfigFile(filePath: string, config: Record<string, unknown>): void {
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
function parseInitFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--global") flags["scope"] = "global";
    else if (args[i] === "--local") flags["scope"] = "local";
    else if (args[i] === "--tools" && args[i + 1]) flags["tools"] = args[++i];
    else if (args[i] === "--dir" && args[i + 1]) flags["dir"] = args[++i];
    else if (args[i] === "--no-example") flags["no-example"] = "true";
    else if (args[i] === "--agent-id" && args[i + 1]) flags["agent-id"] = args[++i];
  }
  return flags;
}

export async function runInit(args: string[] = []): Promise<void> {
  const flags = parseInitFlags(args);
  const nonInteractive = Object.keys(flags).length > 0;

  // Non-interactive: skip readline entirely
  if (!nonInteractive) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  try {
    console.log("\n  hmem — Humanlike Memory for AI Agents\n");
    if (!nonInteractive) console.log("  This installer configures your AI coding tools to use hmem.\n");

    // Step 1: Detect installed tools
    const detected: string[] = [];
    const notDetected: string[] = [];
    for (const [id, tool] of Object.entries(TOOLS)) {
      if (tool.detect()) {
        detected.push(id);
      } else {
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
    let isGlobal: boolean;
    if (nonInteractive) {
      isGlobal = flags["scope"] !== "local"; // default: global
    } else {
      const scopeIdx = await askChoice(
        "Installation scope:",
        [
          "System-wide (global — works in any directory)",
          "Project-local (only in current directory)",
        ]
      );
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

    let selectedTools: string[];
    if (nonInteractive && flags["tools"]) {
      // Match tool names/ids from comma-separated list
      const requested = flags["tools"].split(",").map(t => t.trim().toLowerCase());
      selectedTools = allToolIds.filter(id =>
        requested.includes(id) || requested.includes(TOOLS[id].name.toLowerCase())
      );
      if (selectedTools.length === 0) selectedTools = allToolIds; // fallback: all detected
    } else if (nonInteractive) {
      selectedTools = allToolIds; // default: all detected
    } else {
      const toolChoices = allToolIds.map(id => TOOLS[id].name);
      const selectedIndices = await askMultiChoice(
        "Configure hmem for which tools?",
        toolChoices
      );
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
        : (await askChoice(
            "Start with an example memory? (67 real entries from hmem development — lessons, decisions, errors, milestones)",
            ["Start fresh (empty memory)", "Install example (recommended for first-time users)"]
          )) === 1;
      if (installExample) {
        // Find the bundled example file relative to this script (dist/cli-init.js → ../hmem_developer.hmem)
        const exampleSrc = path.join(import.meta.dirname, "..", "hmem_developer.hmem");
        if (fs.existsSync(exampleSrc)) {
          fs.copyFileSync(exampleSrc, memoryPath);
          console.log(`\n  Installed example memory: ${memoryPath}`);
          console.log(`  67 entries, 287 nodes — call read_memory() to explore.`);
        } else {
          console.log(`\n  Example file not found (${exampleSrc}) — starting fresh.`);
        }
      }
    }

    // Step 4c: Agent ID
    // Auto-detect from existing Agents/ directory, or ask interactively
    let agentId: string | undefined;
    if (nonInteractive) {
      agentId = flags["agent-id"] || undefined;
    } else {
      const agentsDir = path.join(absMemDir, "Agents");
      const existingAgents = fs.existsSync(agentsDir)
        ? fs.readdirSync(agentsDir).filter(d => fs.statSync(path.join(agentsDir, d)).isDirectory())
        : [];
      if (existingAgents.length === 1) {
        agentId = existingAgents[0];
        console.log(`\n  Auto-detected agent: ${agentId}`);
      } else if (existingAgents.length > 1) {
        const agentIdx = await askChoice(
          "Multiple agents found. Which one should the MCP server use?",
          existingAgents
        );
        agentId = existingAgents[agentIdx];
      } else {
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
      let configPath: string;
      if (isGlobal) {
        configPath = path.join(tool.globalDir!, tool.globalFile!);
      } else {
        const projDir = path.join(process.cwd(), tool.projectDir);
        configPath = path.join(projDir, tool.projectFile);
      }

      // Generate MCP entry
      const entry = tool.format === "opencode"
        ? opencodeMcpEntry(absMemDir, agentId)
        : standardMcpEntry(absMemDir, agentId);

      // Read existing config (if any) and merge
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        try {
          existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        } catch {
          console.log(`  WARNING: Could not parse ${configPath} — creating new file.`);
        }
      }

      const merged = mergeConfig(existing, entry);
      writeConfigFile(configPath, merged);
      console.log(`  [ok] ${tool.name}: ${configPath}`);
    }

    // Step 6: Write instructions files (session-start memory trigger)
    console.log("\n  Writing session-start instructions...\n");

    const manualHints: string[] = [];

    for (const toolId of selectedTools) {
      const tool = TOOLS[toolId];
      const target = isGlobal ? tool.globalInstructions : tool.projectInstructions;

      if (target) {
        // Resolve project-local paths against cwd
        const resolvedTarget: InstructionsTarget = isGlobal
          ? target
          : { ...target, path: path.resolve(process.cwd(), target.path) };

        const result = writeInstructions(resolvedTarget);
        const label = result === "skipped" ? "already set" : result;
        console.log(`  [${label}] ${tool.name}: ${resolvedTarget.path}`);
      } else if (tool.instructionsManual) {
        manualHints.push(`  ${tool.name}: ${tool.instructionsManual}`);
      }
    }

    // Also write Roo Code global instructions alongside Cline (both use cline toolId)
    if (selectedTools.includes("cline") && isGlobal) {
      const rooTarget: InstructionsTarget = {
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
      const hookChoice = await askChoice(
        "Install auto-memory hooks? (Claude Code only)\n" +
        "  This adds hooks for:\n" +
        "  - Session start: remind agent to call read_memory()\n" +
        "  - Every N messages: remind agent to save knowledge (configurable)\n" +
        "  - Every response: log user/agent exchanges to session history (O-entries)\n" +
        "  - After /clear: re-inject project context automatically\n" +
        "  - Async: auto-title untitled session logs via Haiku",
        ["Yes — install hooks", "No — I'll set them up manually"]
      );
      if (hookChoice === 0) {
        const hooksDir = path.join(HOME, ".claude", "hooks");
        fs.mkdirSync(hooksDir, { recursive: true });

        // Register hooks in settings.json — direct hmem CLI commands (cross-platform, no bash needed)
        const settingsPath = path.join(HOME, ".claude", "settings.json");
        let settings: any = {};
        try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}

        if (!settings.hooks) settings.hooks = {};

        // Helper: check if a hook command is already registered
        const hasHookCmd = (event: string, match: string) =>
          (settings.hooks[event] || []).some((h: any) =>
            h.hooks?.some((hh: any) => hh.command?.includes(match))
          );

        // Migration: remove old .sh-based hooks (replaced by cross-platform hmem CLI commands)
        const migrateHook = (event: string, oldMatch: string) => {
          if (settings.hooks[event]) {
            const before = settings.hooks[event].length;
            settings.hooks[event] = settings.hooks[event].filter((h: any) =>
              !h.hooks?.some((hh: any) => hh.command?.includes(oldMatch))
            );
            return settings.hooks[event].length !== before;
          }
          return false;
        };
        const migrated =
          migrateHook("UserPromptSubmit", "hmem-startup.sh") ||
          migrateHook("Stop", "hmem-log-exchange.sh") ||
          migrateHook("SessionStart", "hmem-context-inject.sh");
        if (migrated) {
          console.log(`\n  [ok] Migrated old .sh hooks to cross-platform hmem commands`);
        }

        // Clean up old .sh hook scripts
        for (const old of ["hmem-startup.sh", "hmem-log-exchange.sh", "hmem-context-inject.sh"]) {
          const p = path.join(hooksDir, old);
          if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); } catch {}
          }
        }

        let changed = migrated;

        // UserPromptSubmit — startup + checkpoint (cross-platform Node.js)
        if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
        if (!hasHookCmd("UserPromptSubmit", "hmem hook-startup")) {
          settings.hooks.UserPromptSubmit.push({
            hooks: [{ type: "command", command: "hmem hook-startup", timeout: 5 }],
          });
          changed = true;
        }

        // Stop — log-exchange (async — avoid blocking Claude with Node.js cold start)
        if (!settings.hooks.Stop) settings.hooks.Stop = [];
        if (!hasHookCmd("Stop", "hmem log-exchange")) {
          settings.hooks.Stop.unshift({
            hooks: [{ type: "command", command: "hmem log-exchange", timeout: 10, async: true }],
          });
          changed = true;
        }

        // Stop — checkpoint (async, runs after log-exchange to extract knowledge)
        if (!hasHookCmd("Stop", "hmem checkpoint")) {
          settings.hooks.Stop.push({
            hooks: [{ type: "command", command: "hmem checkpoint", timeout: 120, async: true }],
          });
          changed = true;
        }

        // SessionStart[clear] — context inject
        if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
        if (!hasHookCmd("SessionStart", "hmem context-inject")) {
          settings.hooks.SessionStart.push({
            matcher: "clear",
            hooks: [{ type: "command", command: "hmem context-inject", timeout: 10 }],
          });
          changed = true;
        }

        if (changed) {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
          console.log(`  [ok] All hooks registered in: ${settingsPath}`);
        } else {
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

  } finally {
    if (rl) rl.close();
  }
}

/**
 * Copy bundled skill files to detected AI tool skill directories.
 * Overwrites existing skills with the version from the npm package.
 */
export function updateSkills(): void {
  const bundledSkillsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "skills");
  if (!fs.existsSync(bundledSkillsDir)) {
    console.error("Error: bundled skills directory not found at", bundledSkillsDir);
    process.exit(1);
  }

  const skillNames = fs.readdirSync(bundledSkillsDir).filter(
    name => fs.statSync(path.join(bundledSkillsDir, name)).isDirectory()
  );

  if (skillNames.length === 0) {
    console.error("Error: no skills found in", bundledSkillsDir);
    process.exit(1);
  }

  // Detect installed tools and collect unique skill directories
  const targets: { tool: string; dir: string }[] = [];
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
      if (tool.skillsDir) console.log(`  ${tool.name}: ${tool.skillsDir}/`);
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

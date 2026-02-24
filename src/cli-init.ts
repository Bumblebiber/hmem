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
function standardMcpEntry(projectDir: string): Record<string, unknown> {
  return {
    mcpServers: {
      hmem: {
        command: "npx",
        args: ["-y", "hmem-mcp", "serve"],
        env: {
          HMEM_PROJECT_DIR: projectDir,
        },
      },
    },
  };
}

/**
 * Generates the MCP config entry for OpenCode (different schema).
 */
function opencodeMcpEntry(projectDir: string): Record<string, unknown> {
  return {
    mcp: {
      hmem: {
        type: "local",
        command: ["npx", "-y", "hmem-mcp", "serve"],
        environment: {
          HMEM_PROJECT_DIR: projectDir,
        },
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

export async function runInit(): Promise<void> {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\n  hmem — Humanlike Memory for AI Agents\n");
    console.log("  This installer configures your AI coding tools to use hmem.\n");

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

    // Step 2: System-wide or project-local?
    const scopeIdx = await askChoice(
      "Installation scope:",
      [
        "System-wide (global — works in any directory)",
        "Project-local (only in current directory)",
      ]
    );
    const isGlobal = scopeIdx === 0;

    // Step 3: Which tools?
    const allToolIds = isGlobal
      ? detected.filter(id => TOOLS[id].globalDir !== null)
      : detected;

    if (allToolIds.length === 0) {
      console.log("\n  No supported tools detected for this scope.");
      console.log("  Install Claude Code, OpenCode, Cursor, Windsurf, Gemini CLI, or Cline first.\n");
      return;
    }

    const toolChoices = allToolIds.map(id => TOOLS[id].name);
    const selectedIndices = await askMultiChoice(
      "Configure hmem for which tools?",
      toolChoices
    );
    const selectedTools = selectedIndices.map(i => allToolIds[i]);

    // Step 4: Memory directory
    const defaultDir = isGlobal ? path.join(HOME, ".hmem") : process.cwd();
    const memDirAnswer = await ask(
      `\nMemory directory (press Enter to use default):\n  [${defaultDir}]: `
    );
    const memDir = memDirAnswer || defaultDir;
    const absMemDir = path.resolve(memDir);

    // Create memory directory if it doesn't exist
    if (!fs.existsSync(absMemDir)) {
      fs.mkdirSync(absMemDir, { recursive: true });
      console.log(`  Created: ${absMemDir}`);
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
        ? opencodeMcpEntry(absMemDir)
        : standardMcpEntry(absMemDir);

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
      const defaultConfig = {
        maxL1Chars: 120,
        maxLnChars: 50000,
        maxDepth: 5,
        defaultReadLimit: 100,
      };
      writeConfigFile(hmemConfigPath, defaultConfig);
      console.log(`\n  [ok] Config: ${hmemConfigPath}`);
    }

    console.log(`\n  Done! Restart your AI tool(s) to activate hmem.\n`);
    console.log(`  Memory directory: ${absMemDir}`);
    console.log(`\n  Available slash commands (after copying skill files — see README):\n`);
    console.log(`    /hmem-read     — Load your memory at session start`);
    console.log(`    /save          — Save session learnings to memory,`);
    console.log(`                     then commit + push (only if in a git repo with uncommitted changes)`);
    console.log(`    /hmem-config   — View and adjust memory settings`);
    console.log(`    /memory-curate — Audit and clean up memory entries`);
    console.log(`                     (advanced — untested, use with caution)\n`);
    console.log(`  Skill files: https://github.com/Bumblebiber/hmem#skill-files\n`);
    console.log(`  Test: Open your AI tool and call read_memory() — it should respond.\n`);

  } finally {
    rl.close();
  }
}

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

interface ToolConfig {
  name: string;
  globalDir: string | null;      // null = no global config supported
  globalFile: string | null;
  projectDir: string;
  projectFile: string;
  format: "standard" | "opencode";
  detect: () => boolean;
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
  },
  "opencode": {
    name: "OpenCode",
    globalDir: path.join(HOME, ".config", "opencode"),
    globalFile: "opencode.json",
    projectDir: ".",
    projectFile: "opencode.json",
    format: "opencode",
    detect: () => fs.existsSync(path.join(HOME, ".config", "opencode")),
  },
  "cursor": {
    name: "Cursor",
    globalDir: path.join(HOME, ".cursor"),
    globalFile: "mcp.json",
    projectDir: ".cursor",
    projectFile: "mcp.json",
    format: "standard",
    detect: () => fs.existsSync(path.join(HOME, ".cursor")),
  },
  "windsurf": {
    name: "Windsurf",
    globalDir: path.join(HOME, ".codeium", "windsurf"),
    globalFile: "mcp_config.json",
    projectDir: ".windsurf",
    projectFile: "mcp.json",
    format: "standard",
    detect: () => fs.existsSync(path.join(HOME, ".codeium", "windsurf"))
      || fs.existsSync(path.join(HOME, ".windsurf")),
  },
  "cline": {
    name: "Cline / Roo Code (VS Code)",
    globalDir: null,
    globalFile: null,
    projectDir: ".vscode",
    projectFile: "mcp.json",
    format: "standard",
    detect: () => fs.existsSync(path.join(HOME, ".vscode")),
  },
  "gemini-cli": {
    name: "Gemini CLI",
    globalDir: path.join(HOME, ".gemini"),
    globalFile: "settings.json",
    projectDir: ".gemini",
    projectFile: "settings.json",
    format: "standard",
    detect: () => fs.existsSync(path.join(HOME, ".gemini")),
  },
};

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
        args: ["-y", "hmem", "serve"],
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
        command: ["npx", "-y", "hmem", "serve"],
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
      console.log("  Install Claude Code, OpenCode, Cursor, Windsurf, or Gemini CLI first.\n");
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

    // Step 5: Agent ID (optional)
    const agentId = await ask(
      `Agent ID (optional, press Enter to skip): `
    );

    // Step 6: Write configs
    console.log("\n  Writing configuration...\n");

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

      // Build project dir for env var
      const envProjectDir = absMemDir;

      // Generate MCP entry
      const entry = tool.format === "opencode"
        ? opencodeMcpEntry(envProjectDir)
        : standardMcpEntry(envProjectDir);

      // Add agent ID if provided
      if (agentId) {
        if (tool.format === "opencode") {
          const mcp = entry.mcp as Record<string, any>;
          mcp.hmem.environment.HMEM_AGENT_ID = agentId;
        } else {
          const servers = entry.mcpServers as Record<string, any>;
          servers.hmem.env.HMEM_AGENT_ID = agentId;
        }
      }

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

    // Step 7: Create default hmem.config.json if not exists
    const hmemConfigPath = path.join(absMemDir, "hmem.config.json");
    if (!fs.existsSync(hmemConfigPath)) {
      const defaultConfig = {
        maxL1Chars: 120,
        maxLnChars: 50000,
        maxDepth: 5,
        defaultReadLimit: 100,
        recentDepthTiers: [
          { count: 10, depth: 2 },
          { count: 3, depth: 3 },
        ],
      };
      writeConfigFile(hmemConfigPath, defaultConfig);
      console.log(`  [ok] Config: ${hmemConfigPath}`);
    }

    console.log(`\n  Done! Restart your AI tool(s) to activate hmem.\n`);
    console.log(`  Memory directory: ${absMemDir}`);
    if (agentId) console.log(`  Agent ID: ${agentId}`);
    console.log(`\n  Test: Open your AI tool and call read_memory() — it should respond.\n`);

  } finally {
    rl.close();
  }
}

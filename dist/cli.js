#!/usr/bin/env node
/**
 * Script:    cli.ts
 * Purpose:   CLI entry point for hmem (serve, init)
 * Author:    DEVELOPER
 * Created:   2026-02-21
 */
const command = process.argv[2];
switch (command) {
    case "serve":
        await import("./mcp-server.js");
        break;
    case "init": {
        const { runInit } = await import("./cli-init.js");
        await runInit(process.argv.slice(3));
        break;
    }
    case "update-skills": {
        const { updateSkills } = await import("./cli-init.js");
        updateSkills();
        break;
    }
    case "log-exchange": {
        const { logExchange } = await import("./cli-log-exchange.js");
        await logExchange();
        break;
    }
    case "context-inject": {
        const { contextInject } = await import("./cli-context-inject.js");
        await contextInject();
        break;
    }
    case "checkpoint": {
        const { checkpoint } = await import("./cli-checkpoint.js");
        await checkpoint();
        break;
    }
    case "version":
    case "--version":
    case "-v": {
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        const pkg = require("../package.json");
        console.log(`hmem ${pkg.version}`);
        break;
    }
    default:
        console.log(`hmem — Humanlike Memory for AI Agents

Usage:
  hmem serve          Start the MCP server (stdio transport)
  hmem init           Install hmem for AI coding tools (interactive or with flags)
  hmem update-skills  Copy/update skill files to detected AI tools
  hmem log-exchange   Log a chat exchange to active O-entry (called by Stop hook)
  hmem context-inject Output compressed context for re-injection after /clear
  hmem checkpoint     Extract knowledge from recent exchanges via Haiku (background)
  hmem version        Show version

Environment variables (for serve):
  HMEM_PROJECT_DIR   Root directory for .hmem files (required)
  HMEM_AGENT_ID      Agent identifier (optional)
  HMEM_AGENT_ROLE    Role: worker | al | pl | ceo (default: worker)

Non-interactive init flags:
  --global             System-wide install (default)
  --local              Project-local install
  --tools claude-code  Comma-separated tool list (default: all detected)
  --dir /path          Memory directory (default: ~/.hmem)
  --no-example         Skip example memory installation

Examples:
  npx hmem init                          # Interactive installer
  npx hmem init --global                 # Non-interactive, all detected tools
  npx hmem init --global --tools claude-code  # Non-interactive, Claude Code only
  npx hmem update-skills                 # Update skills after npm update
  HMEM_PROJECT_DIR=. npx hmem serve      # Start server in current directory`);
        break;
}
export {};
//# sourceMappingURL=cli.js.map
#!/usr/bin/env node
/**
 * Script:    cli.ts
 * Purpose:   CLI entry point for hmem (serve, init)
 * Author:    DEVELOPER
 * Created:   2026-02-21
 */

// Parse --hmem-path flag (cross-platform alternative to HMEM_PATH=... env prefix)
const args = process.argv.slice(2);
const pathIdx = args.indexOf("--hmem-path");
if (pathIdx !== -1 && args[pathIdx + 1]) {
  process.env.HMEM_PATH = args[pathIdx + 1];
  args.splice(pathIdx, 2);
}

const command = args[0];

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

  case "hook-startup": {
    const { hookStartup } = await import("./cli-hook-startup.js");
    await hookStartup();
    break;
  }

  case "statusline": {
    const { statusline } = await import("./cli-statusline.js");
    await statusline();
    break;
  }

  case "summarize-session": {
    const { summarizeSession } = await import("./cli-session-summary.js");
    await summarizeSession(process.argv[3] || "");
    break;
  }

  case "migrate-o-entries": {
    const { migrateOEntries } = await import("./cli-migrate-o.js");
    await migrateOEntries();
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
  hmem hook-startup   UserPromptSubmit hook — counter, checkpoint reminders (cross-platform)
  hmem statusline     Generate statusline for Claude Code (reads JSON from stdin)
  hmem version        Show version

Environment variables (for serve):
  HMEM_PATH          Path to .hmem file (optional, auto-detected)
  HMEM_PROJECT_DIR   Directory for config + company.hmem (derived from HMEM_PATH)
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

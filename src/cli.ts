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
    await runInit();
    break;
  }

  case "version":
  case "--version":
  case "-v":
    console.log("hmem 1.1.0");
    break;

  default:
    console.log(`hmem — Humanlike Memory for AI Agents

Usage:
  hmem serve       Start the MCP server (stdio transport)
  hmem init        Interactive installer for AI coding tools
  hmem version     Show version

Environment variables (for serve):
  HMEM_PROJECT_DIR   Root directory for .hmem files (required)
  HMEM_AGENT_ID      Agent identifier (optional)
  HMEM_AGENT_ROLE    Role: worker | al | pl | ceo (default: worker)

Examples:
  npx hmem init                          # Configure your AI tools
  HMEM_PROJECT_DIR=. npx hmem serve      # Start server in current directory`);
    break;
}

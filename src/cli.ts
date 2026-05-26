#!/usr/bin/env node
/**
 * Script:    cli.ts
 * Purpose:   CLI entry point for hmem (serve, init)
 * Author:    DEVELOPER
 * Created:   2026-02-21
 */

import type { Harness } from './hooks/types.js';

// Parse --hmem-path flag (cross-platform alternative to HMEM_PATH=... env prefix)
const args = process.argv.slice(2);
const pathIdx = args.indexOf("--hmem-path");
if (pathIdx !== -1 && args[pathIdx + 1]) {
  process.env.HMEM_PATH = args[pathIdx + 1];
  args.splice(pathIdx, 2);
}

const command = args[0];

function printUsageTable(): void {
  console.log(`hmem — Humanlike Memory for AI Agents

Usage:
  hmem serve                          Start the MCP server (stdio transport)
  hmem init                           Install hmem for AI coding tools (interactive or with flags)
  hmem update-skills                  Copy/update skill files to detected AI tools
  hmem mcp-add-curate                 Register the hmem-curate MCP server with Claude Code (opt-in)
  hmem setup-hook                     Add hmem SessionStart hook to Claude Code settings
  hmem doctor                         Detect stale or deprecated hmem MCP entries in host configs
  hmem stats                          Show memory statistics + per-project token estimates
  hmem version                        Show version

Hook drivers (called by AI tool hooks, not directly by users):
  hmem hook-startup                   UserPromptSubmit hook — counter, checkpoint reminders
  hmem log-exchange                   Stop hook — log exchange to active O-entry
  hmem context-inject                 SessionStart[clear] hook — re-inject project context
  hmem deactivate                     SessionStart[clear] hook — clear active project
  hmem statusline                     statusLine — generate Claude Code statusline (JSON on stdin)
  hmem checkpoint                     Extract knowledge from recent exchanges (background)

Curation:
  hmem delete <ID>                    Permanently delete an entry (curator only, not synced)
  hmem migrate-o-entries              Migrate O-entries to current schema
  hmem summarize-session <id>         Generate summary node for a session

Sync (requires hmem-sync installed):
  hmem sync push                      Push local memory to sync server
  hmem sync pull                      Pull latest memory from sync server
  hmem sync status                    Show sync server + auth + last-sync state
  hmem sync setup [--join]            Interactive sync-passphrase setup

Backup / migration:
  hmem export-staging <hmem> <json>   Export .hmem to JSON staging file
  hmem import-staging <json> <hmem>   Import JSON staging back into .hmem

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
}

function printHelp(): void {
  console.log(`🧠 hmem — Quick Tips

  📦 Context full? (>100k tokens)
     /o9k-handoff  — saves high-value knowledge to hmem, then /clear.
                  Run before context compaction kicks in.

  🔄 Multiple devices?
     hmem sync setup  — Cross-device sync via passphrase.
                        Passphrase stays device-local; server only sees ciphertext.

  📜 Define your own rules?
     In-session: say "remember as a rule: ..."
       → stored as an R-entry, re-injected at every session start.

  ✨ Register a new project?
     In-session: say "new project XYZ"
       → o9k-new-project skill handles schema + O-entry linking.

  📌 Keep important entries visible every session?
     In-session: say "pin this entry"
       → marks entry as [P] pinned, L2 content injected at session start.

  🧹 Curate / delete entries?
     hmem mcp-add-curate
       → registers the maintenance MCP (bulk edits, delete, merge, stats).
         Activate via /mcp only when curating, deactivate when done.
`);
  printUsageTable();
}

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

  case "mcp-add-curate": {
    const { runMcpAddCurate } = await import("./cli-mcp-add-curate.js");
    runMcpAddCurate();
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

  case "deactivate": {
    const { deactivate } = await import("./cli-deactivate.js");
    await deactivate();
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

  case 'hook-session-start':
  case 'hook-stop':
  case 'hook-prompt-submit': {
    const harnessArg = (args.find(a => a.startsWith('--harness='))?.split('=')[1]
      ?? 'claude-code') as Harness;
    const { resolveHookRunner } = await import('./hooks/dispatch.js');
    const runner = resolveHookRunner(command, harnessArg);
    if (runner) await runner();
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

  case "stats": {
    const { printStats } = await import("./cli-stats.js");
    await printStats(process.argv[3]);
    break;
  }

  case "delete": {
    const { deleteEntry } = await import("./cli-delete.js");
    await deleteEntry(process.argv.slice(3));
    break;
  }

  case "migrate-o-entries": {
    const { migrateOEntries } = await import("./cli-migrate-o.js");
    await migrateOEntries();
    break;
  }

  case "setup-hook": {
    const { setupHook } = await import("./cli-setup-hook.js");
    await setupHook();
    break;
  }

  case "doctor": {
    const { doctor } = await import("./cli-doctor.js");
    await doctor();
    break;
  }

  case "export-staging": {
    const { exportToStaging } = await import("./sync-bridge.js");
    const hmemPath = args[1];
    const stagingPath = args[2];
    if (!hmemPath || !stagingPath) {
      console.error("Usage: hmem export-staging <hmem-path> <staging-path>");
      process.exit(1);
    }
    await exportToStaging(hmemPath, stagingPath);
    console.log(`✓ Exported ${hmemPath} → ${stagingPath}`);
    break;
  }

  case "import-staging": {
    const { importFromStaging } = await import("./sync-bridge.js");
    const hmemPath = args[1];
    const stagingPath = args[2];
    if (!hmemPath || !stagingPath) {
      console.error("Usage: hmem import-staging <staging-path> <hmem-path>");
      process.exit(1);
    }
    await importFromStaging(stagingPath, hmemPath);
    console.log(`✓ Imported ${stagingPath} → ${hmemPath}`);
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

  case "setup": {
    const { runSetup } = await import("./cli-sync-setup.js");
    await runSetup({ join: process.argv.includes("--join") });
    break;
  }

  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;

  case "sync": {
    const subCmd = process.argv[3];
    if (subCmd === "push") {
      const { syncPush } = await import("./cli-sync-push.js");
      await syncPush({ skipPull: process.argv.includes("--skip-pull") });
    } else if (subCmd === "pull") {
      const { syncPull } = await import("./cli-sync-pull.js");
      await syncPull();
    } else if (subCmd === "status") {
      const { syncStatus } = await import("./cli-sync-status.js");
      await syncStatus();
    } else if (subCmd === "setup") {
      const { runSetup } = await import("./cli-sync-setup.js");
      await runSetup({ join: process.argv.includes("--join") });
    } else {
      console.error("Usage: hmem sync <push|pull|status|setup>");
      process.exit(1);
    }
    break;
  }

  default:
    printUsageTable();
    break;
}

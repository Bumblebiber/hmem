/**
 * cli-env.ts
 *
 * Shared environment variable resolution for all hmem CLI commands.
 * Sets HMEM_PROJECT_DIR and HMEM_AGENT_ID defaults so CLI commands
 * work without a bash wrapper script (cross-platform, no Git Bash needed on Windows).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Resolve HMEM_PROJECT_DIR and HMEM_AGENT_ID environment variables.
 *
 * - HMEM_PROJECT_DIR defaults to ~/.hmem
 * - HMEM_AGENT_ID is auto-detected from Agents/ directory if not set
 *
 * Call this early in any CLI command that needs these env vars.
 */
export function resolveEnvDefaults(): void {
  // HMEM_PROJECT_DIR: default to ~/.hmem
  if (!process.env.HMEM_PROJECT_DIR) {
    process.env.HMEM_PROJECT_DIR = process.env.COUNCIL_PROJECT_DIR || path.join(os.homedir(), ".hmem");
  }

  const projectDir = process.env.HMEM_PROJECT_DIR;

  // HMEM_AGENT_ID: auto-detect from Agents/ directory
  if (!process.env.HMEM_AGENT_ID && !process.env.COUNCIL_AGENT_ID) {
    const agentsDir = path.join(projectDir, "Agents");
    try {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          process.env.HMEM_AGENT_ID = entry.name;
          break;
        }
      }
    } catch {}
  }
}

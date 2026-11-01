/**
 * cli-env.ts
 *
 * Shared environment variable resolution for all hmem CLI commands.
 * Resolves HMEM_PATH (new) and HMEM_PROJECT_DIR (for company.hmem + config).
 */

import path from "node:path";
import { resolveHmemPath } from "./hmem-store.js";
import { inheritHmemMcpEnv } from "./cli-mcp-env.js";

/**
 * Resolve HMEM_PATH and HMEM_PROJECT_DIR environment variables.
 *
 * - HMEM_PATH: explicit env > MCP config > CWD discovery > ~/.hmem/memory.hmem
 * - HMEM_PROJECT_DIR: directory containing the resolved .hmem file
 *   (used for company.hmem and hmem.config.json location)
 *
 * Call this early in any CLI command that needs these env vars.
 */
export function resolveEnvDefaults(): void {
  inheritHmemMcpEnv();

  if (!process.env.HMEM_PATH) {
    process.env.HMEM_PATH = resolveHmemPath();
  }

  if (!process.env.HMEM_PROJECT_DIR) {
    process.env.HMEM_PROJECT_DIR = path.dirname(process.env.HMEM_PATH);
  }
}

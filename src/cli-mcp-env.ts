/**
 * cli-mcp-env.ts
 *
 * MCP server environment is private to the MCP process. Claude Code shell hooks
 * start a separate hmem CLI process, so copy hmem settings from the nearest
 * project .mcp.json or Claude global MCP config when the CLI starts.
 */

import fs from "node:fs";
import path from "node:path";
import { safeHomedir } from "./utils.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfigPath(value: string, configDir: string): string {
  const expanded = value === "~" || value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(safeHomedir(), value.slice(1).replace(/^[/\\]/, ""))
    : value;
  return path.resolve(configDir, expanded);
}

function hmemServerEnv(config: unknown): JsonObject | undefined {
  if (!isObject(config) || !isObject(config.mcpServers)) return undefined;

  const servers = config.mcpServers;
  const preferred = [servers.hmem, servers["hmem-mcp"]];
  const candidates = [...preferred, ...Object.values(servers)];
  for (const server of candidates) {
    if (!isObject(server) || !isObject(server.env)) continue;
    const env = server.env;
    if (typeof env.HMEM_PATH === "string" || typeof env.HMEM_PROJECT_DIR === "string") {
      return env;
    }
  }
  return undefined;
}

function readMcpEnvFile(configPath: string): { env: JsonObject; configDir: string } | undefined {
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    const env = hmemServerEnv(config);
    if (env) return { env, configDir: path.dirname(configPath) };
  } catch {
    // Invalid MCP config should not prevent hooks from using normal defaults.
  }
  return undefined;
}

function readProjectMcpEnv(cwd: string): { env: JsonObject; configDir: string } | undefined {
  let dir = path.resolve(cwd);
  while (true) {
    const configPath = path.join(dir, ".mcp.json");
    const projectConfig = readMcpEnvFile(configPath);
    if (projectConfig) return projectConfig;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Global MCP config is also isolated to the MCP server process. Support the
  // Claude Code locations used by manual setup and `claude mcp add`.
  return readMcpEnvFile(path.join(safeHomedir(), ".claude", ".mcp.json"))
    ?? readMcpEnvFile(path.join(safeHomedir(), ".claude.json"));
}

/**
 * Populate environment expected by hmem CLI hooks from project MCP config.
 * Explicit process environment always wins over values from .mcp.json.
 */
export function inheritHmemMcpEnv(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const config = readProjectMcpEnv(cwd);
  if (config) {
    for (const [key, value] of Object.entries(config.env)) {
      if (!key.startsWith("HMEM_") || typeof value !== "string" || env[key] !== undefined) continue;
      env[key] = key === "HMEM_PATH" || key === "HMEM_PROJECT_DIR"
        ? resolveConfigPath(value, config.configDir)
        : value;
    }
  }

  // v6+ uses HMEM_PATH. Older MCP configs only provide project dir + agent id.
  // Recreate the old file layout so shell hooks use same database as MCP server.
  if (!env.HMEM_PATH && env.HMEM_PROJECT_DIR) {
    const projectDir = resolveConfigPath(env.HMEM_PROJECT_DIR, cwd);
    env.HMEM_PROJECT_DIR = projectDir;
    const agentId = env.HMEM_AGENT_ID;
    env.HMEM_PATH = agentId
      ? path.join(projectDir, "Agents", agentId, `${agentId}.hmem`)
      : path.join(projectDir, "memory.hmem");
  }

  // Hooks such as checkpoint need both values, even when they were configured
  // with only a direct HMEM_PATH.
  if (!env.HMEM_PROJECT_DIR && env.HMEM_PATH) {
    env.HMEM_PROJECT_DIR = path.dirname(resolveConfigPath(env.HMEM_PATH, cwd));
  }
}

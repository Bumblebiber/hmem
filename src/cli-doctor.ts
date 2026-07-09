/**
 * Script:    cli-doctor.ts
 * Purpose:   Diagnose stale or misconfigured hmem MCP entries across host configs.
 * Author:    DEVELOPER
 * Created:   2026-05-15
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// In WSL, os.homedir() may return the Windows path — prefer Linux home.
const HOME = (process.env.WSL_DISTRO_NAME || process.env.WSLENV)
  ? (process.env.HOME ?? os.homedir())
  : os.homedir();

interface Finding {
  severity: "stale" | "deprecated";
  location: string;
  serverKey: string;
  reason: string;
  hint: string;
}

interface McpEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

const HMEM_KEY_PATTERN = /^(hmem|hmem-mcp|its-over-9k|o9k-mcp)$/i;

function looksLikeHmemEntry(key: string, entry: McpEntry): boolean {
  if (HMEM_KEY_PATTERN.test(key)) return true;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const argStr = args.join(" ");
  if (/(?:^|[\\/])(?:hmem|hmem-mcp|its-over-9k|o9k-mcp)[\\/]/i.test(argStr)) return true;
  if (/mcp-server\.js$/i.test(argStr) && /\b(hmem|hmem-mcp|its-over-9k|o9k-mcp)\b/i.test(argStr)) return true;
  return false;
}

function pathLooksAbsolute(p: string): boolean {
  if (path.isAbsolute(p)) return true;
  // Windows drive-letter detection when running on non-Windows
  return /^[a-zA-Z]:[\\/]/.test(p);
}

function pathIsForeignPlatform(p: string): boolean {
  // Windows path on a non-Windows system, or POSIX path on Windows.
  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\");
  if (process.platform === "win32") {
    return !isWindowsPath && p.startsWith("/");
  }
  return isWindowsPath;
}

function checkEntry(location: string, serverKey: string, entry: McpEntry): Finding[] {
  const findings: Finding[] = [];
  const args = Array.isArray(entry.args) ? entry.args : [];
  const env = entry.env ?? {};

  // 1. args[0] is the mcp-server.js path — must exist on this device
  const scriptPath = args[0];
  if (typeof scriptPath === "string" && pathLooksAbsolute(scriptPath)) {
    if (pathIsForeignPlatform(scriptPath)) {
      findings.push({
        severity: "stale",
        location,
        serverKey,
        reason: `script path is from another platform: ${scriptPath}`,
        hint: "Likely synced from another device. Remove this entry or rewrite it for this device.",
      });
    } else if (!fs.existsSync(scriptPath)) {
      findings.push({
        severity: "stale",
        location,
        serverKey,
        reason: `script path does not exist: ${scriptPath}`,
        hint: "Remove this entry, or run `hmem init` to register the current install path.",
      });
    }
  }

  // 2. command — if absolute, must exist
  const cmd = typeof entry.command === "string" ? entry.command : "";
  if (cmd && pathLooksAbsolute(cmd) && !pathIsForeignPlatform(cmd) && !fs.existsSync(cmd)) {
    findings.push({
      severity: "stale",
      location,
      serverKey,
      reason: `command path does not exist: ${cmd}`,
      hint: "Remove this entry, or run `hmem init` to refresh.",
    });
  } else if (cmd && pathIsForeignPlatform(cmd)) {
    findings.push({
      severity: "stale",
      location,
      serverKey,
      reason: `command path is from another platform: ${cmd}`,
      hint: "Likely synced from another device. Remove or rewrite for this device.",
    });
  }

  // 3. Deprecated env vars (pre-v6.0 syntax)
  const hasDeprecated = "HMEM_PROJECT_DIR" in env || "HMEM_AGENT_ID" in env || "HMEM_AGENT_ROLE" in env;
  const hasModern = "HMEM_PATH" in env;
  if (hasDeprecated && !hasModern) {
    const present = ["HMEM_PROJECT_DIR", "HMEM_AGENT_ID", "HMEM_AGENT_ROLE"].filter((k) => k in env);
    findings.push({
      severity: "deprecated",
      location,
      serverKey,
      reason: `uses deprecated env vars (${present.join(", ")}) without HMEM_PATH`,
      hint: "Replace with a single HMEM_PATH pointing at your .hmem file. See /hmem-update Step 2d.",
    });
  }

  return findings;
}

interface ClaudeJson {
  mcpServers?: Record<string, McpEntry>;
  projects?: Record<string, { mcpServers?: Record<string, McpEntry>; [key: string]: unknown }>;
  [key: string]: unknown;
}

function scanClaudeJson(filePath: string): Finding[] {
  if (!fs.existsSync(filePath)) return [];
  let data: ClaudeJson;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ClaudeJson;
  } catch (e) {
    console.error(`Could not parse ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const out: Finding[] = [];
  const globalServers = data.mcpServers ?? {};
  for (const [key, entry] of Object.entries(globalServers)) {
    if (looksLikeHmemEntry(key, entry)) {
      out.push(...checkEntry(`${filePath} → mcpServers.${key}`, key, entry));
    }
  }

  const projects = data.projects ?? {};
  for (const [projectPath, projectCfg] of Object.entries(projects)) {
    const servers = projectCfg?.mcpServers ?? {};
    for (const [key, entry] of Object.entries(servers)) {
      if (looksLikeHmemEntry(key, entry)) {
        out.push(...checkEntry(`${filePath} → projects["${projectPath}"].mcpServers.${key}`, key, entry));
      }
    }
  }

  return out;
}

export async function doctor(): Promise<void> {
  const targets = [
    path.join(HOME, ".claude.json"),
  ];

  let total = 0;
  for (const file of targets) {
    const findings = scanClaudeJson(file);
    if (findings.length === 0) continue;
    total += findings.length;
    console.log(`\n${file}`);
    for (const f of findings) {
      const tag = f.severity === "stale" ? "STALE     " : "DEPRECATED";
      console.log(`  [${tag}] ${f.location}`);
      console.log(`             reason: ${f.reason}`);
      console.log(`             fix:    ${f.hint}`);
    }
  }

  if (total === 0) {
    console.log("hmem doctor: no stale or deprecated MCP entries found.");
    return;
  }

  console.log(`\n${total} issue(s) found. hmem doctor does not auto-modify host configs — edit them manually or re-run \`hmem init\`.`);
  console.log("If this looks like a bug, file an issue: https://github.com/Bumblebiber/hmem/issues");
  process.exitCode = 1;
}

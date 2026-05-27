/**
 * cli-checkpoint-agent.ts
 *
 * Provider-agnostic agentic loop for the checkpoint agent.
 * Replaces the `claude -p --model haiku` subprocess spawn.
 *
 * Supports: Anthropic (native), OpenAI-compatible (OpenAI, DeepSeek, Groq, etc.)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { HmemStore } from "./hmem-store.js";
import { HmemConfig } from "./hmem-config.js";

// ── Tool schemas (shared between providers) ──────────────────────────────────

const TOOL_SCHEMAS: Record<string, object> = {
  read_memory: {
    type: "object",
    properties: {
      id: { type: "string", description: "Node ID, e.g. 'P0048' or 'O0048.3'" },
      search: { type: "string", description: "Full-text search query" },
      prefix: { type: "string", description: "Filter by category prefix (L, P, D, E, ...)" },
    },
  },
  write_memory: {
    type: "object",
    properties: {
      prefix: { type: "string", description: "Entry prefix: L, D, E, R, C" },
      content: { type: "string", description: "Title + optional body (tab-indented children)" },
      tags: { type: "array", items: { type: "string" }, description: "Hashtags, e.g. ['#hmem', '#bug']" },
      links: { type: "array", items: { type: "string" }, description: "Linked entry IDs" },
    },
    required: ["prefix", "content"],
  },
  update_memory: {
    type: "object",
    properties: {
      id: { type: "string", description: "Node ID to update" },
      content: { type: "string", description: "New content (replaces existing)" },
      tags: { type: "array", items: { type: "string" } },
      irrelevant: { type: "boolean" },
      favorite: { type: "boolean" },
    },
    required: ["id"],
  },
  append_memory: {
    type: "object",
    properties: {
      id: { type: "string", description: "Parent node ID" },
      content: { type: "string", description: "Child content (tab-indented for nesting)" },
    },
    required: ["id", "content"],
  },
  move_nodes: {
    type: "object",
    properties: {
      node_ids: { type: "array", items: { type: "string" }, description: "Exchange node IDs to move" },
      target_o_id: { type: "string", description: "Target O-entry ID, e.g. 'O0042'" },
    },
    required: ["node_ids", "target_o_id"],
  },
  list_projects: {
    type: "object",
    properties: {},
  },
};

// ── Tool executor ─────────────────────────────────────────────────────────────

function executeTool(name: string, input: Record<string, unknown>, store: HmemStore): string {
  try {
    switch (name) {
      case "read_memory": {
        const { id, search, prefix } = input as { id?: string; search?: string; prefix?: string };
        const entries = store.read({ id, search, prefix, depth: 3 });
        if (!entries.length) return "No results found.";
        return entries.slice(0, 20).map(e => `${e.id}  ${e.level_1 ?? ""}${e.level_2 ? "\n  " + e.level_2 : ""}`).join("\n");
      }
      case "write_memory": {
        const { prefix, content, tags, links } = input as { prefix: string; content: string; tags?: string[]; links?: string[] };
        const result = store.write(prefix, content as string, links, undefined, undefined, tags);
        return `Created: ${result.id}`;
      }
      case "update_memory": {
        const { id, content, tags, irrelevant, favorite } = input as { id: string; content?: string; tags?: string[]; irrelevant?: boolean; favorite?: boolean };
        const ok = store.updateNode(id as string, content, undefined, undefined, favorite, undefined, irrelevant, tags);
        return ok ? `Updated: ${id}` : `Not found: ${id}`;
      }
      case "append_memory": {
        const { id, content } = input as { id: string; content: string };
        const result = store.appendChildren(id as string, content as string);
        return `Appended ${result.count} node(s): ${result.ids.join(", ")}`;
      }
      case "move_nodes": {
        const { node_ids, target_o_id } = input as { node_ids: string[]; target_o_id: string };
        const result = store.moveNodes(node_ids as string[], target_o_id as string);
        return `Moved ${result.moved}. Errors: ${result.errors.join(", ") || "none"}`;
      }
      case "list_projects": {
        const projects = store.listProjects();
        return projects.map(p => `  ${p.id}  ${p.title}`).join("\n");
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e: any) {
    return `Error: ${e?.message ?? String(e)}`;
  }
}

// ── Anthropic loop ────────────────────────────────────────────────────────────

async function runAnthropicLoop(prompt: string, store: HmemStore, config: HmemConfig): Promise<void> {
  const apiKeyEnv = config.checkpointApiKeyEnv ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`Missing env var: ${apiKeyEnv}`);

  const client = new Anthropic({ apiKey });

  const tools: Anthropic.Tool[] = Object.entries(TOOL_SCHEMAS).map(([name, schema]) => ({
    name,
    description: `hmem ${name}`,
    input_schema: schema as Anthropic.Tool["input_schema"],
  }));

  type Msg = Anthropic.MessageParam;
  const messages: Msg[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < 40; i++) {
    const response = await client.messages.create({
      model: config.checkpointModel,
      max_tokens: 4096,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") break;

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) break;

    const results: Anthropic.ToolResultBlockParam[] = toolUses.map(block => ({
      type: "tool_result" as const,
      tool_use_id: block.id,
      content: executeTool(block.name, block.input as Record<string, unknown>, store),
    }));

    messages.push({ role: "user", content: results });
  }
}

// ── OpenAI-compatible loop ────────────────────────────────────────────────────

async function runOpenAILoop(prompt: string, store: HmemStore, config: HmemConfig): Promise<void> {
  const apiKeyEnv = config.checkpointApiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`Missing env var: ${apiKeyEnv}`);

  const client = new OpenAI({
    apiKey,
    ...(config.checkpointBaseUrl ? { baseURL: config.checkpointBaseUrl } : {}),
  });

  const tools: OpenAI.ChatCompletionTool[] = Object.entries(TOOL_SCHEMAS).map(([name, schema]) => ({
    type: "function" as const,
    function: { name, description: `hmem ${name}`, parameters: schema as OpenAI.FunctionParameters },
  }));

  type Msg = OpenAI.ChatCompletionMessageParam;
  const messages: Msg[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < 40; i++) {
    const response = await client.chat.completions.create({
      model: config.checkpointModel,
      tools,
      messages,
    });

    const choice = response.choices[0];
    if (!choice) break;

    messages.push(choice.message);

    if (choice.finish_reason === "stop" || !choice.message.tool_calls?.length) break;

    for (const call of choice.message.tool_calls) {
      if (!("function" in call)) continue;
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(call.function.arguments); } catch {}
      const result = executeTool(call.function.name, input, store);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
}

// ── claude -p subprocess fallback (for Max/OAuth users without API key) ────────

export function buildMcpConfig(projectDir: string, hmemPath: string): string {
  let hmemServerPath: string;
  try {
    hmemServerPath = execSync("which hmem", { encoding: "utf8" }).trim();
    const realPath = fs.realpathSync(hmemServerPath);
    hmemServerPath = path.join(path.dirname(realPath), "mcp-server.js");
    if (!fs.existsSync(hmemServerPath)) {
      hmemServerPath = path.join(path.dirname(path.dirname(realPath)), "dist", "mcp-server.js");
    }
  } catch {
    hmemServerPath = path.join(
      process.env.HOME || "/home",
      ".nvm/versions/node", process.version,
      "lib/node_modules/hmem-mcp/dist/mcp-server.js"
    );
  }

  const mcpConfig = {
    mcpServers: {
      hmem: {
        command: process.execPath,
        args: [hmemServerPath],
        env: { HMEM_PROJECT_DIR: projectDir, HMEM_PATH: hmemPath, HMEM_NO_SESSION: "1" },
      },
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-checkpoint-"));
  fs.chmodSync(tmpDir, 0o700);
  const tmpPath = path.join(tmpDir, "mcp-config.json");
  fs.writeFileSync(tmpPath, JSON.stringify(mcpConfig), "utf8");
  return tmpPath;
}

async function runClaudeSubprocess(prompt: string, hmemPath: string, model: string): Promise<void> {
  const projectDir = path.dirname(hmemPath);
  const mcpConfigPath = buildMcpConfig(projectDir, hmemPath);
  try {
    execFileSync("claude", [
      "-p", "--model", model,
      "--mcp-config", mcpConfigPath,
      "--allowedTools", "mcp__hmem__update_memory mcp__hmem__write_memory mcp__hmem__append_memory mcp__hmem__read_memory mcp__hmem__move_nodes mcp__hmem__list_projects",
      "--dangerously-skip-permissions",
    ], { input: prompt, encoding: "utf8", timeout: 120_000 });
  } finally {
    try { fs.unlinkSync(mcpConfigPath); } catch {}
    try { fs.rmdirSync(path.dirname(mcpConfigPath)); } catch {}
  }
}

export function hasClaudeBinary(): boolean {
  try { execSync("which claude", { stdio: "ignore" }); return true; } catch { return false; }
}

// ── Harness detection ─────────────────────────────────────────────────────────

export type Harness = "claude-code" | "codex" | "opencode" | "pi" | "hermes" | "unknown";

/**
 * Detect which AI harness invoked us. Honors explicit HMEM_HARNESS override first
 * (plugins/extensions should set this when they spawn `hmem checkpoint`); falls
 * back to env-var signatures the harnesses set themselves.
 */
export function detectHarness(): Harness {
  const explicit = process.env.HMEM_HARNESS?.toLowerCase();
  if (explicit === "claude-code" || explicit === "codex" || explicit === "opencode" ||
      explicit === "pi" || explicit === "hermes") {
    return explicit;
  }
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) return "claude-code";
  if (process.env.CODEX_SESSION_ID || process.env.CODEX_API_KEY) return "codex";
  return "unknown";
}

// ── Free-path predicate ───────────────────────────────────────────────────────

/**
 * Probes that can be injected in tests to avoid spawning subprocesses or
 * reading ambient env. Defaults to the real implementations.
 */
export interface ExtractionPathProbes {
  detectHarness?: () => Harness;
  hasClaudeBinary?: () => boolean;
}

/**
 * Returns `true` iff the auto-checkpoint LLM extraction would run via a FREE
 * route — that is, the Claude Code Max/OAuth `claude -p` subprocess (route 1 or
 * route 4 in the routing ladder). Returns `false` for every METERED route
 * (Anthropic SDK, OpenAI/codex SDK).
 *
 * Mirrors `runCheckpointAgent`'s own ladder in the same precedence order so
 * the two can never disagree:
 *   1. claude-code harness + claude binary → true (free)
 *   2. codex harness → false (OpenAI metered, unconditional)
 *   3. resolved API key env var is set → false (SDK metered)
 *   4. claude binary on PATH (last-resort OAuth) → true (free)
 *   5. → false (no usable route)
 *
 * NOTE: This predicate does not check whether `hmemPath` is available.
 * Routes 1 and 4 also require `hmemPath` at runtime; treat that as a separate
 * caller concern — this predicate answers only "free vs metered".
 */
export function hasFreeExtractionPath(
  config: HmemConfig,
  probes: ExtractionPathProbes = {},
): boolean {
  const harness = (probes.detectHarness ?? detectHarness)();
  const claudeBinary = (probes.hasClaudeBinary ?? hasClaudeBinary)();

  // Route 1: Claude Code harness + claude binary → free
  if (harness === "claude-code" && claudeBinary) return true;

  // Route 2: Codex → OpenAI (always metered, no API key check needed)
  if (harness === "codex") return false;

  // Route 3: Configured SDK provider with API key → metered
  // Mirror the exact apiKeyEnv resolution from runCheckpointAgent lines 321-322
  const apiKeyEnv = config.checkpointApiKeyEnv
    ?? (config.checkpointProvider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  if (process.env[apiKeyEnv]) return false;

  // Route 4: Last-resort claude binary (zero-config Max OAuth) → free
  if (claudeBinary) return true;

  // No usable route
  return false;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Harness-aware provider routing:
 *   - Claude Code → Haiku via `claude -p` subprocess (uses Max OAuth, no API key)
 *   - Codex      → gpt-5.4-mini via OpenAI API (uses OPENAI_API_KEY)
 *   - OpenCode / Pi / Hermes / unknown → user's configured provider (hmem.config.json)
 *
 * The harness routing takes precedence over the configured provider — Claude Code
 * users explicitly want Haiku-via-OAuth (covered by Max), not their DeepSeek key.
 */
export async function runCheckpointAgent(
  prompt: string,
  store: HmemStore,
  config: HmemConfig,
  hmemPath?: string,
): Promise<void> {
  const harness = detectHarness();
  console.error(`[hmem checkpoint] harness=${harness} hmemPath=${hmemPath ? "set" : "unset"} claudeBin=${hasClaudeBinary()}`);

  // 1. Claude Code → Haiku via `claude -p` (Max OAuth, no API key needed)
  if (harness === "claude-code" && hmemPath && hasClaudeBinary()) {
    console.error(`[hmem checkpoint] → routing to claude -p (Haiku via Max OAuth)`);
    store.close();
    await runClaudeSubprocess(prompt, hmemPath, "claude-haiku-4-5-20251001");
    return;
  }

  // 2. Codex → gpt-5.4-mini via OpenAI API
  if (harness === "codex") {
    const codexConfig: HmemConfig = {
      ...config,
      checkpointProvider: "openai",
      checkpointModel: "gpt-5.4-mini",
      checkpointApiKeyEnv: "OPENAI_API_KEY",
      checkpointBaseUrl: undefined,
    };
    await runOpenAILoop(prompt, store, codexConfig);
    return;
  }

  // 3. OpenCode / Pi / Hermes / unknown → user's configured provider
  const apiKeyEnv = config.checkpointApiKeyEnv
    ?? (config.checkpointProvider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  const apiKey = process.env[apiKeyEnv];

  if (apiKey) {
    console.error(`[hmem checkpoint] → routing to ${config.checkpointProvider} API (${config.checkpointModel})`);
    if (config.checkpointProvider === "openai") {
      await runOpenAILoop(prompt, store, config);
    } else {
      await runAnthropicLoop(prompt, store, config);
    }
    return;
  }

  // 4. Last-resort: claude -p subprocess if Claude binary is on PATH (zero-config Claude Max)
  if (hmemPath && hasClaudeBinary()) {
    store.close();
    await runClaudeSubprocess(prompt, hmemPath, config.checkpointModel);
    return;
  }

  throw new Error(
    `[hmem checkpoint] No checkpoint provider available for harness=${harness}.\n` +
    "Configure one in hmem.config.json → memory:\n" +
    '  "checkpointProvider": "anthropic"  (or "openai")\n' +
    '  "checkpointModel": "claude-haiku-4-5-20251001"\n' +
    '  "checkpointApiKeyEnv": "ANTHROPIC_API_KEY"  (env var name holding your key)\n' +
    "Or install `claude` CLI for the Claude Max zero-config fallback."
  );
}

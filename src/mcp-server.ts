#!/usr/bin/env node
/**
 * hmem — Hierarchical Memory MCP Server.
 *
 * Provides persistent, hierarchical memory for AI agents via MCP.
 * Also bundles Das Althing orchestrator tools (spawn_agent, etc.) —
 * these are inactive if you're not running the Das Althing orchestrator.
 *
 * Environment variables:
 *   HMEM_PROJECT_DIR         — Root directory where .hmem files are stored (required)
 *   HMEM_AGENT_ID            — Agent identifier (optional; defaults to memory.hmem)
 *   HMEM_AGENT_ROLE          — Role: worker | al | pl | ceo (default: worker)
 *
 * Legacy fallbacks (Das Althing):
 *   COUNCIL_PROJECT_DIR, COUNCIL_AGENT_ID, COUNCIL_AGENT_ROLE
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadCatalog } from "./config.js";
import { validateRequest } from "./json-parser.js";
import { searchMemory } from "./memory-search.js";
import { openAgentMemory, openCompanyMemory, resolveHmemPath, HmemStore } from "./hmem-store.js";
import type { AgentRole, MemoryNode } from "./hmem-store.js";
import type { AgentRequest, AgentCatalog, OrchestratorState } from "./types.js";

// ---- Environment ----
// HMEM_* vars are the canonical names; COUNCIL_* kept for backwards compatibility
const PROJECT_DIR = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR || "";

if (!PROJECT_DIR) {
  console.error("FATAL: HMEM_PROJECT_DIR not set");
  process.exit(1);
}

// Empty string → resolveHmemPath uses memory.hmem (no agent name required)
let AGENT_ID = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
let DEPTH = parseInt(process.env.HMEM_DEPTH || process.env.COUNCIL_DEPTH || "0", 10);
let ROLE = process.env.HMEM_AGENT_ROLE || process.env.COUNCIL_AGENT_ROLE || "worker";

const ppid = process.ppid;
const ctxFile = path.join(PROJECT_DIR, "orchestrator", ".mcp_contexts", `${ppid}.json`);
try {
  if (fs.existsSync(ctxFile)) {
    const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf-8"));
    AGENT_ID = ctx.agent_id || AGENT_ID;
    DEPTH = ctx.depth ?? DEPTH;
    ROLE = ctx.role || ROLE;
  }
} catch {
  // Fallback to env vars
}

function log(msg: string) {
  console.error(`[MCP:${AGENT_ID}] ${msg}`);
}

// Load catalog once at startup
let catalog: AgentCatalog;
try {
  catalog = loadCatalog(PROJECT_DIR);
  log(`Catalog loaded: ${Object.keys(catalog).length} templates`);
} catch (e) {
  console.error(`FATAL: Cannot load catalog: ${e}`);
  process.exit(1);
}

// Logger stub for validateRequest()
const validationLog = {
  info: (msg: string) => log(`[validate] ${msg}`),
  warn: (msg: string) => log(`[validate:WARN] ${msg}`),
  error: (msg: string) => log(`[validate:ERROR] ${msg}`),
  action: (msg: string) => log(`[validate] ${msg}`),
  debug: (_msg: string) => {},
} as any;

const MAX_SPAWN_DEPTH = parseInt(process.env.HMEM_MAX_SPAWN_DEPTH || process.env.COUNCIL_MAX_SPAWN_DEPTH || "3", 10);

// ---- Helper: Read agent.json for a template ----
function readAgentJson(templateName: string): { model?: string; tool?: string } {
  // Check Agents/{templateName}/agent.json
  let agentJsonPath = path.join(PROJECT_DIR, "Agents", templateName, "agent.json");

  if (!fs.existsSync(agentJsonPath)) {
    // Check Assistenten/{templateName}/agent.json
    agentJsonPath = path.join(PROJECT_DIR, "Assistenten", templateName, "agent.json");
  }

  if (!fs.existsSync(agentJsonPath)) {
    // No agent.json found — system template, return empty
    return {};
  }

  try {
    const data = JSON.parse(fs.readFileSync(agentJsonPath, "utf-8"));
    return {
      model: data.model,
      tool: data.tool,
    };
  } catch (e) {
    log(`Failed to read agent.json for template "${templateName}": ${e}`);
    return {};
  }
}

// ---- Server ----
const server = new McpServer({
  name: "hmem",
  version: "1.0.0",
});

// ---- Tool: spawn_agent ----
server.tool(
  "spawn_agent",
  "Spawn a sub-agent via the Das Althing orchestrator. " +
    "Creates a REQ_*.json file that the orchestrator picks up and launches as a CLI process. " +
    "Returns immediate feedback (success or validation error). " +
    "Do NOT wait for the result — the orchestrator will notify you when children complete.",
  {
    Template: z.string().describe(
      "Agent template from AGENT_CATALOG.json (e.g. 'coder', 'coder_fast', 'reviewer', 'architect')"
    ),
    Agent_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .describe("Unique identifier (A-Z, 0-9, _, -). Used in filenames."),
    Command: z
      .string()
      .min(1)
      .max(50_000)
      .describe(
        "Full task description. Output path is set automatically by the orchestrator."
      ),
    Model: z
      .string()
      .optional()
      .describe("Optional model override (opus, sonnet, haiku, gemini-pro, gemini-flash)"),
    Tool: z
      .enum(["opencode", "opencode-run", "gemini-cli", "claude", "ollama"])
      .optional()
      .describe("Optional tool override. Default comes from template."),
    Cwd: z
      .string()
      .optional()
      .describe(
        "Optional working directory relative to project root (e.g. 'Projects/P3_Council_Dashboard_PL/02_Execution_AL'). " +
        "Agent runs and writes output here. Default: project root."
      ),
  },
  async ({ Template, Agent_ID, Command, Model, Tool, Cwd: cwdParam }) => {
    // 0. Worker spawn block: Workers are not allowed to spawn sub-agents
    if (ROLE === "worker") {
      log(`spawn_agent BLOCKED: Worker ${AGENT_ID} is not allowed to spawn sub-agents`);
      return {
        content: [
          {
            type: "text" as const,
            text: "ERROR: Workers are not allowed to spawn sub-agents. You are a worker — execute your task yourself. If you need help, write a question (Status: Question) in your output.",
          },
        ],
        isError: true,
      };
    }

    // 1. Validate template
    if (!catalog[Template]) {
      const available = Object.keys(catalog).slice(0, 20).join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `ERROR: Template "${Template}" not found. Available: ${available}...`,
          },
        ],
        isError: true,
      };
    }

    // 2. Build AgentRequest
    const childDepth = DEPTH + 1;
    const tpl = catalog[Template];

    // Read model and tool from agent.json (if exists)
    const agentJson = readAgentJson(Template);

    const req: AgentRequest = {
      Type: "LAUNCH_AGENT",
      Template,
      Agent_ID,
      Command,
      Depth: childDepth,
      SpawnedBy: AGENT_ID,
      ReportTo: AGENT_ID,
      Request_ID: Agent_ID,
      Cwd: cwdParam ? path.join(PROJECT_DIR, cwdParam) : PROJECT_DIR,
      Terminate_After: tpl.Terminate_After ?? true,
      Tool: (Tool || agentJson.tool || tpl.Tool || "opencode") as any,
      Role: (tpl as any).Role || "worker",
    };
    if (Model) req.Model = Model;
    else if (agentJson.model) req.Model = agentJson.model;
    else if (tpl.Model) req.Model = tpl.Model;

    // 3. Validate (Agent_ID, tool whitelist, depth, command length)
    if (!validateRequest(req, MAX_SPAWN_DEPTH, validationLog)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `ERROR: Validation failed. Depth=${childDepth} (max=${MAX_SPAWN_DEPTH}), Agent_ID="${Agent_ID}". Details in stderr.`,
          },
        ],
        isError: true,
      };
    }

    // 4. Write REQ file (atomic: tmp + rename)
    const resolvedCwd = cwdParam ? path.join(PROJECT_DIR, cwdParam) : PROJECT_DIR;
    if (!fs.existsSync(resolvedCwd)) {
      fs.mkdirSync(resolvedCwd, { recursive: true });
    }
    const reqFileName = `REQ_${Agent_ID}.json`;
    const reqFilePath = path.join(resolvedCwd, reqFileName);
    const tmpPath = reqFilePath + `.${crypto.randomBytes(4).toString("hex")}.tmp`;

    try {
      fs.writeFileSync(tmpPath, JSON.stringify(req, null, 2), "utf-8");
      fs.renameSync(tmpPath, reqFilePath);
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      return {
        content: [
          {
            type: "text" as const,
            text: `ERROR: Could not write ${reqFileName}: ${e}`,
          },
        ],
        isError: true,
      };
    }

    log(`spawn_agent: ${reqFileName} (Template=${Template}, Depth=${childDepth}, SpawnedBy=${AGENT_ID})`);

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Agent spawned successfully.`,
            `  Request_ID: ${Agent_ID}`,
            `  Template: ${Template}`,
            `  Depth: ${childDepth}`,
            `  SpawnedBy: ${AGENT_ID}`,
            `  REQ file: ${reqFileName}`,
            `  Output expected at: ${cwdParam || '.'}/${Agent_ID}_OUTPUT.md`,
            `  Working directory: ${cwdParam || '(project root)'}`,
            ``,
            `The orchestrator will process the request and start the agent.`,
            `Do NOT wait for the result — write your output and finish.`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ---- Tool: list_templates ----
server.tool(
  "list_templates",
  "List available agent templates from AGENT_CATALOG.json with descriptions and configuration.",
  {
    category: z
      .string()
      .optional()
      .describe("Optional filter keyword (e.g. 'code', 'review', 'test', 'architect'). All if omitted."),
  },
  async ({ category }) => {
    // Reload catalog on each call (catches changes)
    let currentCatalog: AgentCatalog;
    try {
      currentCatalog = loadCatalog(PROJECT_DIR);
    } catch {
      currentCatalog = catalog;
    }

    let entries = Object.entries(currentCatalog)
      .filter(([_, entry]) => !(entry as any).Internal);  // Hide meta agents

    if (category) {
      const filter = category.toLowerCase();
      entries = entries.filter(
        ([name, entry]) =>
          name.toLowerCase().includes(filter) ||
          (entry.Description || "").toLowerCase().includes(filter)
      );
    }

    if (entries.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No templates found${category ? ` for "${category}"` : ""}. Total: ${Object.keys(currentCatalog).length}`,
          },
        ],
      };
    }

    const lines = entries.map(([name, entry]) => {
      const parts = [`- **${name}**`];
      // Agent Directory format: Name, Department, Specializations — NO Model/Tool
      if ((entry as any).Department) {
        parts.push(` (${(entry as any).Department})`);
      }
      if ((entry as any).Specializations?.length) {
        parts.push(`: ${(entry as any).Specializations.join(", ")}`);
      } else if (entry.Description) {
        parts.push(`: ${entry.Description}`);
      }
      // Show costs (for budget planning), but NOT Model/Tool
      if ((entry as any).Cost_Per_Min_USD != null) {
        parts.push(`  |  ~$${(entry as any).Cost_Per_Min_USD}/Min`);
      }
      if (entry.Role) parts.push(`  [${entry.Role.toUpperCase()}]`);
      return parts.join("");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Agent Directory (${entries.length} agents):\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

// ---- Tool: get_budget_status ----
server.tool(
  "get_budget_status",
  "Shows budget status: cost per agent, total spent, broken down by model. Use project_prefix to filter costs for a specific project.",
  {
    project_prefix: z
      .string()
      .optional()
      .describe("Filter Agent-IDs by prefix (e.g. 'P3_'). Empty = all costs."),
  },
  async ({ project_prefix }) => {
    const costFile = path.join(PROJECT_DIR, "orchestrator", "logs", "cost_tracking.jsonl");
    if (!fs.existsSync(costFile)) {
      return {
        content: [{ type: "text" as const, text: "No cost data available." }],
      };
    }

    const lines = fs.readFileSync(costFile, "utf-8").trim().split("\n");
    const byAgent: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    let totalCost = 0;
    let totalRuns = 0;

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (project_prefix && !entry.agent_id.startsWith(project_prefix)) continue;
        const cost = entry.estimated_cost_usd || 0;
        totalCost += cost;
        totalRuns++;
        byAgent[entry.agent_id] = (byAgent[entry.agent_id] || 0) + cost;
        byModel[entry.model] = (byModel[entry.model] || 0) + cost;
      } catch { /* skip */ }
    }

    const agentLines = Object.entries(byAgent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id, cost]) => `  ${id}: $${cost.toFixed(4)}`);

    const modelLines = Object.entries(byModel)
      .sort((a, b) => b[1] - a[1])
      .map(([model, cost]) => `  ${model}: $${cost.toFixed(4)}`);

    const text = [
      `Budget status${project_prefix ? ` (Prefix: ${project_prefix})` : " (total)"}:`,
      ``,
      `Total cost: $${totalCost.toFixed(4)}  (${totalRuns} agent runs)`,
      ``,
      `Top agents:`,
      ...agentLines,
      ``,
      `By model:`,
      ...modelLines,
    ].join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ---- Tool: get_agent_status ----
server.tool(
  "get_agent_status",
  "Check the status of a spawned agent by looking for its output file.",
  {
    agent_id: z.string().describe("The Agent_ID of the agent to check"),
    include_preview: z
      .boolean()
      .optional()
      .describe("If true, include first 500 chars of output. Default: false."),
  },
  async ({ agent_id, include_preview }) => {
    // Look up agent's output directory from state.json
    let outputPath = "";
    const stateFile = path.join(PROJECT_DIR, "orchestrator", "state.json");
    if (fs.existsSync(stateFile)) {
      try {
        const state: OrchestratorState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        const agentState = state.agents.find((a) => a.id === agent_id);
        if (agentState?.outputDir) {
          outputPath = path.join(agentState.outputDir, `${agent_id}_OUTPUT.md`);
        }
      } catch { /* fallback below */ }
    }
    // Fallback: check project root directly
    if (!outputPath || !fs.existsSync(outputPath)) {
      outputPath = path.join(PROJECT_DIR, `${agent_id}_OUTPUT.md`);
    }

    if (!fs.existsSync(outputPath)) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Agent "${agent_id}": NO OUTPUT`,
              `  Expected file: ${agent_id}_OUTPUT.md`,
              `  Status: Agent has not written any output yet or has not been started.`,
            ].join("\n"),
          },
        ],
      };
    }

    const stat = fs.statSync(outputPath);

    if (stat.size === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Agent "${agent_id}": ACK (working)`,
              `  File exists but is empty (= agent has received the task).`,
              `  Status: Agent is working on the task.`,
            ].join("\n"),
          },
        ],
      };
    }

    const lines = [
      `Agent "${agent_id}": OUTPUT AVAILABLE`,
      `  File: ${path.relative(PROJECT_DIR, outputPath)}`,
      `  Size: ${stat.size} bytes`,
      `  Modified: ${stat.mtime.toISOString()}`,
      `  Status: Agent has written output.`,
    ];

    if (include_preview) {
      try {
        const content = fs.readFileSync(outputPath, "utf-8");
        const preview = content.slice(0, 500);
        lines.push(`\n--- Preview (first 500 characters) ---\n${preview}`);
        if (content.length > 500) lines.push(`\n... (${content.length - 500} more characters)`);
      } catch {
        lines.push(`\n(File could not be read)`);
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
      ],
    };
  }
);

// ---- Tool: send_message ----
server.tool(
  "send_message",
  "Send a message to another agent via a MSG file. " +
    "The recipient can read it from their working directory. The orchestrator's MsgRouter will log it.",
  {
    recipient_agent_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .describe("Agent_ID of the recipient"),
    message: z
      .string()
      .min(1)
      .max(50_000)
      .describe("Message content (markdown)"),
  },
  async ({ recipient_agent_id, message }) => {
    const ts = Date.now();
    const msgFileName = `MSG_${ts}_${AGENT_ID}_TO_${recipient_agent_id}.md`;
    const msgFilePath = path.join(PROJECT_DIR, msgFileName);

    try {
      fs.writeFileSync(
        msgFilePath,
        `# Message from ${AGENT_ID} to ${recipient_agent_id}\n\n${message}\n`,
        "utf-8"
      );
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `ERROR: Could not write message: ${e}`,
          },
        ],
        isError: true,
      };
    }

    log(`send_message: ${msgFileName}`);

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Message sent.`,
            `  From: ${AGENT_ID}`,
            `  To: ${recipient_agent_id}`,
            `  File: ${msgFileName}`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ---- Tool: get_all_agents ----
server.tool(
  "get_all_agents",
  "Get the status of all agents currently tracked by the orchestrator. " +
    "Reads from orchestrator/state.json (written by the orchestrator each tick).",
  {
    status_filter: z
      .enum(["busy", "idle", "delegating", "offline"])
      .optional()
      .describe("Optional: Only show agents with this status."),
  },
  async ({ status_filter }) => {
    const stateFile = path.join(PROJECT_DIR, "orchestrator", "state.json");

    if (!fs.existsSync(stateFile)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No state available (orchestrator/state.json does not exist). Orchestrator may not be running yet or has not executed a tick yet.",
          },
        ],
      };
    }

    let state: OrchestratorState;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `ERROR: Could not read state.json: ${e}`,
          },
        ],
        isError: true,
      };
    }

    let agents = state.agents;
    if (status_filter) {
      agents = agents.filter((a) => a.status === status_filter);
    }

    if (agents.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No agents found${status_filter ? ` with status "${status_filter}"` : ""}. (State from ${state.timestamp})`,
          },
        ],
      };
    }

    const lines = agents.map((a) => {
      const elapsed = a.busySince ? Math.round((Date.now() - a.busySince) / 1000) : 0;
      return [
        `- **${a.id}** [${a.status}]`,
        `  Tool: ${a.tool}, Model: ${a.model || "-"}, PID: ${a.pid || "-"}`,
        `  Depth: ${a.depth}, SpawnedBy: ${a.spawnedBy || "-"}`,
        a.busySince ? `  Runtime: ${elapsed}s` : "",
        a.childAgentIds.length > 0 ? `  Children: ${a.childAgentIds.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Agents (${agents.length}${status_filter ? `, Filter: ${status_filter}` : ""}, As of: ${state.timestamp}):\n\n${lines.join("\n\n")}`,
        },
      ],
    };
  }
);

// ---- Tool: cancel_agent ----
server.tool(
  "cancel_agent",
  "Cancel a running child agent. Sends SIGTERM to the agent's process. " +
    "Only the spawning parent agent can cancel its children.",
  {
    agent_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .describe("Agent_ID of the agent to cancel"),
    reason: z
      .string()
      .max(1000)
      .optional()
      .describe("Optional reason for cancellation"),
  },
  async ({ agent_id, reason }) => {
    // 1. Load state
    const stateFile = path.join(PROJECT_DIR, "orchestrator", "state.json");
    if (!fs.existsSync(stateFile)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "ERROR: state.json not found — orchestrator may not be running.",
          },
        ],
        isError: true,
      };
    }

    let state: OrchestratorState;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `ERROR: state.json not readable: ${e}`,
          },
        ],
        isError: true,
      };
    }

    // 2. Find target agent
    const target = state.agents.find((a) => a.id === agent_id);
    if (!target) {
      return {
        content: [
          {
            type: "text" as const,
            text: `ERROR: Agent "${agent_id}" not found in state.`,
          },
        ],
        isError: true,
      };
    }

    // 3. Check permission: Only parent may cancel
    if (target.spawnedBy !== AGENT_ID) {
      return {
        content: [
          {
            type: "text" as const,
            text: `ERROR: No permission. "${agent_id}" was spawned by "${target.spawnedBy}", not by you (${AGENT_ID}).`,
          },
        ],
        isError: true,
      };
    }

    // 4. Agent already offline?
    if (target.status === "offline") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Agent "${agent_id}" is already offline. No cancellation needed.`,
          },
        ],
      };
    }

    // 5. Send SIGTERM
    let killed = false;
    if (target.pid > 0) {
      try {
        process.kill(target.pid, "SIGTERM");
        killed = true;
      } catch {
        // Process no longer exists
      }
    }

    // 6. Write CANCELLED file (in agent's output directory or project root)
    let cancelDir = PROJECT_DIR;
    if (fs.existsSync(stateFile)) {
      try {
        const freshState: OrchestratorState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        const agentState = freshState.agents.find((a) => a.id === agent_id);
        if (agentState?.outputDir) cancelDir = agentState.outputDir;
      } catch { /* use PROJECT_DIR */ }
    }
    const cancelFile = path.join(cancelDir, `${target.currentRequestId}_CANCELLED.md`);
    const cancelContent = [
      `# Agent cancelled: ${agent_id}`,
      ``,
      `**Cancelled by:** ${AGENT_ID}`,
      `**Reason:** ${reason || "No reason given"}`,
      `**Timestamp:** ${new Date().toISOString()}`,
      `**PID:** ${target.pid}`,
      `**Signal sent:** ${killed ? "Yes (SIGTERM)" : "No (process not found)"}`,
      ``,
      `**Status**: Cancelled`,
    ].join("\n");

    try {
      fs.writeFileSync(cancelFile, cancelContent, "utf-8");
    } catch {
      // Best effort
    }

    log(`cancel_agent: ${agent_id} (PID=${target.pid}, killed=${killed}, by=${AGENT_ID})`);

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Agent "${agent_id}" cancelled.`,
            `  PID: ${target.pid}`,
            `  SIGTERM: ${killed ? "sent" : "process not found"}`,
            `  Cancel file: ${target.currentRequestId}_CANCELLED.md`,
            reason ? `  Reason: ${reason}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  }
);

// ---- Tool: suggest_brainstorm_team ----
server.tool(
  "suggest_brainstorm_team",
  "Suggests a cross-departmental brainstorming team. " +
    "Selects agents from different departments based on the topic. " +
    "These agents can later take on the corresponding tasks in the execution phase.",
  {
    topic: z.string().min(3).describe(
      "Project description or brainstorming topic (e.g. 'E-Commerce portal with payment integration')"
    ),
    team_size: z
      .number()
      .int()
      .min(3)
      .max(10)
      .optional()
      .describe("Desired team size (default: 6)"),
  },
  async ({ topic, team_size }) => {
    const teamSize = team_size || 6;
    log(`suggest_brainstorm_team: topic="${topic}", size=${teamSize}, by=${AGENT_ID}`);

    // Reload catalog (may have changed)
    let freshCatalog: AgentCatalog;
    try {
      freshCatalog = loadCatalog(PROJECT_DIR);
    } catch {
      freshCatalog = catalog;
    }

    // Extract keywords from topic
    const stopwords = new Set([
      "der", "die", "das", "ein", "eine", "und", "oder", "in", "von", "zu",
      "mit", "auf", "fuer", "ist", "sind", "the", "a", "an", "and", "or",
      "for", "with", "to", "of", "we", "wir", "soll", "muss", "kann",
    ]);
    const keywords = topic
      .toLowerCase()
      .replace(/[^a-z0-9äöüß-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopwords.has(w));

    // Score candidates: only non-internal workers + department leads
    interface Candidate {
      id: string;
      name: string;
      department: string;
      specializations: string[];
      role: string;
      cost: number;
      score: number;
    }

    const candidates: Candidate[] = [];

    for (const [id, entry] of Object.entries(freshCatalog)) {
      if ((entry as any).Internal) continue;
      const role = (entry as any).Role || "worker";
      if (role === "ceo" || role === "pl") continue; // PLs/CEO not in brainstorming
      if (id.startsWith("_")) continue; // Metadata

      const specs = ((entry as any).Specializations || []).join(" ").toLowerCase();
      const dept = ((entry as any).Department || "").toLowerCase();
      const name = (entry as any).Name || id;

      // Scoring: Keywords against specializations and department
      let score = 0;
      for (const kw of keywords) {
        if (specs.includes(kw)) score += 2;
        if (dept.includes(kw)) score += 1;
      }
      // Worker bonus: Brainstorming agents should later work on the project
      // Workers are the executors, department leads are only coordinators
      if (role === "worker") score += 0.5;
      // Base score so all agents have a chance even with 0 keyword matches
      score += 0.1;

      candidates.push({
        id,
        name,
        department: (entry as any).Department || "Unknown",
        specializations: (entry as any).Specializations || [],
        role,
        cost: (entry as any).Cost_Per_Min_USD || 0.05,
        score,
      });
    }

    // Sort by score
    candidates.sort((a, b) => b.score - a.score);

    // Greedy selection with department diversity
    const selected: Candidate[] = [];
    const usedDepts = new Set<string>();
    const remaining = [...candidates];

    while (selected.length < teamSize && remaining.length > 0) {
      // Prefer agents from departments not yet represented
      const idx = remaining.findIndex((c) => !usedDepts.has(c.department));
      const pick = idx >= 0 ? remaining.splice(idx, 1)[0] : remaining.shift()!;
      selected.push(pick);
      usedDepts.add(pick.department);
    }

    if (selected.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No suitable agents found in the catalog.",
        }],
        isError: true,
      };
    }

    // Derive perspective from specialization
    function derivePerspective(c: Candidate): string {
      const dept = c.department.toLowerCase();
      if (dept.includes("backend")) return "Technical feasibility, API design, data model";
      if (dept.includes("frontend")) return "User experience, UI structure, interaction patterns";
      if (dept.includes("qa") || dept.includes("test")) return "Risks, edge cases, testability";
      if (dept.includes("security")) return "Security, authentication, attack vectors";
      if (dept.includes("operations") || dept.includes("devops")) return "Deployment, infrastructure, scaling";
      if (dept.includes("doku") || dept.includes("research")) return "User perspective, clarity, research";
      if (dept.includes("architektur")) return "System design, trade-offs, scaling";
      if (dept.includes("visualis")) return "Diagrams, presentation, information architecture";
      if (dept.includes("analyse")) return "Data analysis, metrics, feasibility";
      if (dept.includes("fullstack") || dept.includes("integration")) return "End-to-end perspective, interfaces";
      if (dept.includes("performance")) return "Performance, optimization, bottlenecks";
      if (dept.includes("experimental")) return "Unconventional ideas, creativity, moonshots";
      return c.specializations.slice(0, 2).join(", ") || "General perspective";
    }

    // Format output
    const rows = selected
      .map((c, i) => {
        const perspective = derivePerspective(c);
        const roleTag = c.role === "al" ? " [AL]" : "";
        return `| ${i + 1} | **${c.id}** | ${c.department}${roleTag} | ${perspective} | ~$${c.cost}/Min |`;
      })
      .join("\n");

    const totalCost = selected.reduce((sum, c) => sum + c.cost, 0);

    const output = [
      `## Brainstorming team for: "${topic}"`,
      ``,
      `| # | Agent | Department | Perspective | ~Cost/Min |`,
      `|---|-------|------------|-------------|-----------|`,
      rows,
      ``,
      `**Team cost:** ~$${totalCost.toFixed(2)}/min total (${selected.length} agents)`,
      `**Departments:** ${Array.from(usedDepts).join(", ")}`,
      ``,
      `> **Note:** These agents can later take on the corresponding tasks in the`,
      `> execution phase — they already gather domain knowledge about the project`,
      `> during brainstorming.`,
    ].join("\n");

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
);

// ---- Tool: search_memory ----
server.tool(
  "search_memory",
  "Searches the collective memory of the Council: agent memories (lessons learned, " +
    "evaluations), personalities, project documentation, and skills. " +
    "Use this tool to learn from past experiences before starting a task.",
  {
    query: z.string().min(2).describe(
      "Search terms (e.g. 'Node.js performance error', 'frontend testing strategy')"
    ),
    scope: z
      .enum(["memories", "personalities", "projects", "skills", "all"])
      .optional()
      .describe(
        "Limit search scope: 'memories' = agent .hmem databases, 'personalities' = agent roles, " +
          "'projects' = project docs, 'skills' = skill references, 'all' = everything (default)"
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Max results (default: 10)"),
  },
  async ({ query, scope, max_results }) => {
    log(`search_memory: query="${query}", scope=${scope || "all"}, by=${AGENT_ID}`);

    const results = searchMemory(PROJECT_DIR, query, {
      scope: scope || "all",
      maxResults: max_results || 10,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No results for "${query}" (Scope: ${scope || "all"}).\n\nTip: Try more general terms or a different scope.`,
          },
        ],
      };
    }

    const output = results
      .map((r, i) => {
        const header = r.agent
          ? `### ${i + 1}. ${r.agent} — ${r.file} (Score: ${r.score})`
          : `### ${i + 1}. ${r.file} (Score: ${r.score})`;
        const excerpts = r.excerpts.map((e) => `> ${e.replace(/\n/g, "\n> ")}`).join("\n\n");
        return `${header}\n${excerpts}`;
      })
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `## Memory Search: "${query}"\n**${results.length} hits** (Scope: ${scope || "all"})\n\n${output}`,
        },
      ],
    };
  }
);

// ---- Hierarchical Memory (.hmem) ----

server.tool(
  "write_memory",
  "Write a new memory entry to your hierarchical long-term memory (.hmem). " +
    "Use tab indentation to create depth levels:\n" +
    "  Level 1: No indentation — the rough summary (always visible at startup)\n" +
    "  Level 2: 1 tab — more detail (loaded on demand)\n" +
    "  Level 3: 2 tabs — even more detail\n" +
    "  Level 4: 3 tabs — fine-grained detail\n" +
    "  Level 5: 4 tabs — raw context/data\n" +
    "The system auto-assigns an ID and timestamp. " +
    "Use prefix to categorize: P=Project, L=Lesson, T=Task, E=Error, D=Decision, M=Milestone, F=Favorite, S=Skill.\n\n" +
    "Store types:\n" +
    "  personal (default): Your private memory\n" +
    "  company: Shared knowledge base (FIRMENWISSEN) — requires AL+ role to write",
  {
    prefix: z.enum(["P", "L", "T", "E", "D", "M", "F", "S"]).describe(
      "Memory category: P=Project, L=Lesson, T=Task, E=Error, D=Decision, M=Milestone, F=Favorite, S=Skill"
    ),
    content: z.string().min(3).describe(
      "The memory content. Use tab indentation for depth levels. Example:\n" +
        "Built the Council Dashboard for Althing Inc.\n" +
        "\tMy role was frontend architecture with React + Vite\n" +
        "\t\tShadcnUI for components, SSE for real-time updates\n" +
        "\t\t\tAuth was tricky — EventSource can't send custom headers"
    ),
    links: z.array(z.string()).optional().describe(
      "Optional: IDs of related memories, e.g. ['P0001', 'L0005']"
    ),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Target store: 'personal' (your own memory) or 'company' (shared FIRMENWISSEN, AL+ only)"
    ),
    min_role: z.enum(["worker", "al", "pl", "ceo"]).default("worker").describe(
      "Minimum role to see this entry (company store only). 'worker' = everyone, 'al' = AL+PL+CEO, etc."
    ),
  },
  async ({ prefix, content, links, store: storeName, min_role: minRole }) => {
    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker") as AgentRole;
    const isFirstTime = !AGENT_ID && !fs.existsSync(resolveHmemPath(PROJECT_DIR, ""));

    // Company store: only AL+ can write
    if (storeName === "company") {
      const ROLE_LEVEL: Record<string, number> = { worker: 0, al: 1, pl: 2, ceo: 3 };
      if ((ROLE_LEVEL[agentRole] || 0) < 1) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Only AL, PL, and CEO roles can write to company memory (FIRMENWISSEN)." }],
          isError: true,
        };
      }
    }

    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR)
        : openAgentMemory(PROJECT_DIR, templateName);
      try {
        const effectiveMinRole = storeName === "company" ? (minRole as AgentRole) : ("worker" as AgentRole);
        const result = hmemStore.write(prefix, content, links, effectiveMinRole);
        const storeLabel = storeName === "company" ? "FIRMENWISSEN" : (templateName || "memory");
        log(`write_memory [${storeLabel}]: ${result.id} (prefix=${prefix}, min_role=${effectiveMinRole})`);

        const hmemPath = resolveHmemPath(PROJECT_DIR, templateName);
        const firstTimeNote = isFirstTime
          ? `\nMemory store created: ${hmemPath}\nTo use a custom name, set HMEM_AGENT_ID in your .mcp.json.`
          : "";

        return {
          content: [{
            type: "text" as const,
            text: `Memory saved: ${result.id} (${result.timestamp.substring(0, 19)})\n` +
              `Store: ${storeLabel} | Category: ${prefix}` +
              (storeName === "company" ? ` | Clearance: ${effectiveMinRole}+` : "") +
              firstTimeNote,
          }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${e}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "read_memory",
  "Read from your hierarchical long-term memory (.hmem). " +
    "At startup, you received all Level 1 entries (rough summaries). " +
    "Use this tool to drill deeper into specific memories.\n\n" +
    "Query modes:\n" +
    "- By ID: read_memory({ id: 'P0001' }) → L1 + direct L2 children (one level at a time)\n" +
    "- By node ID: read_memory({ id: 'P0001.2' }) → that node's content + its direct children\n" +
    "- By prefix: read_memory({ prefix: 'L' }) → All Lessons Learned (Level 1)\n" +
    "- By time: read_memory({ after: '2026-02-15', before: '2026-02-17' })\n" +
    "- Search: read_memory({ search: 'SSE' }) → Full-text search across all levels\n\n" +
    "Lazy loading: ID queries always return the node + its DIRECT children only.\n" +
    "To go deeper, call read_memory(id=child_id). depth parameter is ignored for ID queries.\n\n" +
    "Store types:\n" +
    "  personal (default): Your private memory\n" +
    "  company: Shared knowledge base (FIRMENWISSEN) — filtered by your role clearance",
  {
    id: z.string().optional().describe("Specific memory ID, e.g. 'P0001' or 'L0023'"),
    depth: z.number().min(1).max(3).optional().describe("How deep to read (1-3). Default: 2 when reading by ID, 1 for listings. L4/L5 accessible via direct node ID only."),
    prefix: z.string().optional().describe("Filter by category: P, L, T, E, D, M, F, or S"),
    after: z.string().optional().describe("Only entries after this date (ISO format, e.g. '2026-02-15')"),
    before: z.string().optional().describe("Only entries before this date (ISO format)"),
    search: z.string().optional().describe("Full-text search across all memory levels"),
    limit: z.number().optional().describe("Max results (default: 50)"),
    store: z.enum(["personal", "company"]).default("personal").describe(
      "Source store: 'personal' (your own memory) or 'company' (shared FIRMENWISSEN)"
    ),
  },
  async ({ id, depth, prefix, after, before, search, limit: maxResults, store: storeName }) => {
    if (AGENT_ID === "UNKNOWN") {
      return {
        content: [{ type: "text" as const, text: "ERROR: Agent-ID unknown. read_memory is only available for spawned agents." }],
        isError: true,
      };
    }

    const templateName = AGENT_ID.replace(/_\d+$/, "");
    const agentRole = (ROLE || "worker") as AgentRole;

    try {
      const hmemStore = storeName === "company"
        ? openCompanyMemory(PROJECT_DIR)
        : openAgentMemory(PROJECT_DIR, templateName);
      try {
        // Default depth: 2 for single-ID lookup, 1 for listings
        const effectiveDepth = depth || (id ? 2 : 1);

        const entries = hmemStore.read({
          id, depth: effectiveDepth, prefix, after, before, search,
          limit: maxResults || 50,
          agentRole: storeName === "company" ? agentRole : undefined,
        });

        if (entries.length === 0) {
          const hint = id ? `No memory with ID "${id}".` :
            search ? `No memories matching "${search}".` :
              "No memories found for this query.";
          return {
            content: [{ type: "text" as const, text: hint }],
          };
        }

        // Format output — tree-aware
        // Entries with compound IDs (id contains ".") are sub-nodes, not root entries.
        const lines: string[] = [];
        for (const e of entries) {
          const isNode = e.id.includes(".");

          if (isNode) {
            // Sub-node: show depth + content + children
            const depth = (e.id.match(/\./g) || []).length + 1;
            lines.push(`[${e.id}] L${depth}: ${e.level_1}`);
          } else {
            // Root entry: show date + L1 + children
            const date = e.created_at.substring(0, 10);
            const accessed = e.access_count > 0 ? ` (${e.access_count}x accessed)` : "";
            const roleTag = e.min_role !== "worker" ? ` [${e.min_role}+]` : "";
            lines.push(`[${e.id}] ${date}${roleTag}${accessed}`);
            lines.push(`  L1: ${e.level_1}`);
          }

          // Children (populated for ID-based reads)
          if (e.children && e.children.length > 0) {
            lines.push(`  ${e.children.length} ${e.children.length === 1 ? "child" : "children"}:`);
            for (const child of e.children as MemoryNode[]) {
              const childDepth = (child.id.match(/\./g) || []).length + 1;
              const hint = (child.child_count ?? 0) > 0
                ? `  (${child.child_count} ${child.child_count === 1 ? "child" : "children"} — use id="${child.id}" to expand)`
                : "";
              lines.push(`  [${child.id}] L${childDepth}: ${child.content}${hint}`);
            }
          } else if (e.children !== undefined && e.children.length === 0 && !e.id.includes(".")) {
            // Root with no children — show nothing extra
          }

          if (e.links && e.links.length > 0) lines.push(`  Links: ${e.links.join(", ")}`);
          lines.push("");
        }

        const stats = hmemStore.stats();
        const storeLabel = storeName === "company" ? "FIRMENWISSEN" : templateName;
        const header = `## Memory: ${storeLabel} (${stats.total} total entries)\n` +
          `Query: ${id ? `id=${id}` : ""}${prefix ? `prefix=${prefix}` : ""}${search ? `search="${search}"` : ""}${after ? ` after=${after}` : ""}${before ? ` before=${before}` : ""} | Depth: ${effectiveDepth} | Results: ${entries.length}\n`;

        log(`read_memory [${storeLabel}]: ${entries.length} results (depth=${effectiveDepth}, role=${agentRole})`);

        return {
          content: [{
            type: "text" as const,
            text: header + "\n" + lines.join("\n"),
          }],
        };
      } finally {
        hmemStore.close();
      }
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `ERROR: ${e}` }],
        isError: true,
      };
    }
  }
);

// ---- Curator Tools (YGGDRASIL / ceo role only) ----

const AUDIT_STATE_FILE = path.join(PROJECT_DIR, "orchestrator", "audit_state.json");

function loadAuditState(): Record<string, string> {
  try {
    if (fs.existsSync(AUDIT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(AUDIT_STATE_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveAuditState(state: Record<string, string>): void {
  const tmp = AUDIT_STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, AUDIT_STATE_FILE);
}

function isCurator(): boolean {
  return ROLE === "ceo";
}

server.tool(
  "get_audit_queue",
  "CURATOR ONLY (ceo role). Returns agents whose .hmem has changed since YGGDRASIL's last audit. " +
    "Use this at the start of each curation run to get the list of agents to process. " +
    "Each agent should be audited in a separate spawn to keep context bounded.",
  {},
  async () => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: get_audit_queue is only available to the ceo/curator role (YGGDRASIL)." }],
        isError: true,
      };
    }

    const auditState = loadAuditState();
    const agentsDir = path.join(PROJECT_DIR, "Agents");
    const assistDir = path.join(PROJECT_DIR, "Assistenten");

    const queue: Array<{ name: string; hmemPath: string; modified: string; lastAudit: string | null }> = [];

    for (const dir of [agentsDir, assistDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        const hmemPath = path.join(dir, name, `${name}.hmem`);
        if (!fs.existsSync(hmemPath)) continue;

        const stat = fs.statSync(hmemPath);
        const modified = stat.mtime.toISOString();
        const lastAudit = auditState[name] || null;

        if (!lastAudit || new Date(modified) > new Date(lastAudit)) {
          queue.push({ name, hmemPath, modified, lastAudit });
        }
      }
    }

    if (queue.length === 0) {
      return {
        content: [{ type: "text" as const, text: "Audit queue is empty — all agent memories are up to date." }],
      };
    }

    const lines = queue.map(a =>
      `- **${a.name}**: modified ${a.modified.substring(0, 16)}` +
      (a.lastAudit ? ` | last audited ${a.lastAudit.substring(0, 16)}` : " | never audited")
    );

    return {
      content: [{
        type: "text" as const,
        text: `## Audit Queue (${queue.length} agents to check)\n\n${lines.join("\n")}\n\n` +
          `Process one agent per spawn: terminate after each to keep context bounded.`,
      }],
    };
  }
);

server.tool(
  "read_agent_memory",
  "CURATOR ONLY (ceo role). Read the full memory of any agent (for audit purposes). " +
    "Returns all entries at the specified depth. Use depth=3 for a thorough audit.",
  {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR', 'SIGURD'"),
    depth: z.number().int().min(1).max(5).optional().describe("Depth to read (1-5, default: 3)"),
  },
  async ({ agent_name, depth }) => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: read_agent_memory is only available to the ceo/curator role (YGGDRASIL)." }],
        isError: true,
      };
    }

    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
      return {
        content: [{ type: "text" as const, text: `No .hmem found for agent "${agent_name}" (expected: ${hmemPath}).` }],
      };
    }

    const store = new HmemStore(hmemPath);
    try {
      const entries = store.read({ depth: depth || 3, limit: 500 });
      const stats = store.stats();

      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: `Agent "${agent_name}" has no memory entries.` }] };
      }

      const lines: string[] = [`## Memory: ${agent_name} (${stats.total} entries, depth=${depth || 3})\n`];
      for (const e of entries) {
        const date = e.created_at.substring(0, 10);
        const role = e.min_role !== "worker" ? ` [${e.min_role}+]` : "";
        const access = e.access_count > 0 ? ` (${e.access_count}x)` : "";
        lines.push(`[${e.id}] ${date}${role}${access}`);
        lines.push(`  L1: ${e.level_1}`);
        if (e.level_2) lines.push(`  L2: ${e.level_2}`);
        if (e.level_3) lines.push(`  L3: ${e.level_3}`);
        if (e.level_4) lines.push(`  L4: ${e.level_4}`);
        if (e.level_5) lines.push(`  L5: ${e.level_5}`);
        if (e.links?.length) lines.push(`  Links: ${e.links.join(", ")}`);
        lines.push("");
      }

      log(`read_agent_memory [CURATOR]: ${agent_name} depth=${depth || 3} → ${entries.length} entries`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } finally {
      store.close();
    }
  }
);

server.tool(
  "fix_agent_memory",
  "CURATOR ONLY (ceo role). Correct a specific entry in any agent's memory. " +
    "Use to fix wrong content, re-categorize (wrong prefix cannot be changed — delete + re-add), " +
    "or adjust min_role clearance.",
  {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR'"),
    entry_id: z.string().describe("Entry ID to fix, e.g. 'L0003'"),
    level_1: z.string().optional().describe("Corrected Level 1 summary"),
    level_2: z.string().optional().describe("Corrected Level 2 detail (null to clear)"),
    level_3: z.string().optional().describe("Corrected Level 3 detail (null to clear)"),
    min_role: z.enum(["worker", "al", "pl", "ceo"]).optional().describe("Update access clearance"),
  },
  async ({ agent_name, entry_id, level_1, level_2, level_3, min_role }) => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: fix_agent_memory is only available to the ceo/curator role (YGGDRASIL)." }],
        isError: true,
      };
    }

    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
      return {
        content: [{ type: "text" as const, text: `No .hmem found for agent "${agent_name}".` }],
        isError: true,
      };
    }

    const store = new HmemStore(hmemPath);
    try {
      const fields: any = {};
      if (level_1 !== undefined) fields.level_1 = level_1;
      if (level_2 !== undefined) fields.level_2 = level_2;
      if (level_3 !== undefined) fields.level_3 = level_3;
      if (min_role !== undefined) fields.min_role = min_role;

      const ok = store.update(entry_id, fields);
      log(`fix_agent_memory [CURATOR]: ${agent_name} ${entry_id} → ${ok ? "updated" : "not found"}`);

      return {
        content: [{
          type: "text" as const,
          text: ok
            ? `Fixed: ${agent_name}/${entry_id} (fields: ${Object.keys(fields).join(", ")})`
            : `ERROR: Entry "${entry_id}" not found in ${agent_name}'s memory.`,
        }],
        isError: !ok,
      };
    } finally {
      store.close();
    }
  }
);

server.tool(
  "delete_agent_memory",
  "CURATOR ONLY (ceo role). Delete an entry from any agent's memory. " +
    "Use sparingly — only for exact duplicates or entries that are factually wrong and cannot be fixed.",
  {
    agent_name: z.string().describe("Template name of the agent, e.g. 'THOR'"),
    entry_id: z.string().describe("Entry ID to delete, e.g. 'E0007'"),
  },
  async ({ agent_name, entry_id }) => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: delete_agent_memory is only available to the ceo/curator role (YGGDRASIL)." }],
        isError: true,
      };
    }

    const hmemPath = resolveHmemPath(PROJECT_DIR, agent_name);
    if (!fs.existsSync(hmemPath)) {
      return {
        content: [{ type: "text" as const, text: `No .hmem found for agent "${agent_name}".` }],
        isError: true,
      };
    }

    const store = new HmemStore(hmemPath);
    try {
      const ok = store.delete(entry_id);
      log(`delete_agent_memory [CURATOR]: ${agent_name} ${entry_id} → ${ok ? "deleted" : "not found"}`);

      return {
        content: [{
          type: "text" as const,
          text: ok
            ? `Deleted: ${agent_name}/${entry_id}`
            : `ERROR: Entry "${entry_id}" not found in ${agent_name}'s memory.`,
        }],
        isError: !ok,
      };
    } finally {
      store.close();
    }
  }
);

server.tool(
  "mark_audited",
  "CURATOR ONLY (ceo role). Mark an agent as audited (updates timestamp in audit_state.json). " +
    "Call this after finishing each agent in the audit queue.",
  {
    agent_name: z.string().describe("Template name of the agent that was audited, e.g. 'THOR'"),
  },
  async ({ agent_name }) => {
    if (!isCurator()) {
      return {
        content: [{ type: "text" as const, text: "ERROR: mark_audited is only available to the ceo/curator role (YGGDRASIL)." }],
        isError: true,
      };
    }

    const state = loadAuditState();
    state[agent_name] = new Date().toISOString();
    saveAuditState(state);

    log(`mark_audited [CURATOR]: ${agent_name}`);
    return {
      content: [{ type: "text" as const, text: `Marked as audited: ${agent_name} (${state[agent_name].substring(0, 16)})` }],
    };
  }
);

// ---- Start ----
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in MCP Server:", error);
  process.exit(1);
});

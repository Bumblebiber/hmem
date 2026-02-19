import fs from "node:fs";
import path from "node:path";
import { AgentRequest } from "./types.js";
import { Logger } from "./logger.js";

export function parseRequestFile(filePath: string, log: Logger): AgentRequest | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const req: AgentRequest = JSON.parse(raw);

    // Extract Request_ID from filename if not in JSON
    if (!req.Request_ID) {
      const basename = path.basename(filePath, ".json");
      // REQ_CODER_1 → CODER_1
      req.Request_ID = basename.replace(/^REQ_/, "");
    }

    // Set defaults
    req.Type = req.Type || "LAUNCH_AGENT";
    req.Depth = req.Depth ?? 0;
    // Terminate_After: Only set if explicitly specified in JSON.
    // Template merger and agent-manager set the default later.
    // An early default here would override template values (e.g. Terminate_After: false).
    req._RequestFile = filePath;

    return req;
  } catch (e) {
    log.error(`JSON parse failed: ${filePath}: ${e}`);
    return null;
  }
}

const VALID_TOOLS = new Set(["opencode", "opencode-run", "gemini-cli", "claude"]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_COMMAND_LENGTH = 50_000; // 50KB max

export function validateRequest(req: AgentRequest, maxDepth: number, log: Logger): boolean {
  const id = req.Agent_ID || "?";

  if (req.Type === "LAUNCH_AGENT") {
    if (!req.Command) {
      log.error(`${id}: No command specified`);
      return false;
    }
    if ((req.Depth ?? 0) > maxDepth) {
      log.error(`${id}: Spawn-Depth ${req.Depth} > Max ${maxDepth}`);
      return false;
    }
  }

  // Agent_ID: only safe characters
  if (req.Agent_ID && !SAFE_ID_PATTERN.test(req.Agent_ID)) {
    log.error(`${id}: Agent_ID contains invalid characters (allowed: A-Z, 0-9, _, -)`);
    return false;
  }

  // Tool: must be known
  if (req.Tool && !VALID_TOOLS.has(req.Tool)) {
    log.error(`${id}: Unknown tool '${req.Tool}' (allowed: ${[...VALID_TOOLS].join(", ")})`);
    return false;
  }

  // Command: length limit
  if (req.Command && req.Command.length > MAX_COMMAND_LENGTH) {
    log.error(`${id}: Command too long (${req.Command.length} > ${MAX_COMMAND_LENGTH} bytes)`);
    return false;
  }

  // Depth: must be non-negative
  if (req.Depth !== undefined && (req.Depth < 0 || !Number.isInteger(req.Depth))) {
    log.error(`${id}: Invalid depth ${req.Depth} (must be >= 0 and an integer)`);
    return false;
  }

  return true;
}

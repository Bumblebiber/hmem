export type AgentStatus = "offline" | "busy" | "idle" | "delegating" | "question" | "continuing";

export type ToolType = "opencode" | "opencode-run" | "gemini-cli" | "claude" | "claude-api" | "ollama";

export type AgentRole = "ceo" | "pl" | "al" | "worker";

export interface AgentRequest {
  Type?: string;              // LAUNCH_AGENT (default), TERMINATE
  Template?: string;          // Catalog name (coder, architect, etc.)
  Agent_ID?: string;          // Slot name (CODER, CODER_2, etc.)
  Model?: string;             // Model alias (opus, sonnet, gemini-pro, etc.)
  Temperature?: number;       // 0.0 - 1.0
  Tool?: ToolType;            // opencode, opencode-run, gemini-cli, claude
  Command?: string;           // Task for the agent
  Session_Name?: string;      // Session name for persistence
  Resume_Session?: boolean;   // Resume existing session
  Terminate_After?: boolean;  // Terminate agent after completion
  Depth?: number;             // Spawn depth (0=PL, max=3)
  Role?: AgentRole;           // Role: ceo, pl, al, worker
  ReportTo?: string;          // Parent agent ID for notification
  SpawnedBy?: string;         // Parent agent ID
  Cwd?: string;               // Working directory
  Request_ID?: string;        // ID for response file
  Budget_USD?: number;        // Total budget for project/phase
  Budget_Spent_USD?: number;  // Already spent (set by orchestrator)

  // Internal (set by scanner)
  _RequestFile?: string;      // Path to REQ JSON file
  _isRetry?: boolean;         // Retry flag (do not reset retryCount)
}

export interface CatalogEntry {
  // Internal (for orchestrator — do NOT pass to agents):
  Description?: string;
  Model?: string;
  Temperature?: number;
  Tool?: ToolType;
  Terminate_After?: boolean;
  Role?: AgentRole;
  Fallback_Tools?: ToolType[];  // Fallback chain: ["claude", "gemini-cli", "ollama"]
  // Visible to agents (via list_templates):
  Name?: string;                // "Samweis Gamdschie"
  Department?: string;          // "Backend"
  Specializations?: string[];   // ["Node.js", "Express.js"]
  // Meta control:
  Internal?: boolean;           // true = not shown in list_templates (meta agents)
  // Costs:
  Cost_Per_Min_USD?: number;    // Estimated cost per minute (based on model)
}

export type AgentCatalog = Record<string, CatalogEntry>;

export interface Agent {
  id: string;
  status: AgentStatus;
  pid: number;
  tool: ToolType;
  model: string;
  busySince: number;          // Date.now() at start
  currentRequestId: string;
  outputDir: string;
  terminateAfter: boolean;
  depth: number;
  role: AgentRole;
  spawnedBy: string;
  reportTo: string;
  childAgentIds: string[];
  outputAcked: boolean;
  timeoutWarned: boolean;
  launchCommand: string;
  lastChildStatusLog: string;   // Last logged child status (spam protection)
  lastChildStatusTime: number;  // Timestamp of last child status log

  // Cleanup
  tmpDir: string;               // opencode OPENCODE_DATA_DIR (empty if not opencode)

  // Retry tracking
  retryCount: number;           // Current retry count
  maxRetries: number;           // Max retries for this agent
  lastExitCode: number;         // Exit code of last run
  originalRequest: AgentRequest | null;  // Original request for retry

  // Output stability: Wait until file stops growing
  lastOutputSize: number;               // Last known file size
  lastOutputSizeTime: number;           // Timestamp of last size change
}

export interface OrchestratorState {
  version: string;
  timestamp: string;
  system?: {
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    freeMemMB: number;
    throttled: boolean;
  };
  agents: SerializedAgent[];
}

export interface SerializedAgent {
  id: string;
  status: AgentStatus;
  pid: number;
  tool: ToolType;
  model: string;
  busySince: number;
  currentRequestId: string;
  outputDir: string;
  terminateAfter: boolean;
  depth: number;
  role: AgentRole;
  spawnedBy: string;
  reportTo: string;
  childAgentIds: string[];
  outputAcked: boolean;
}

// ── Scheduler ──
export interface ScheduledAgentConfig {
  agent_id: string;
  template: string;
  enabled: boolean;
  interval_hours: number;      // 24 = daily, 0 = disabled
  day_of_week: number;         // 0=Sun..6=Sat, -1 = disabled
  preferred_hour: number;      // UTC hour (0-23)
  on_project_complete: boolean;
  command: string;
  max_load_avg1: number;       // 0 = no limit
  max_failures: number;        // Auto-disable after N errors
}

export interface ScheduledTaskState {
  last_run_iso: string;
  last_run_ms: number;
  consecutive_failures: number;
  last_failure_reason: string;
  disabled_by_failures: boolean;
}

export interface SchedulerState {
  version: string;
  tasks: Record<string, ScheduledTaskState>;
}

export interface RetryConfig {
  maxRetries: number;           // Max retry attempts (default: 2)
  retryDelayMs: number;         // Wait time before retry (default: 10s)
  backoffMultiplier: number;    // Backoff increase per retry (default: 2)
}

export interface OrchestratorConfig {
  projectDir: string;
  pollMs: number;             // Scan interval (ms)
  ackTimeoutMs: number;       // ACK timeout (ms)
  execWarningMs: number;      // Execution warning (ms)
  zombieKillMs: number;       // Zombie kill (ms)
  maxSpawnDepth: number;      // Max spawn depth
  maxSpawnsPerAgent: number;  // Max sub-agents per parent
  logMaxBytes: number;        // Log rotation threshold
  logJsonMode: boolean;       // JSON logging (JSONL instead of plaintext)
  archiveDays: number;        // Auto-archiving after N days
  retry: RetryConfig;         // Retry configuration
  autoSynthesize: boolean;    // Automatic result synthesis after CHILDREN_DONE
  synthesizeTemplate: string; // Template for synthesis agent (default: consolidator)
  logLevel: string;           // Log level: debug, info, warn, error (default: info)
  enableSurveys: boolean;     // Spawn agent surveys after CHILDREN_DONE
  surveyTemplate: string;     // Template for survey worker (default: agent-survey)
  maxConcurrentAgents: number; // Max concurrently active agents (0 = unlimited)
  maxConcurrentOpencode: number; // Max concurrently active opencode agents (0 = unlimited)
  loadThrottleAvg1: number;     // 1-min load average at which spawning is paused (0 = disabled)
  loadKillAvg1: number;         // 1-min load average at which agents are killed (0 = disabled)
  workerModelBlacklist: string[]; // Models forbidden for workers (e.g. ["opus", "claude-opus-4-6"])
  scheduledAgents: ScheduledAgentConfig[]; // Periodically started meta agents
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  projectDir: "",
  pollMs: 1000,
  ackTimeoutMs: 30_000,
  execWarningMs: 600_000,
  zombieKillMs: 900_000,
  maxSpawnDepth: 3,
  maxSpawnsPerAgent: 5,
  logMaxBytes: 10 * 1024 * 1024,
  logJsonMode: false,
  archiveDays: 7,
  retry: {
    maxRetries: 2,
    retryDelayMs: 10_000,
    backoffMultiplier: 2,
  },
  autoSynthesize: false,
  synthesizeTemplate: "consolidator",
  logLevel: "info",
  enableSurveys: false,
  surveyTemplate: "agent-survey",
  maxConcurrentAgents: 10,
  maxConcurrentOpencode: 2,
  loadThrottleAvg1: 0,         // 0 = disabled
  loadKillAvg1: 12,            // Kill agents when avg1 > 12
  workerModelBlacklist: [],
  scheduledAgents: [],
};

export const MODEL_ALIASES: Record<string, string> = {
  // Claude (via claude CLI)
  "opus": "claude-opus-4-6",
  "sonnet": "claude-sonnet-4-5-20250929",
  "haiku": "claude-haiku-4-5-20251001",
  // Gemini (via gemini CLI)
  "gemini-pro": "gemini-3-pro-preview",
  "gemini-flash": "gemini-3-flash-preview",
  // OpenRouter (via opencode) — Format: openrouter/provider/model
  "deepseek": "openrouter/deepseek/deepseek-v3.2",
  "qwen-coder": "openrouter/qwen/qwen3-coder",
  "devstral": "openrouter/mistralai/devstral-2512",
  "mistral": "openrouter/mistralai/mistral-medium-3.1",
  "grok-fast": "openrouter/x-ai/grok-4.1-fast",
  "glm": "openrouter/z-ai/glm-5",
  "glm-flash": "openrouter/z-ai/glm-4.7-flash",
  "gpt-mini": "openrouter/openai/gpt-5.1-codex-mini",
  // New frontier models (via opencode/openrouter)
  "minimax": "openrouter/minimax/minimax-m2.5",
  "kimi": "openrouter/moonshotai/kimi-k2.5",
  // Free Tier (via opencode/openrouter)
  "deepseek-free": "openrouter/deepseek/deepseek-r1-0528:free",
  "devstral-free": "openrouter/mistralai/devstral-small-2505:free",
  "qwen-free": "openrouter/qwen/qwen3-235b-a22b:free",
};

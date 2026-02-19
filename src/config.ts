import fs from "node:fs";
import path from "node:path";
import { AgentCatalog, CatalogEntry, DEFAULT_CONFIG, OrchestratorConfig } from "./types.js";

export interface CouncilConfig {
  name?: string;
  tools?: Record<string, {
    binary: string;
    args: string[];
    model_flag?: string | null;
  }>;
  defaults?: {
    tool?: string;
    model?: string;
    timeout_seconds?: number;
    terminate_after?: boolean;
  };
  orchestrator?: {
    poll_ms?: number;
    ack_timeout_ms?: number;
    exec_warning_ms?: number;
    zombie_kill_ms?: number;
    max_spawn_depth?: number;
    max_spawns_per_agent?: number;
    log_max_bytes?: number;
    log_json_mode?: boolean;
    archive_days?: number;
    auto_synthesize?: boolean;
    synthesize_template?: string;
    log_level?: string;
    enable_surveys?: boolean;
    survey_template?: string;
    max_concurrent_agents?: number;
    max_concurrent_opencode?: number;
    load_throttle_avg1?: number;
    load_kill_avg1?: number;
    worker_model_blacklist?: string[];
  };
  retry?: {
    max_retries?: number;
    retry_delay_ms?: number;
    backoff_multiplier?: number;
  };
  scheduled_agents?: Array<{
    agent_id?: string;
    template?: string;
    enabled?: boolean;
    interval_hours?: number;
    day_of_week?: number;
    preferred_hour?: number;
    on_project_complete?: boolean;
    command?: string;
    max_load_avg1?: number;
    max_failures?: number;
  }>;
}

/** Loaded council.config.json (null if not found) */
let _councilConfig: CouncilConfig | null = null;

export function getCouncilConfig(): CouncilConfig | null {
  return _councilConfig;
}

export function loadConfig(projectDir: string): OrchestratorConfig {
  const resolved = path.resolve(projectDir);

  // Try to load council.config.json
  const configPath = path.join(resolved, "council.config.json");
  if (fs.existsSync(configPath)) {
    try {
      _councilConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as CouncilConfig;
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  const orch = _councilConfig?.orchestrator;
  const retry = _councilConfig?.retry;

  return {
    ...DEFAULT_CONFIG,
    projectDir: resolved,
    logJsonMode: process.env.COUNCIL_LOG_JSON === "true" || orch?.log_json_mode === true,
    pollMs: orch?.poll_ms ?? DEFAULT_CONFIG.pollMs,
    ackTimeoutMs: orch?.ack_timeout_ms ?? DEFAULT_CONFIG.ackTimeoutMs,
    execWarningMs: orch?.exec_warning_ms ?? DEFAULT_CONFIG.execWarningMs,
    zombieKillMs: orch?.zombie_kill_ms ?? DEFAULT_CONFIG.zombieKillMs,
    maxSpawnDepth: orch?.max_spawn_depth ?? DEFAULT_CONFIG.maxSpawnDepth,
    maxSpawnsPerAgent: orch?.max_spawns_per_agent ?? DEFAULT_CONFIG.maxSpawnsPerAgent,
    logMaxBytes: orch?.log_max_bytes ?? DEFAULT_CONFIG.logMaxBytes,
    archiveDays: orch?.archive_days ?? DEFAULT_CONFIG.archiveDays,
    autoSynthesize: orch?.auto_synthesize ?? DEFAULT_CONFIG.autoSynthesize,
    synthesizeTemplate: orch?.synthesize_template ?? DEFAULT_CONFIG.synthesizeTemplate,
    logLevel: process.env.COUNCIL_LOG_LEVEL || orch?.log_level || DEFAULT_CONFIG.logLevel,
    enableSurveys: orch?.enable_surveys ?? DEFAULT_CONFIG.enableSurveys,
    surveyTemplate: orch?.survey_template ?? DEFAULT_CONFIG.surveyTemplate,
    maxConcurrentAgents: orch?.max_concurrent_agents ?? DEFAULT_CONFIG.maxConcurrentAgents,
    maxConcurrentOpencode: orch?.max_concurrent_opencode ?? DEFAULT_CONFIG.maxConcurrentOpencode,
    loadThrottleAvg1: orch?.load_throttle_avg1 ?? DEFAULT_CONFIG.loadThrottleAvg1,
    loadKillAvg1: orch?.load_kill_avg1 ?? DEFAULT_CONFIG.loadKillAvg1,
    workerModelBlacklist: orch?.worker_model_blacklist ?? DEFAULT_CONFIG.workerModelBlacklist,
    retry: {
      maxRetries: retry?.max_retries ?? DEFAULT_CONFIG.retry.maxRetries,
      retryDelayMs: retry?.retry_delay_ms ?? DEFAULT_CONFIG.retry.retryDelayMs,
      backoffMultiplier: retry?.backoff_multiplier ?? DEFAULT_CONFIG.retry.backoffMultiplier,
    },
    scheduledAgents: (_councilConfig?.scheduled_agents || []).map(sa => ({
      agent_id: sa.agent_id || "UNKNOWN",
      template: sa.template || sa.agent_id || "UNKNOWN",
      enabled: sa.enabled ?? false,
      interval_hours: sa.interval_hours ?? 0,
      day_of_week: sa.day_of_week ?? -1,
      preferred_hour: sa.preferred_hour ?? 3,
      on_project_complete: sa.on_project_complete ?? false,
      command: sa.command || "",
      max_load_avg1: sa.max_load_avg1 ?? 0,
      max_failures: sa.max_failures ?? 3,
    })),
  };
}

export function loadCatalog(projectDir: string): AgentCatalog {
  const catalogPath = path.join(projectDir, "AGENT_CATALOG.json");
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`AGENT_CATALOG.json not found: ${catalogPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
  const catalog: AgentCatalog = {};

  for (const [key, value] of Object.entries(raw)) {
    // Skip metadata fields (_version, _description, _category*)
    if (key.startsWith("_")) continue;
    catalog[key] = value as CatalogEntry;
  }

  return catalog;
}

export function ensureDirectories(projectDir: string) {
  const dirs = [
    path.join(projectDir, "orchestrator", "logs"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

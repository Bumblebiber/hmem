import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/extensions/ → ../../skills/hmem-using-hmem/SKILL.md
const SKILL_PATH = join(__dirname, "../../skills/hmem-using-hmem/SKILL.md");

/** Default hmem DB path. */
const DEFAULT_HMEM_PATH = join(homedir(), ".hmem/Agents/DEVELOPER/DEVELOPER.hmem");

// ── Types ──────────────────────────────────────────────────────────────────
interface DbRow {
  id: string;
  title: string;
  level_1?: string;
}
interface CountRow {
  cnt: number;
}

/** Extract plain text from a Pi message content value. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text as string)
    .join("");
}

/** Run an hmem CLI subcommand, piping `input` to stdin. Resolves with stdout. */
function runHmem(args: string[], input = "{}", timeout = 10_000): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile("hmem", args, { timeout, env: process.env }, (_err, stdout) => {
      resolve(stdout ?? "");
    });
    if (child.stdin) {
      child.stdin.on("error", () => {}); // suppress EPIPE if child exits early
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/** Spawn hmem checkpoint as a detached fire-and-forget child process. */
function spawnCheckpoint(sessionFile: string | null): void {
  try {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (sessionFile) env.HMEM_PI_SESSION = sessionFile;
    // Mark the harness so cli-checkpoint-agent routes to the configured provider
    // (DeepSeek/OpenAI) rather than the Claude Code `claude -p` path.
    env.HMEM_HARNESS = "pi";
    // Use explicit any-typed options to bypass Node v24 execFile overload issue
    const opts: any = { detached: true, stdio: "ignore", env };
    const child = execFile("hmem", ["checkpoint"], opts);
    child.unref();
  } catch {
    // silently ignore spawn failures
  }
}

/** Resolve HMEM_PATH from env or defaults. */
function resolveHmemPath(): string {
  if (process.env.HMEM_PATH && existsSync(process.env.HMEM_PATH)) {
    return process.env.HMEM_PATH;
  }
  return DEFAULT_HMEM_PATH;
}

/** Read checkpoint config from hmem.config.json. Returns { interval, mode }. */
function readCheckpointConfig(hmemPath: string): { interval: number; mode: string } {
  const configPath = join(dirname(hmemPath), "hmem.config.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    return {
      interval: cfg.checkpointInterval ?? 20,
      mode: cfg.checkpointMode ?? "remind",
    };
  } catch {
    return { interval: 20, mode: "remind" };
  }
}

// ── Sync status ────────────────────────────────────────────────────────────

function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function buildSyncStatus(): string {
  const configPath = join(homedir(), ".hmem", "config.json");
  if (!existsSync(configPath)) {
    return "\n\n--- hmem-sync ---\n✗ Not configured on this device — memories stay local, no cross-device sync. Run `hmem-sync login` then `hmem-sync setup` to enable.";
  }
  let cfg: any;
  try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch {
    return "\n\n--- hmem-sync ---\n✗ Config file unreadable — sync inactive. Check ~/.hmem/config.json.";
  }

  const server = cfg.server || "https://hmem-sync.io";
  const linked = !!(cfg.session_token || cfg.api_key);
  const activeFile = cfg.active_file;

  if (!linked) {
    return "\n\n--- hmem-sync ---\n✗ Not linked — writes stay local. Run `hmem-sync login` to enable cross-device sync.";
  }
  if (!activeFile) {
    return `\n\n--- hmem-sync ---\n⚠ Authenticated to ${server} but no active file. Run \`hmem-sync setup\` to link one.`;
  }
  const fileCfg = cfg.files?.[activeFile];
  if (!fileCfg?.last_sync) {
    return `\n\n--- hmem-sync ---\n⚠ Linked to ${server} (active_file: ${activeFile}) but never synced. Run \`hmem-sync pull\` to fetch.`;
  }
  const ago = formatAgo(Date.now() - new Date(fileCfg.last_sync).getTime());
  return `\n\n--- hmem-sync ---\n✓ Linked to ${server} | active_file: ${activeFile} | last sync: ${ago} — writes propagate to other devices on next \`hmem-sync push\`.`;
}

// ── Startup context builder ────────────────────────────────────────────────

/**
 * Build the "first-message" context that Claude Code's hmem hook-startup
 * would normally inject. Mirrors cli-hook-startup.ts behavior exactly:
 * sync pull → query DB → assemble greetingDirective + data blocks.
 */
async function buildStartupContext(): Promise<string> {
  const hmemPath = resolveHmemPath();
  if (!existsSync(hmemPath)) return "";

  // ── Sync pull before reading (3s timeout, best-effort) ──
  try {
    const { syncPull } = await import("../mcp-shared.js");
    await Promise.race([
      syncPull(hmemPath).catch(() => undefined),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        t.unref();
      }),
    ]);
  } catch { /* sync module unavailable or pull rejected — proceed offline */ }

  let Database: any;
  try {
    // better-sqlite3 is already a dependency of hmem-mcp
    Database = (await import("better-sqlite3")).default;
  } catch {
    return "";
  }

  let db: any;

  try {
    db = new Database(hmemPath, { readonly: true });

    // ── Device check ──
    const activeDeviceId = getActiveDeviceId();
    const deviceNote = activeDeviceId
      ? ""
      : "\n\nIMPORTANT: No active device is set for this machine. After loading memory, identify which device you are on (check hostname, hardware specs, or location), find the matching I-entry via read_memory() or search_memory(), then call set_active_device(id='I00XX'). Do this silently alongside the memory load.";

    // ── Human context (H-entries) ──
    let humanContext = "";
    try {
      const hRows = db
        .prepare(
          "SELECT id, title, level_1 FROM memories WHERE prefix='H' AND obsolete!=1 ORDER BY access_count DESC LIMIT 10"
        )
        .all() as DbRow[];
      if (hRows.length > 0) {
        humanContext =
          "\n\n--- Human context (H-entries) ---\n" +
          hRows.map((r) => `${r.id}  ${(r.title || r.level_1 || "").split("\n")[0]}`).join("\n");
      }

      if (activeDeviceId) {
        // Device known: inject Apps list
        const appsNode = db
          .prepare(
            "SELECT id FROM memory_nodes WHERE root_id=? AND depth=2 AND title='Apps' AND (irrelevant IS NULL OR irrelevant!=1) LIMIT 1"
          )
          .get(activeDeviceId) as { id: string } | undefined;
        if (appsNode) {
          const l3Rows = db
            .prepare(
              "SELECT title FROM memory_nodes WHERE parent_id=? AND depth=3 AND (irrelevant IS NULL OR irrelevant!=1) ORDER BY seq"
            )
            .all(appsNode.id) as Array<{ title: string }>;
          if (l3Rows.length > 0) {
            humanContext +=
              `\n\n--- Active device (${activeDeviceId}) Apps ---\n` +
              l3Rows.map((r) => `  - ${r.title ?? ""}`).join("\n");
          }
        }
      } else {
        // Device unknown: list I-entries
        const iRows = db
          .prepare(
            "SELECT id, title FROM memories WHERE prefix='I' AND obsolete!=1 ORDER BY id"
          )
          .all() as DbRow[];
        if (iRows.length > 0) {
          humanContext +=
            "\n\n--- Known devices (identify this machine) ---\n" +
            iRows.map((r) => `${r.id}  ${r.title ?? ""}`).join("\n");
        }
      }

      // Infrastructure favorites
      const iFavRows = db
        .prepare(
          "SELECT id, title FROM memories WHERE prefix='I' AND favorite=1 AND obsolete!=1 AND (irrelevant IS NULL OR irrelevant!=1) ORDER BY id"
        )
        .all() as DbRow[];
      if (iFavRows.length > 0) {
        humanContext +=
          "\n\n--- Infrastructure (favorites) ---\n" +
          iFavRows.map((r) => `${r.id}  ${r.title ?? ""}`).join("\n");
      }
    } catch {
      // ignore
    }

    // ── Recent projects ──
    let recentProjects = "";
    try {
      const pRows = db
        .prepare(
          "SELECT id, title FROM memories WHERE prefix='P' AND obsolete!=1 ORDER BY updated_at DESC LIMIT 5"
        )
        .all() as DbRow[];
      if (pRows.length > 0) {
        recentProjects =
          "\n\n--- Recent projects ---\n" +
          pRows.map((r) => `${r.id}  ${r.title ?? ""}`).join("\n");
      }

      // Checkpoint status
      const activeP = db
        .prepare(
          "SELECT id FROM memories WHERE prefix='P' AND active=1 AND obsolete!=1 LIMIT 1"
        )
        .get() as { id: string } | undefined;
      if (activeP) {
        const seq = parseInt(activeP.id.replace(/\D/g, ""), 10);
        const oId = `O${String(seq).padStart(4, "0")}`;
        const unsummarized = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM memory_nodes
             WHERE root_id=? AND depth=2
             AND (content IS NULL OR content = title)
             AND (irrelevant IS NULL OR irrelevant != 1)`
          )
          .get(oId) as CountRow | undefined;
        if (unsummarized && unsummarized.cnt > 0) {
          recentProjects += `\n\n--- Checkpoint status ---\n${unsummarized.cnt} session(s) in ${oId} without summary. Run \`hmem checkpoint\` or wait for auto-checkpoint.`;
        }
      }
    } catch {
      // ignore
    }

    // ── Sync status ──
    const syncStatus = buildSyncStatus();

    // ── Assemble: full greetingDirective matching cli-hook-startup.ts ──
    // The directive tells the agent EXACTLY what to do on session start:
    // STEP 1: load_project or read_memory (silently)
    // STEP 2: invoke o9k-session-start skill (silently)
    // STEP 3: handle user's actual message
    //
    // When the user already named a project, the agent sees recentProjects
    // and can skip the "which project?" question. When they didn't, the
    // agent lists the 5 recent projects and asks.
    const greetingDirective =
      "IMPORTANT: This is the first message of the session.\n\n" +
      "STEP 1 (silent — no output yet): Load context.\n" +
      "  - If the user's message names a specific project (e.g. \"lade Projekt hmem\", \"work on P0048\"): call ONLY load_project(id=\"P00XX\"). Do NOT also call read_memory().\n" +
      "  - Otherwise: call read_memory() (no parameters).\n\n" +
      "STEP 2 (silent — no output yet): Invoke the `o9k-session-start` skill via the Skill tool. The skill handles the full session-start workflow: pending git work check (uncommitted, stashes, worktrees, unmerged branches), Next Steps + open T-tasks surfacing from the project's Roadmap, O-entry routing check, noise check, explanation-depth calibration, and the greeting format itself (one short line with sync-state dot from the `--- hmem-sync ---` block). The project is already loaded — the skill detects this and skips its activation step.\n\n" +
      "  - If the user named a project above: proceed straight to the task after the skill's output.\n" +
      "  - If the user did NOT name a project: the skill will list the 5 entries from `--- Recent projects ---` below as bullet points and ask which one to continue with.\n\n" +
      "STEP 3: Handle the user's actual message (or, if step 2 ended with a question, wait for their answer).";

    return greetingDirective +
      deviceNote +
      humanContext +
      recentProjects +
      syncStatus;
  } catch {
    return "";
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

/** Read the active device ID from ~/.hmem/active-device. */
function getActiveDeviceId(): string | null {
  try {
    const markerPath = join(homedir(), ".hmem/active-device");
    if (existsSync(markerPath)) {
      return readFileSync(markerPath, "utf8").trim() || null;
    }
  } catch {
    // ignore
  }
  return null;
}

// ── O-Entry Titling ───────────────────────────────────────────────────────

interface ExchangeTitle {
  /** The O-entry root ID (e.g. O0048) */
  oId: string;
  /** First few user messages (for LLM context) */
  samples: string[];
}

/**
 * Detect a cheap/fast model provider from environment.
 * Returns { baseUrl, apiKey, model } or null if none available.
 */
function detectCheapModel(): { baseUrl: string; apiKey: string; model: string } | null {
  // Deepseek (Ben's primary cheap model)
  const dsKey = process.env.DEEPSEEK_API_KEY;
  if (dsKey) return { baseUrl: "https://api.deepseek.com/v1", apiKey: dsKey, model: "deepseek-chat" };

  // OpenAI fallback
  const oaKey = process.env.OPENAI_API_KEY;
  if (oaKey) return { baseUrl: "https://api.openai.com/v1", apiKey: oaKey, model: "gpt-3.5-turbo" };

  // Generic: any OPENAI_BASE_URL + OPENAI_API_KEY combo
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (baseUrl && apiKey) {
    return { baseUrl, apiKey, model: process.env.LLM_MODEL || "gpt-3.5-turbo" };
  }

  return null;
}

/** Ask a cheap model to generate a one-line title (max 80 chars) from sample exchanges. */
async function llmTitle(provider: { baseUrl: string; apiKey: string; model: string }, samples: string[]): Promise<string | null> {
  const prompt = `Generate a concise one-line title (max 80 chars) summarizing this session. Reply with ONLY the title, nothing else.\n\nTopics discussed:\n${samples.join("\n")}`;

  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 30,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = await res.json() as any;
    const title = data?.choices?.[0]?.message?.content?.trim();
    if (title && title.length >= 3 && title.length <= 80) {
      return title.replace(/["']/g, ""); // strip quotes that models sometimes wrap in
    }
    return null;
  } catch {
    return null;
  }
}

/** Heuristic title: first meaningful line of first user message, max 80 chars. */
function heuristicTitle(samples: string[]): string | null {
  for (const msg of samples) {
    const firstLine = msg.split("\n")[0].trim().replace(/[<>\[\]]/g, "");
    if (firstLine.length >= 5 && firstLine.length <= 80) return firstLine;
    if (firstLine.length > 80) {
      const lastSpace = firstLine.substring(0, 80).lastIndexOf(" ");
      return (lastSpace > 40 ? firstLine.substring(0, lastSpace) : firstLine.substring(0, 80));
    }
  }
  return null;
}

/**
 * Title all untitled O-entries. Tries LLM first, falls back to heuristic.
 * Best-effort — never throws, never blocks the session.
 */
async function titleUntitledOEntries(): Promise<void> {
  const hmemPath = resolveHmemPath();
  if (!existsSync(hmemPath)) return;

  let Database: any;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    return;
  }

  // Phase 1: Read untitled O-entries and their sample exchanges (readonly)
  const untitled: ExchangeTitle[] = [];
  let db: any;
  try {
    db = new Database(hmemPath, { readonly: true });

    const rows = db
      .prepare(
        "SELECT id FROM memories WHERE prefix='O' AND (title IS NULL OR title = '' OR title LIKE 'unassigned%') AND obsolete!=1"
      )
      .all() as { id: string }[];

    for (const row of rows) {
      const exchangeRows = db
        .prepare(
          `SELECT mn.title, mn.content FROM memory_nodes mn
           WHERE mn.root_id = ? AND mn.depth >= 4
           AND (mn.irrelevant IS NULL OR mn.irrelevant != 1)
           ORDER BY mn.seq LIMIT 5`
        )
        .all(row.id) as { title: string; content: string }[];

      const samples = exchangeRows
        .map((r) => (r.title || r.content || "").substring(0, 120).replace(/\n/g, " ").trim())
        .filter((s) => s.length >= 3);

      if (samples.length > 0) {
        untitled.push({ oId: row.id, samples });
      }
    }
    db.close();
    db = null;
  } catch {
    if (db) try { db.close(); } catch { /* ignore */ }
    return;
  }

  if (untitled.length === 0) return;

  // Phase 2: Generate titles
  const provider = detectCheapModel();
  const updates: { oId: string; title: string }[] = [];

  for (const entry of untitled) {
    let title: string | null = null;

    // Try LLM first if available
    if (provider) {
      title = await llmTitle(provider, entry.samples);
    }

    // Fall back to heuristic
    if (!title) {
      title = heuristicTitle(entry.samples);
    }

    if (title) {
      updates.push({ oId: entry.oId, title });
    }
  }

  if (updates.length === 0) return;

  // Phase 3: Write titles (separate connection, quick)
  try {
    db = new Database(hmemPath);
    const stmt = db.prepare("UPDATE memories SET title = ? WHERE id = ?");
    for (const u of updates) {
      stmt.run(u.title, u.oId);
    }
    db.close();
  } catch {
    if (db) try { db.close(); } catch { /* ignore */ }
  }
}

// ── Extension ──────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  let startupContext = "";
  let turnCount = 0;
  let lastLogTime = 0;
  /** Stable session key for hmem log-exchange (pi session file path or UUID). */
  let piSessionKey = `pi:${randomUUID()}`;

  // ── 1. Session start: capture session identity + build startup context ──
  pi.on("session_start", async (event, ctx) => {
    console.error(`[pi-hmem] session_start fired, reason=${event.reason}`);
    if (event.reason !== "startup") return;
    turnCount = 0;
    startupContext = "";

    // Derive stable session key from pi's session file path
    try {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) {
        piSessionKey = `pi:${sf}`;
      } else {
        piSessionKey = `pi:${randomUUID()}`;
      }
    } catch {
      piSessionKey = `pi:${randomUUID()}`;
    }
    console.error(`[pi-hmem] session_start piSessionKey=${piSessionKey}`);

    try {
      startupContext = await buildStartupContext();
      console.error(`[pi-hmem] session_start startupContext built, length=${startupContext.length}`);
    } catch (e) {
      console.error(`[pi-hmem] session_start buildStartupContext FAILED: ${e}`);
    }
    
    // Write session marker so log-exchange doesn't fall back to legacy DB flag
    try {
      const { writeSessionMarker } = await import("../session-state.js");
      writeSessionMarker(piSessionKey, { projectId: null, hmemPath: resolveHmemPath() });
      console.error(`[pi-hmem] session_start wrote session marker for ${piSessionKey}`);
    } catch (e) {
      console.error(`[pi-hmem] session_start writeSessionMarker FAILED: ${e}`);
    }
  });

  // ── 2. before_agent_start: inject skill + startup context + reminders ──
  pi.on("before_agent_start", async (event) => {
    turnCount++;

    const hmemPath = resolveHmemPath();
    const { interval, mode } = readCheckpointConfig(hmemPath);

    let addition = "";

    // Inject hmem-using-hmem skill as <important-reminder> (first turn only)
    if (turnCount === 1) {
      try {
        const skill = readFileSync(SKILL_PATH, "utf8");
        addition += `\n\n<important-reminder>\n${skill}\n</important-reminder>`;
      } catch {
        // Skill file not found — skip
      }

      if (startupContext) {
        addition += `\n\n${startupContext}`;
      }
    }

    // Checkpoint reminder (every N turns, remind mode only)
    if (mode === "remind" && interval > 0 && turnCount > 1 && turnCount % interval === 0) {
      addition +=
        "\n\nCHECKPOINT: You have been working for a while. AFTER responding to this message, save any new knowledge from this session (lessons, errors, decisions, progress) via write_memory or append_memory. You MUST do this — it is your only way to remember across sessions.";
    }

    // Context warning (after 60 turns, every 5 turns)
    if (turnCount >= 60 && turnCount % 5 === 0) {
      addition +=
        "\n\nCONTEXT WARNING: This session has been running for a long time. Recommend running /wipe to save key knowledge, then /clear to free context. Performance degrades significantly in very long sessions.";
    }

    if (!addition) return;
    return { systemPrompt: event.systemPrompt + addition };
  });

  // ── 3. tool_call: block direct .hmem file reads ────────────────────────
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("read", event)) return;
    const filePath = event.input.path ?? "";
    if (!filePath.endsWith(".hmem")) return;
    return {
      block: true,
      reason:
        "Direct .hmem file access is blocked. Use hmem MCP tools instead: " +
        "read_memory(), search_memory(), load_project(), or the /hmem-read skill. " +
        "Raw .hmem files are SQLite databases — reading them directly bypasses filtering, FTS5 search, and sync.",
    };
  });

  // ── 4. session_before_compact: context-inject + deactivate + checkpoint ──
  pi.on("session_before_compact", async () => {
    lastLogTime = Date.now();
    // Run checkpoint to summarize any remaining unsummarized exchanges
    spawnCheckpoint(piSessionKey);
    await runHmem(["context-inject"], "{}", 10_000).catch(() => {});
    await runHmem(["deactivate"], "{}", 5_000).catch(() => {});
  });

  // ── 5. agent_end: log exchange after every agent response ──────────────
  pi.on("agent_end", async (event) => {
    console.error(`[pi-hmem] agent_end fired, piSessionKey=${piSessionKey}`);
    // Debounce: skip if session_before_compact just ran
    if (Date.now() - lastLogTime < 5_000) {
      console.error(`[pi-hmem] agent_end SKIPPED: debounce (lastLogTime=${lastLogTime})`);
      return;
    }
    lastLogTime = Date.now();

    const messages = event.messages;

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

    const userText = extractText(lastUser?.content ?? "");
    const assistantText = extractText(lastAssistant?.content ?? "");

    console.error(`[pi-hmem] agent_end: userText.length=${userText.length}, assistantText.length=${assistantText.length}`);

    if (!userText || !assistantText) {
      console.error(`[pi-hmem] agent_end SKIPPED: missing user or assistant text`);
      return;
    }

    // Skip internal hook/manual commands (shouldn't happen in pi, but be safe)
    if (userText.length < 2) {
      console.error(`[pi-hmem] agent_end SKIPPED: userText too short`);
      return;
    }

    const input = JSON.stringify({
      last_user_message: userText,
      last_assistant_message: assistantText,
      session_id: piSessionKey,
    });
    console.error(`[pi-hmem] agent_end calling hmem log-exchange with session_id=${piSessionKey}`);

    const result = await runHmem(
      ["log-exchange"],
      input,
      10_000
    ).catch((e) => {
      console.error(`[pi-hmem] agent_end runHmem FAILED: ${e}`);
      return "";
    });

    console.error(`[pi-hmem] agent_end result: "${result.substring(0, 100)}"`);

    // If batch is full, spawn checkpoint subagent (matching Claude Code auto mode)
    if (result.includes('"decision":"block"') || result.includes("Batch")) {
      console.error(`[pi-hmem] agent_end spawning checkpoint`);
      spawnCheckpoint(piSessionKey);
    }
  });

  // ── 5b. turn_end: debug probe to verify the event fires ──
  pi.on("turn_end", async (event) => {
    console.error(`[pi-hmem] turn_end fired, turnIndex=${event.turnIndex}, hasMessage=${!!event.message}`);
  });

  // ── 6. session_shutdown: title untitled O-entries ─────────────────────
  pi.on("session_shutdown", async () => {
    // Best-effort: title O-entries that are still "unassigned"
    await titleUntitledOEntries().catch(() => {});
  });
}

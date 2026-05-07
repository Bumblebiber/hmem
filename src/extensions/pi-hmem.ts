import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/extensions/ → ../../skills/hmem-using-hmem/SKILL.md
const SKILL_PATH = join(__dirname, "../../skills/hmem-using-hmem/SKILL.md");

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

export default async function (pi: ExtensionAPI) {
  let startupContext = "";
  let injected = false;
  let lastLogTime = 0;

  // ── 1. Session start: run hook-startup once to get memory context ──────────
  pi.on("session_start", async (event) => {
    if (event.reason !== "startup") return;
    try {
      const raw = await runHmem(["hook-startup"], "{}", 5_000);
      const parsed = JSON.parse(raw);
      startupContext = parsed?.hookSpecificOutput?.additionalContext ?? "";
    } catch {
      // hmem not available or errored — skip silently
    }
  });

  // ── 2. before_agent_start: inject skill + startup context (first turn only) ─
  pi.on("before_agent_start", async (event) => {
    if (injected) return;
    injected = true;

    let addition = "";

    // Inject hmem-using-hmem skill as <important-reminder>
    try {
      const skill = readFileSync(SKILL_PATH, "utf8");
      addition += `\n\n<important-reminder>\n${skill}\n</important-reminder>`;
    } catch {
      // Skill file not found — skip
    }

    if (startupContext) {
      addition += `\n\n${startupContext}`;
    }

    if (!addition) return;
    return { systemPrompt: event.systemPrompt + addition };
  });

  // ── 3. tool_call: block direct .hmem file reads ───────────────────────────
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

  // ── 4. session_before_compact: checkpoint + context-inject + deactivate ────
  pi.on("session_before_compact", async () => {
    lastLogTime = Date.now();
    await runHmem(["log-exchange"], "{}", 10_000).catch(() => {});
    await runHmem(["context-inject"], "{}", 10_000).catch(() => {});
    await runHmem(["deactivate"], "{}", 5_000).catch(() => {});
  });

  // ── 5. agent_end: checkpoint after every agent response ───────────────────
  pi.on("agent_end", async (event) => {
    // Debounce: skip if session_before_compact just ran
    if (Date.now() - lastLogTime < 5_000) return;
    lastLogTime = Date.now();

    const messages = event.messages;

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

    const userText = extractText(lastUser?.content ?? "");
    const assistantText = extractText(lastAssistant?.content ?? "");

    if (!userText || !assistantText) return;

    await runHmem(
      ["log-exchange"],
      JSON.stringify({ last_user_message: userText, last_assistant_message: assistantText }),
      10_000
    ).catch(() => {});
  });
}

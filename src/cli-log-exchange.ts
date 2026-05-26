/**
 * cli-log-exchange.ts
 *
 * Called by Claude Code's Stop hook after every agent response.
 * Reads the last user message from the session JSONL transcript,
 * combines it with the agent's response (from stdin hook JSON),
 * and appends both to the immutable v2 events log keyed by session_id.
 *
 * v2 model: events are appended unconditionally under the session_id. Project
 * attribution is *derived later* from `session_bindings` (master-plan Goal #2) —
 * there is no active-project lookup at log time, and therefore no O0000 fallback
 * that could silently drop an exchange. The rolling summarizer runs on cadence
 * via `summarizer.maybeCheckpoint` inside `logStop`.
 *
 * Usage: echo '{"transcript_path":"...","last_assistant_message":"..."}' | hmem log-exchange
 *
 * Requires env:
 *   HMEM_PATH        — path to .hmem file (auto-detected)
 *   HMEM_PROJECT_DIR — directory for config + company.hmem
 */

import fs from "node:fs";
import path from "node:path";
import { createV2Store } from "./v2/store-facade.js";
import { getSchemaMajor, V1FileError } from "./store/db.js";
import { logStop } from "./hooks/stop-log.js";
import { loadHmemConfig, type HmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";
import { writeDiagnostic } from "./diagnostics.js";
import { readLastUserMessage, readLastAssistantMessage, isSubagentTranscript } from "./hooks/transcript.js";

interface HookInput {
  transcript_path?: string;
  last_assistant_message?: string;
  /** Direct mode (e.g. OpenCode plugin): bypass transcript_path lookup. */
  last_user_message?: string;
  stop_hook_active?: boolean;
  session_id?: string;
}

/** Auto-extract a short title from text (first line, max 80 chars). */
function extractTitle(text: string): string {
  const firstLine = text.split("\n")[0].trim().replace(/[<>\[\]]/g, "");
  if (firstLine.length <= 80) return firstLine;
  const lastSpace = firstLine.substring(0, 80).lastIndexOf(" ");
  return (lastSpace > 40 ? firstLine.substring(0, lastSpace) : firstLine.substring(0, 80));
}

/**
 * Testable core: open the v2 store at `hmemPath` and append the exchange to the
 * events log via the shared v2 Stop-hook path (`logStop`). When the file is not a
 * schema_major=2 store (defensive — should never happen after the v1→v2 cutover)
 * the write is skipped and `wrote` is `false`.
 *
 * Deliberately performs NO diagnostics/env side-effects so it is safe to call
 * from tests against a temp DB.
 */
export async function appendExchangeV2Path(
  hmemPath: string,
  config: HmemConfig,
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<{ wrote: boolean; schemaMajor: string | null }> {
  let store: ReturnType<typeof createV2Store>;
  try {
    store = createV2Store(hmemPath, config);
  } catch (e) {
    // A v1 file (openDb throws V1FileError) → no-op with the empty "not v2" contract;
    // the Stop exchange-log hook must never crash the harness for an un-migrated user.
    if (e instanceof V1FileError) return { wrote: false, schemaMajor: "1" };
    throw e;
  }
  try {
    const schemaMajor = getSchemaMajor(store.db);
    if (schemaMajor !== "2") return { wrote: false, schemaMajor };
    await logStop({ store, sessionId, userText, assistantText });
    return { wrote: true, schemaMajor };
  } finally {
    store.close();
  }
}

export async function logExchange(): Promise<void> {
  // Read hook JSON from stdin synchronously (hook pipes JSON in one shot).
  // When invoked from a TTY (manual run), sync-reading fd 0 blocks forever — bail out.
  if (process.stdin.isTTY) process.exit(0);
  let input: HookInput;
  try {
    const data = fs.readFileSync(0, "utf8"); // fd 0 = stdin
    input = JSON.parse(data || "{}");
  } catch {
    process.exit(0);
  }

  // Resolve env defaults (HMEM_PATH, HMEM_PROJECT_DIR)
  resolveEnvDefaults();

  // Guards
  if (input.stop_hook_active) process.exit(0);
  if (process.env.HMEM_NO_SESSION === "1") process.exit(0);

  const directMode = !!input.last_user_message;
  if (!directMode && !input.transcript_path) process.exit(0);

  // Fallback: if last_assistant_message is missing (e.g. channel sessions),
  // read it from the transcript
  if (!input.last_assistant_message && input.transcript_path) {
    input.last_assistant_message = readLastAssistantMessage(input.transcript_path) || "";
  }
  if (!input.last_assistant_message) process.exit(0);

  // Skip subagent sessions — their transcripts are in /tmp/claude-* task directories
  // and contain MCP tool calls, not real user conversation
  if (isSubagentTranscript(input.transcript_path)) process.exit(0);

  const userMessage = directMode
    ? input.last_user_message!
    : readLastUserMessage(input.transcript_path!);
  if (!userMessage) process.exit(0);

  // Skip empty exchanges and internal hook prompts
  if (userMessage.length < 2) process.exit(0);
  if (userMessage.startsWith("Generate a concise one-line title")) process.exit(0);

  // v2 events are keyed by session_id. Without one we have no place to land the
  // exchange; bail rather than guess.
  const claudeSessionId = input.session_id;
  if (!claudeSessionId) process.exit(0);

  // Open hmem store
  const projectDir = process.env.HMEM_PROJECT_DIR;
  if (!projectDir) process.exit(0);

  const hmemPath = process.env.HMEM_PATH!;
  if (!fs.existsSync(hmemPath)) process.exit(0);

  const hmemConfig = loadHmemConfig(path.dirname(hmemPath));

  try {
    const { wrote, schemaMajor } = await appendExchangeV2Path(
      hmemPath,
      hmemConfig,
      claudeSessionId,
      userMessage,
      input.last_assistant_message!,
    );

    writeDiagnostic({
      op: "log-exchange",
      sessionId: claudeSessionId,
      hmemPath,
      schemaMajor,
      title: extractTitle(userMessage),
      warning: wrote ? undefined : "skipped-non-v2-store",
    });
  } catch (e) {
    // DB locked (Windows WAL locking) or other open failure → queue for later
    const pendingPath = path.join(path.dirname(hmemPath), "pending-exchanges.jsonl");
    const entry = {
      ts: new Date().toISOString(),
      userMessage,
      agentMessage: input.last_assistant_message,
      transcriptPath: input.transcript_path,
    };
    try { fs.appendFileSync(pendingPath, JSON.stringify(entry) + "\n"); } catch { /* best effort */ }
    console.error(`[hmem log-exchange] write failed, queued to ${pendingPath}: ${e}`);
    process.exit(0);
  }
}

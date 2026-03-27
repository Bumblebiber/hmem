/**
 * cli-log-exchange.ts
 *
 * Called by Claude Code's Stop hook after every agent response.
 * Reads the last user message from the session JSONL transcript,
 * combines it with the agent's response (from stdin hook JSON),
 * and appends both to the currently active O-entry.
 *
 * Usage: echo '{"transcript_path":"...","last_assistant_message":"..."}' | hmem log-exchange
 *
 * Requires env:
 *   HMEM_PROJECT_DIR — root directory for .hmem files
 *   HMEM_AGENT_ID    — agent identifier (optional)
 */
export declare function logExchange(): Promise<void>;

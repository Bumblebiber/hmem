import { currentSessionId } from '../session-state.js';

/**
 * Resolve the current session-id for v2 MCP tools.
 * Phase 4 bridge: env override (set by Phase 5 hooks / wrappers) → ppid-bridge file.
 * Returns undefined when no session context exists; callers that require one
 * (e.g. `activate`) create a session and proceed.
 */
export function resolveSessionId(): string | undefined {
  const env = process.env.HMEM_SESSION_ID;
  if (env && env.trim()) return env.trim();
  return currentSessionId();
}

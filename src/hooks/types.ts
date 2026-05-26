import type { V2Store } from '../v2/store-facade.js';

export type Harness = 'claude-code' | 'hermes' | 'pi';
export type HookEvent = 'session-start' | 'stop' | 'prompt-submit';

/** Everything a hook core needs, parsed by a shim from harness stdin. */
export interface HookContext {
  harness: Harness;
  sessionId: string;
  cwd?: string;
  /** Explicit project label, only when a shim is configured with one (env/config). */
  namedProject?: string;
  /** I-entry uid of the active device, if known. */
  deviceId?: string;
  /** Stop only: the JSONL transcript path (Claude Code) for last-message extraction. */
  transcriptPath?: string;
  /** Stop only: the agent's final message, when the harness provides it directly. */
  lastAssistantMessage?: string;
  /** Stop only: harness re-entrancy guard. */
  stopHookActive?: boolean;
  /** SessionStart only: 'startup' | 'resume' | 'clear' | 'compact'. */
  source?: string;
}

export type BindingSource = 'resume' | 'named' | 'workspace' | 'none';

export interface BindingResult {
  sessionId: string;
  projectUid: string | null;
  projectLabel: string | null;
  source: BindingSource;
}

export interface SessionStartResult {
  sessionId: string;
  projectLabel: string | null;
  bindingSource: BindingSource;
  /** The full brief injected verbatim by the shim — the only thing the agent reads. */
  context: string;
}

export interface GitPendingWork {
  uncommitted: string[];      // porcelain file lines
  stashes: string[];          // `git stash list` lines
  worktrees: string[];        // `git worktree list` lines (excluding the main one)
  unmergedBranches: string[]; // branches not merged into main/master
  isRepo: boolean;
}

export type GitProbe = (cwd: string) => GitPendingWork;
export type StringProbe = () => string;

export interface SessionStartDeps {
  gitProbe?: GitProbe;
  syncProbe?: StringProbe;
  deviceProbe?: StringProbe;
}

export interface StopContext {
  store: V2Store;
  sessionId: string;
  userText: string;
  assistantText: string;
}

export type SummarizeFn = (events: import('../store/types.js').EventRow[]) => string | Promise<string>;

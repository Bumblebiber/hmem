// src/hooks/prompt-submit.ts
import type { V2Store } from '../v2/store-facade.js';
import type { StringProbe } from './types.js';
import { defaultSyncProbe } from './stable-context.js';

export interface PromptSubmitInput { store: V2Store; sessionId: string; syncProbe?: StringProbe; }
export interface PromptSubmitResult { context: string; }

/**
 * UserPromptSubmit is intentionally minimal: sync status only (master-plan Phase 5).
 * Defaults to the real `defaultSyncProbe()` (reads ~/.hmem/config.json) — tests inject
 * a stub. (Previously hardcoded "nicht konfiguriert", which always reported wrong status.)
 */
export function buildPromptSubmit(input: PromptSubmitInput): PromptSubmitResult {
  const sync = input.syncProbe ? input.syncProbe() : defaultSyncProbe();
  return { context: sync };
}

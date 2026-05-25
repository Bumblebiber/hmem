// src/hooks/prompt-submit.ts
import type { V2Store } from '../v2/store-facade.js';
import type { StringProbe } from './types.js';

export interface PromptSubmitInput { store: V2Store; sessionId: string; syncProbe?: StringProbe; }
export interface PromptSubmitResult { context: string; }

/** UserPromptSubmit is intentionally minimal: sync status only (master-plan Phase 5). */
export function buildPromptSubmit(input: PromptSubmitInput): PromptSubmitResult {
  const sync = input.syncProbe ? input.syncProbe() : '🔴 hmem-sync nicht konfiguriert.';
  return { context: sync };
}

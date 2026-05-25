// src/hooks/summarizer-pick.ts
import type { HmemConfig } from '../hmem-config.js';
import type { SummarizeFn } from './types.js';
import { fallbackSummarize } from '../v2/summarize-adapter.js';
import { makeAnthropicSummarizer } from '../summarize/anthropic.js';

/**
 * Choose the segment summarizer. Real Haiku is opt-in (checkpointMode='auto') so unit
 * tests with DEFAULT_CONFIG never hit the network even when ANTHROPIC_API_KEY is set.
 * OpenAI provider has no adapter yet → falls back (TODO Phase 6+).
 */
export function pickSummarizer(config: HmemConfig): SummarizeFn {
  if (config.checkpointMode === 'auto' && config.checkpointProvider === 'anthropic') {
    const keyEnv = config.checkpointApiKeyEnv ?? 'ANTHROPIC_API_KEY';
    const apiKey = process.env[keyEnv];
    if (apiKey && apiKey.trim()) {
      return makeAnthropicSummarizer({ model: config.checkpointModel, apiKey });
    }
  }
  return fallbackSummarize;
}

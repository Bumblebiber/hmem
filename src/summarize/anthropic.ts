/**
 * hmem v2 — the real Haiku summarizer behind the DI seam (`Summarizer`).
 *
 * A thin, key-gated wrapper over `@anthropic-ai/sdk`: it renders the segment's
 * events into a compact transcript and asks the model for a 1–3 sentence project-log
 * summary. The SDK call shape mirrors v1's `cli-checkpoint-agent.ts` Anthropic loop
 * (`new Anthropic({ apiKey }).messages.create({ model, max_tokens, messages })`).
 *
 * This module is wired but NOT content-tested — the deterministic stub in
 * `loop.test.ts` covers the loop's logic; here we only assert constructability and
 * (opt-in, behind an API key) a live non-empty round-trip.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { EventRow } from '../store/types.js';
import type { Summarizer } from './loop.js';

export interface AnthropicSummarizerOpts {
  model: string;
  apiKey: string;
  /** Output cap; defaults to 512 tokens (a project-log one-liner needs little). */
  maxTokens?: number;
}

/** Per-event content cap when building the transcript (mirrors v1's ~1200 chars). */
const CHAR_CAP = 1200;

export function makeAnthropicSummarizer(opts: AnthropicSummarizerOpts): Summarizer {
  if (!opts.apiKey) {
    throw new Error('makeAnthropicSummarizer: an Anthropic API key is required (ANTHROPIC_API_KEY)');
  }
  const client = new Anthropic({ apiKey: opts.apiKey });
  const maxTokens = opts.maxTokens ?? 512;

  return async (events: EventRow[]): Promise<string> => {
    const transcript = events
      .map((e) => `${e.role}: ${e.content.slice(0, CHAR_CAP)}`)
      .join('\n');
    const prompt = `Summarize this session segment in 1–3 sentences for a project log.\n\n${transcript}`;
    const response = await client.messages.create({
      model: opts.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  };
}

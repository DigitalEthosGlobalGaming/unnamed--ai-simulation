import { CACHED_PARTS, PROMPT_ORDER, type PromptParts } from '@uas/core';

/** Cached prefix (rules, sheet, beliefs) becomes the system message; the fresh suffix the user message. */
export function renderPrompt(p: PromptParts): { system: string; user: string } {
  const blocks = PROMPT_ORDER.map((k) => p[k]);
  return { system: blocks.slice(0, CACHED_PARTS).join('\n\n'), user: blocks.slice(CACHED_PARTS).join('\n\n') };
}

/** Rough token estimate (4 chars per token) for adapters whose backend doesn't report usage. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

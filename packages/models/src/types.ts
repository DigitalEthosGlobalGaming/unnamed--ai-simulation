import type { z } from 'zod';
import type { PromptParts, Usage } from '@uas/core';

export type { PromptParts, Usage };

/** Spec interface: bounded choices with confidence instead of generated text. */
export interface DecisionModel {
  id: string;
  decide<T extends string>(req: {
    context: PromptParts;
    question: string;
    options: { id: T; label: string }[];
    multi?: { max: number };
    /** Cancels the underlying request (the gateway aborts on timeout so Ollama stops working on it). */
    signal?: AbortSignal;
  }): Promise<{ choices: { id: T; p: number }[]; confidence: number; usage: Usage }>;
  score(req: { context: PromptParts; question: string; signal?: AbortSignal }): Promise<{ value: number; confidence: number; usage: Usage }>;
}

/** Spec interface: structured generation against a Zod schema. */
export interface ChatModel {
  id: string;
  generate<S extends z.ZodTypeAny>(req: {
    context: PromptParts;
    instruction: string;
    schema: S;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<{ object: z.infer<S>; usage: Usage }>;
}

/** Raw token counts an adapter measured; the meter turns them into a priced `Usage`. */
export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** The provider's own billed cost in USD, when it reports one (AI Gateway does); overrides the price table. */
  costUsd?: number;
}

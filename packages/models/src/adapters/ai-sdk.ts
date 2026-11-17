import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, Output, type LanguageModel } from 'ai';
import type { z } from 'zod';
import { renderPrompt } from '../render.ts';
import type { ChatModel, PromptParts } from '../types.ts';
import type { Pricer } from './common.ts';

export type AiSdkProvider = 'anthropic';

/**
 * Any Vercel AI SDK provider. Anthropic is wired in; others need their `@ai-sdk/*` package
 * and a line in `languageModel()`. The cached prefix is the system message, marked for
 * Anthropic prompt caching.
 */
export class AiSdkChatModel implements ChatModel {
  readonly id: string;
  private readonly model: LanguageModel;
  private readonly price: Pricer;

  constructor(opts: { id?: string; provider: AiSdkProvider; model: string; apiKey?: string; price: Pricer; languageModel?: LanguageModel }) {
    this.id = opts.id ?? `${opts.provider}:${opts.model}`;
    this.price = opts.price;
    this.model = opts.languageModel ?? createAnthropic(opts.apiKey ? { apiKey: opts.apiKey } : {})(opts.model);
  }

  async generate<S extends z.ZodTypeAny>(req: { context: PromptParts; instruction: string; schema: S; maxOutputTokens?: number; signal?: AbortSignal }) {
    const started = performance.now();
    const { system, user } = renderPrompt(req.context);
    const result = await generateText({
      model: this.model,
      output: Output.object({ schema: req.schema }),
      ...(req.maxOutputTokens && { maxOutputTokens: req.maxOutputTokens }),
      ...(req.signal && { abortSignal: req.signal }),
      messages: [
        { role: 'system', content: system, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
        { role: 'user', content: `${user}\n\n${req.instruction}` },
      ],
    });
    const u = result.usage;
    const cached = u.inputTokenDetails?.cacheReadTokens ?? 0;
    const usage = this.price(this.id, {
      inputTokens: u.inputTokenDetails?.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cached),
      cachedInputTokens: cached,
      outputTokens: u.outputTokens ?? 0,
      latencyMs: Math.round(performance.now() - started),
    });
    return { object: result.output as z.infer<S>, usage };
  }
}

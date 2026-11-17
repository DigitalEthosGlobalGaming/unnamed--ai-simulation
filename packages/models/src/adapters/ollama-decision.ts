import { estimateTokens } from '../render.ts';
import type { DecisionModel, PromptParts } from '../types.ts';
import { postJson, SCORE_LEVELS, type Fetch, type Pricer } from './common.ts';

interface SystemOneAnswer {
  type?: string;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number> | number[];
  confidence?: number;
}
/**
 * TypeSafe System One shape: verified against Ollama 0.40.16 (Tev1, Laya); AI Gateway's
 * TypeSafe-compatible API documents the same shape plus `provider_metadata.gateway.cost` (USD).
 */
interface SystemOneResponse {
  model?: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  provider_metadata?: { gateway?: { cost?: string } };
}

export interface SystemOneOptions {
  id?: string;
  /** Base URL; the request goes to `${url}/v1/systemone`. Ollama: http://localhost:11434. AI Gateway: https://ai-gateway.vercel.sh/typesafe */
  url: string;
  model: string;
  price: Pricer;
  /** Sent as `Authorization: Bearer` (hosted). Never logged. */
  apiKey?: string;
  fetch?: Fetch;
  maxStateChars?: number;
}

/**
 * Decision models over the TypeSafe System One API (`POST /v1/systemone`): open models (Laya,
 * Tev1) served by Ollama, called over HTTP because they aren't in the Ollama JS library, and
 * hosted ones (Jev, Laya) through AI Gateway's TypeSafe-compatible endpoint.
 */
export class SystemOneDecisionModel implements DecisionModel {
  readonly id: string;
  private readonly opts: SystemOneOptions;

  constructor(opts: SystemOneOptions) {
    this.id = opts.id ?? `systemone:${opts.model}`;
    this.opts = opts;
  }

  /**
   * A short state: decision models have small budgets (Laya: 512 tokens per question including the
   * options) and CPU prompt processing costs ~1.5-4 s per 100 tokens locally. Options go in
   * `criteria`, so they're cut from the state. The day-stable beliefs go first and the fresh state
   * last, so a prefix cache (Ollama) can reuse the start; when space is short, beliefs are trimmed first.
   */
  private state(context: PromptParts): string {
    const max = this.opts.maxStateChars ?? 1200;
    const observations = context.observations.split('\nOptions:')[0]!;
    const recent = context.shortTerm.split('\n').slice(-5).join('\n');
    const fresh = [recent, observations, context.state, context.question].join('\n\n');
    const freshPart = fresh.length > max ? fresh.slice(fresh.length - max) : fresh;
    const room = max - freshPart.length - 2;
    const beliefs = room > 60 ? context.beliefs.slice(0, room) : '';
    return beliefs ? `${beliefs}\n\n${freshPart}` : freshPart;
  }

  private async call(context: PromptParts, question: Record<string, unknown>, signal?: AbortSignal) {
    const started = performance.now();
    const state = this.state(context);
    const res = await postJson<SystemOneResponse>(
      this.opts.fetch ?? fetch,
      `${this.opts.url}/v1/systemone`,
      { model: this.opts.model, state, questions: { q: question } },
      signal,
      this.opts.apiKey,
    );
    const answer = res.answers?.q;
    if (!answer) throw new Error(`systemone: no answer in ${JSON.stringify(res).slice(0, 200)}`);
    const usage = this.opts.price(this.id, {
      inputTokens: res.usage?.input_tokens ?? estimateTokens(state),
      cachedInputTokens: 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      latencyMs: Math.round(performance.now() - started),
      ...(res.provider_metadata?.gateway?.cost !== undefined && { costUsd: Number(res.provider_metadata.gateway.cost) }),
    });
    return { answer, usage };
  }

  async decide<T extends string>(req: { context: PromptParts; question: string; options: { id: T; label: string }[]; multi?: { max: number }; signal?: AbortSignal }) {
    const { answer, usage } = await this.call(req.context, {
      type: 'choice',
      instructions: req.question,
      criteria: Object.fromEntries(req.options.map((o) => [o.id, o.label])),
    }, req.signal);
    const probs = (answer.probabilities && !Array.isArray(answer.probabilities) ? answer.probabilities : {}) as Record<string, number>;
    const ids = new Set<string>(req.options.map((o) => o.id));
    const ranked = Object.entries(probs)
      .filter(([id]) => ids.has(id))
      .sort((a, b) => b[1] - a[1]);
    const top = answer.choice && ids.has(answer.choice) ? answer.choice : ranked[0]?.[0];
    if (!top) throw new Error('systemone: choice is not one of the options');
    const max = req.multi?.max ?? 1;
    const choices = [{ id: top as T, p: probs[top] ?? answer.confidence ?? 1 }];
    for (const [id, p] of ranked) {
      if (choices.length >= max) break;
      // Follow-on actions only when Tev1 is fairly sure about them too.
      if (id !== top && p >= 0.25) choices.push({ id: id as T, p });
    }
    return { choices, confidence: answer.confidence ?? choices[0]!.p, usage };
  }

  async score(req: { context: PromptParts; question: string; signal?: AbortSignal }) {
    const { answer, usage } = await this.call(req.context, { type: 'score', instructions: req.question, criteria: SCORE_LEVELS }, req.signal);
    if (typeof answer.score !== 'number') throw new Error('systemone: score missing');
    return { value: Math.min(1, Math.max(0, answer.score / (SCORE_LEVELS.length - 1))), confidence: answer.confidence ?? 1, usage };
  }
}

/** The same adapter pointed at a local Ollama (kept for existing imports). */
export class OllamaDecisionModel extends SystemOneDecisionModel {}

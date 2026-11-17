import { z } from 'zod';
import { renderPrompt } from '../render.ts';
import type { ChatModel, PromptParts } from '../types.ts';
import type { Fetch, Pricer } from './common.ts';

interface ChatCompletion {
  choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
  /** AI Gateway adds `cost` (USD) to usage. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } };
  provider_metadata?: { gateway?: { cost?: string } };
}

export interface OpenAiCompatibleOptions {
  id?: string;
  /** e.g. https://ai-gateway.vercel.sh/v1 ; the request goes to `${baseUrl}/chat/completions`. */
  baseUrl: string;
  model: string;
  price: Pricer;
  /** Sent as `Authorization: Bearer`. Never logged. */
  apiKey?: string;
  /**
   * How to get JSON: `json_schema` (structured output), `tools` (a forced function call), or
   * `prompt` (the schema in the prompt, JSON extracted from plain text). Through AI Gateway,
   * meta/llama-3.1-8b returned `{}` for json_schema and HTTP 400 for forced tools (2026-11-17),
   * so it uses `prompt`.
   */
  structured?: Mode;
  /** AI Gateway provider preference, e.g. ['novita', 'bedrock'] (sent as providerOptions.gateway.order). */
  providerOrder?: string[];
  fetch?: Fetch;
}

type Mode = 'json_schema' | 'tools' | 'prompt';
const FALLBACK: Record<Mode, Mode> = { json_schema: 'prompt', tools: 'prompt', prompt: 'prompt' };

/**
 * Any OpenAI-compatible Chat Completions endpoint (AI Gateway's `/v1`). The cached prefix is the
 * system message and goes first, so provider prompt caching applies; cached input tokens are
 * read from `usage.prompt_tokens_details.cached_tokens` and priced at the cached rate.
 * If structured output comes back unusable, it retries once with the other method.
 */
export class OpenAiCompatibleChatModel implements ChatModel {
  readonly id: string;
  private readonly opts: OpenAiCompatibleOptions;

  constructor(opts: OpenAiCompatibleOptions) {
    this.id = opts.id ?? `openai-compatible:${opts.model}`;
    this.opts = opts;
  }

  async generate<S extends z.ZodTypeAny>(req: { context: PromptParts; instruction: string; schema: S; maxOutputTokens?: number; signal?: AbortSignal }) {
    const started = performance.now();
    const first = this.opts.structured ?? 'json_schema';
    try {
      return await this.attempt(req, first, started);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || /HTTP (401|403|429)/.test((e as Error).message)) throw e;
      return this.attempt(req, FALLBACK[first], started);
    }
  }

  private async attempt<S extends z.ZodTypeAny>(
    req: { context: PromptParts; instruction: string; schema: S; maxOutputTokens?: number; signal?: AbortSignal },
    mode: Mode,
    started: number,
  ) {
    const { system, user } = renderPrompt(req.context);
    const { $schema: _meta, ...schema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
    const asText = mode === 'prompt' ? `\nReply with only a JSON object (no prose) that matches this JSON Schema:\n${JSON.stringify(schema)}` : '';
    const body = {
      model: this.opts.model,
      temperature: 0,
      ...(req.maxOutputTokens && { max_tokens: req.maxOutputTokens }),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${user}\n\n${req.instruction}${asText}` },
      ],
      ...(mode === 'json_schema' && { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: false } } }),
      ...(mode === 'tools' && {
        tools: [{ type: 'function', function: { name: 'answer', description: 'Give your answer.', parameters: schema } }],
        tool_choice: { type: 'function', function: { name: 'answer' } },
      }),
      ...(this.opts.providerOrder && { providerOptions: { gateway: { order: this.opts.providerOrder } } }),
    };
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.opts.apiKey && { authorization: `Bearer ${this.opts.apiKey}` }) },
      body: JSON.stringify(body),
      ...(req.signal && { signal: req.signal }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.opts.baseUrl}/chat/completions -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text) as ChatCompletion;
    const msg = data.choices?.[0]?.message;
    const raw = mode === 'tools' ? msg?.tool_calls?.[0]?.function?.arguments : msg?.content;
    const object = req.schema.parse(JSON.parse(extractJson(raw ?? ''))) as z.infer<S>;
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage = this.opts.price(this.id, {
      inputTokens: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached),
      cachedInputTokens: cached,
      outputTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Math.round(performance.now() - started),
      ...(typeof data.usage?.cost === 'number'
        ? { costUsd: data.usage.cost }
        : data.provider_metadata?.gateway?.cost !== undefined && { costUsd: Number(data.provider_metadata.gateway.cost) }),
    });
    return { object, usage };
  }
}

/** The JSON object in a reply: fenced or not, possibly with prose around it. */
function extractJson(s: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const text = fenced ? fenced[1]! : s;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

import { z } from 'zod';
import { renderPrompt } from '../render.ts';
import type { ChatModel, PromptParts } from '../types.ts';
import { postJson, type Fetch, type Pricer } from './common.ts';

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Small local model (llama3.2:1b) via Ollama `/api/chat`, always with a JSON-schema `format`. */
export class LocalChatModel implements ChatModel {
  readonly id: string;
  private readonly opts: { url: string; model: string; price: Pricer; fetch?: Fetch; numCtx?: number; numThread?: number; think?: boolean };

  constructor(opts: { id?: string; url: string; model: string; price: Pricer; fetch?: Fetch; numCtx?: number; numThread?: number; think?: boolean }) {
    this.id = opts.id ?? `local:${opts.model}`;
    this.opts = opts;
  }

  async generate<S extends z.ZodTypeAny>(req: { context: PromptParts; instruction: string; schema: S; maxOutputTokens?: number; signal?: AbortSignal }) {
    const started = performance.now();
    const { system, user } = renderPrompt(req.context);
    const format = z.toJSONSchema(req.schema);
    const res = await postJson<OllamaChatResponse>(this.opts.fetch ?? fetch, `${this.opts.url}/api/chat`, {
      model: this.opts.model,
      stream: false,
      format,
      // Thinking models (qwen3.5) spend most of their time on hidden reasoning otherwise.
      ...((this.opts.think ?? !this.opts.model.startsWith('qwen')) ? {} : { think: false }),
      options: { temperature: 0, num_ctx: this.opts.numCtx ?? 2048, ...(this.opts.numThread && { num_thread: this.opts.numThread }), ...(req.maxOutputTokens && { num_predict: req.maxOutputTokens }) },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${user}\n\n${req.instruction}\nAnswer with JSON only.` },
      ],
    }, req.signal);
    const object = req.schema.parse(JSON.parse(res.message?.content ?? '')) as z.infer<S>;
    const usage = this.opts.price(this.id, {
      // Ollama reports only newly evaluated prompt tokens; a reused KV cache shows up as fewer of them.
      inputTokens: res.prompt_eval_count ?? 0,
      cachedInputTokens: 0,
      outputTokens: res.eval_count ?? 0,
      latencyMs: Math.round(performance.now() - started),
    });
    return { object, usage };
  }
}

import { z } from 'zod';
import type { ChatModel, DecisionModel, PromptParts, Usage } from '../types.ts';

/**
 * Any ChatModel answering with a Zod enum of option IDs. The providers used here don't
 * return logprobs through structured output, so confidence is 1.
 */
export class LlmAsDecisionModel implements DecisionModel {
  readonly id: string;
  private readonly chat: ChatModel;

  constructor(chat: ChatModel) {
    this.chat = chat;
    this.id = `${chat.id}:as-decision`;
  }

  async decide<T extends string>(req: { context: PromptParts; question: string; options: { id: T; label: string }[]; multi?: { max: number }; signal?: AbortSignal }) {
    const ids = req.options.map((o) => o.id) as [T, ...T[]];
    const max = req.multi?.max ?? 1;
    const schema = z.object({ choices: z.array(z.enum(ids)).min(1).max(max) });
    const list = req.options.map((o) => `${o.id}: ${o.label}`).join('\n');
    const { object, usage } = await this.chat.generate({
      context: req.context,
      instruction: `${req.question}\nOptions:\n${list}\nPick ${max === 1 ? 'one option id' : `1 to ${max} option ids, in order`}.`,
      schema,
      maxOutputTokens: 60,
      ...(req.signal && { signal: req.signal }),
    });
    const unique = [...new Set(object.choices as T[])];
    return { choices: unique.map((id) => ({ id, p: 1 })), confidence: 1, usage: usage as Usage };
  }

  async score(req: { context: PromptParts; question: string; signal?: AbortSignal }) {
    const { object, usage } = await this.chat.generate({
      context: req.context,
      instruction: `${req.question}\nAnswer with a number from 0 to 1.`,
      schema: z.object({ value: z.number().min(0).max(1) }),
      maxOutputTokens: 20,
      ...(req.signal && { signal: req.signal }),
    });
    return { value: object.value, confidence: 1, usage };
  }
}

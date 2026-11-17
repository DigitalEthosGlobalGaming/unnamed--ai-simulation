import type { z } from 'zod';
import { estimateTokens, renderPrompt } from '../render.ts';
import type { ChatModel, DecisionModel, PromptParts } from '../types.ts';
import type { Pricer } from './common.ts';

/**
 * A plausible stand-in brain for tests and offline worlds. It reads only what a real model
 * would see (the prompt): needs as words, beliefs, time of day and the options.
 */
export function heuristicRank(context: PromptParts, options: { id: string; label: string }[]): { id: string; value: number }[] {
  const state = context.state;
  const word = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(state)?.[1] ?? 'good';
  const lowness = (w: string) => ({ 'very low': 1, low: 0.8, 'quite low': 0.6, okay: 0.3, good: 0 })[w] ?? 0;
  const battery = lowness(word('battery'));
  const night = /it is night/.test(state);
  const evening = /evening/.test(state);
  const beliefs = context.beliefs.split('\n');
  const belief = (verb: string, type: string, when: string) => beliefs.find((l) => l.startsWith(`- ${verb} at the ${type} ${when}`));
  return options
    .map((o) => {
      const m = /^(\w+) the (\w+)/.exec(o.label);
      let value = 0;
      if (o.label.startsWith('rest')) value = night ? 0.5 : 0.2 * lowness(word('cool'));
      else if (o.label.startsWith('wait') || o.label.startsWith('stay quiet')) value = 0.01;
      else if (m) {
        const [, verb, type] = m;
        // Recent experience in short-term memory: repeats and failures put it off.
        const recent = context.shortTerm.split('\n').filter((l) => l.includes(`tried ${verb} at the ${type}`));
        value -= 0.15 * recent.length + 0.4 * recent.filter((l) => /would not|nothing|could not|dark/.test(l)).length;
        const b = belief(verb!, type!, night ? 'at night' : 'by day');
        const byDay = belief(verb!, type!, 'by day');
        const recentByDay = context.shortTerm.split('\n').some((l) => l.includes(`tried ${verb} at the ${type} by day`) && /hummed|warm/.test(l));
        const triedAtNight = recent.some((l) => l.includes('at night'));
        // Untested at night, but it charged by day: worth a try when the battery is low.
        if (!b && night && !triedAtNight && (byDay?.includes('fills my battery') || recentByDay)) value += 1.2 * battery;
        else if (!b && !night && recentByDay) value += 0.3 + 1.2 * battery; // it worked a moment ago
        else if (!b) value += 0.25 + 0.3 * lowness(word('curiosity'));
        else {
          if (b.includes('fills my battery')) value += 1.2 * battery;
          if (b.includes('drains my battery')) value -= 0.3;
          if (b.includes('is fun')) value += 0.2 + 0.4 * lowness(word('curiosity'));
          if (b.includes('cools me down')) value += 0.5 * lowness(word('cool'));
          if (b.includes('does nothing much')) value -= 0.1;
          // Foresight: charge before dusk if charging is believed not to work at night.
          const nightCharge = belief(verb!, type!, 'at night');
          if (evening && b.includes('fills my battery') && nightCharge?.includes('does nothing much')) value += battery > 0 ? 0.8 : 0.4;
        }
      } else value = 0.05;
      return { id: o.id, value };
    })
    .sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : 1));
}

function fakeTokens(context: PromptParts, extra = '') {
  const { system, user } = renderPrompt(context);
  return { inputTokens: estimateTokens(user + extra), cachedInputTokens: estimateTokens(system), outputTokens: 4, latencyMs: 0 };
}

export class FakeDecisionModel implements DecisionModel {
  readonly id: string;
  private readonly price: Pricer;
  constructor(opts: { id?: string; price: Pricer }) {
    this.id = opts.id ?? 'fake-decision';
    this.price = opts.price;
  }

  async decide<T extends string>(req: { context: PromptParts; question: string; options: { id: T; label: string }[]; multi?: { max: number } }) {
    const ranked = heuristicRank(req.context, req.options);
    const best = ranked[0]!;
    const second = ranked[1];
    const confidence = second ? Math.min(1, 0.5 + (best.value - second.value)) : 1;
    return { choices: [{ id: best.id as T, p: confidence }], confidence, usage: this.price(this.id, fakeTokens(req.context, req.question)) };
  }

  async score(req: { context: PromptParts; question: string }) {
    const q = req.question;
    if (/worth remembering/.test(q)) {
      // Surprises and disappointments are memorable.
      const value = /dark|nothing|would not|fizzed/.test(q) ? 0.85 : 0.55;
      return { value, confidence: 0.6, usage: this.price(this.id, fakeTokens(req.context, q)) };
    }
    const value = /fizzed|dark|cold and dark|nothing/.test(q) ? 0.35 : /hummed|fun|cold|rang/.test(q) ? 0.7 : 0.5;
    return { value, confidence: 0.6, usage: this.price(this.id, fakeTokens(req.context, q)) };
  }
}

/** Answers any of the gateway's schemas with something plausible, via `respond`. */
export class FakeChatModel implements ChatModel {
  readonly id: string;
  private readonly price: Pricer;
  constructor(opts: { id?: string; price: Pricer }) {
    this.id = opts.id ?? 'fake-chat';
    this.price = opts.price;
  }

  async generate<S extends z.ZodTypeAny>(req: { context: PromptParts; instruction: string; schema: S; maxOutputTokens?: number }) {
    const options = [...req.instruction.matchAll(/^(\w+): (.+)$/gm)].map((m) => ({ id: m[1]!, label: m[2]! }));
    const ranked = heuristicRank(req.context, options);
    const candidates: unknown[] = [
      { choices: ranked.slice(0, 1).map((r) => r.id) },
      { choices: ranked.slice(0, 1).map((r) => ({ id: r.id, reason: 'it seems like the best idea right now' })) },
      { value: 0.6 },
      { beliefs: [], openItems: [], sheetLines: [] },
    ];
    for (const c of candidates) {
      const parsed = req.schema.safeParse(c);
      if (parsed.success) return { object: parsed.data as z.infer<S>, usage: this.price(this.id, fakeTokens(req.context, req.instruction)) };
    }
    throw new Error('FakeChatModel cannot answer this schema');
  }
}

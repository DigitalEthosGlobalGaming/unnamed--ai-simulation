import { z } from 'zod';
import { hashJson, type FeedEntry, type JobName, type JobRequest, type Json, type ModelAnswerPayload, type Usage } from '@uas/core';
import type { LanguageModel } from 'ai';
import { AiSdkChatModel } from './adapters/ai-sdk.ts';
import type { Fetch, Pricer } from './adapters/common.ts';
import { FakeChatModel, FakeDecisionModel } from './adapters/fake.ts';
import { JevDecisionModel } from './adapters/jev.ts';
import { LlmAsDecisionModel } from './adapters/llm-as-decision.ts';
import { LocalChatModel } from './adapters/local-chat.ts';
import { OllamaDecisionModel, SystemOneDecisionModel } from './adapters/ollama-decision.ts';
import { OpenAiCompatibleChatModel } from './adapters/openai-compatible.ts';
import type { ChainEntry, ModelDef, ModelsConfig } from './config.ts';
import { CostMeter, priceUsage, type Price } from './meter.ts';
import type { ChatModel, DecisionModel } from './types.ts';

type Tier = Extract<FeedEntry['tier'], 'local' | 'decision' | 'llm'>;
interface Built {
  name: string;
  def: ModelDef;
  tier: Tier;
  /** Local models never count against the real-money cap. */
  paid: boolean;
  /** Configured but unusable, e.g. a hosted model without an API key. */
  unavailable?: string;
  decision?: DecisionModel;
  chat?: ChatModel;
}

/** Nominal price for local calls so they are cheap but not free (USD per million tokens). */
const LOCAL_PRICE: Price = { inputPerMTok: 0.01, cachedInputPerMTok: 0.01, outputPerMTok: 0.02 };
const FREE: Price = { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 };

export const PlanSchema = z.object({
  choices: z.array(z.object({ id: z.string(), reason: z.string().max(200) })).min(1).max(6),
});
export const ReflectSchema = z.object({
  beliefs: z.array(z.object({ key: z.string(), text: z.string() })).max(10),
  openItems: z.array(z.object({ kind: z.string(), text: z.string() })).max(3),
  sheetLines: z.array(z.string()).max(2),
});

const DECIDE_JOBS: JobName[] = ['decide', 'vocalize', 'route'];
const SCORE_JOBS: JobName[] = ['appraise', 'scoreMemory'];

export interface GatewayOptions {
  fetch?: Fetch;
  today?: () => string;
  /** Inject AI SDK language models (tests) instead of creating provider clients. */
  languageModels?: Record<string, LanguageModel>;
  log?: (msg: string) => void;
}

/**
 * The single exit from the sim to models. Routes each job through its configured chain,
 * skipping entries whose conditions fail and falling through on error or timeout, prices
 * usage in AUD and returns a `model.answer` payload for the host to record as an input event.
 */
export class ModelGateway {
  readonly config: ModelsConfig;
  readonly meter: CostMeter;
  private readonly models = new Map<string, Built>();
  private readonly latency = new Map<string, number>();
  /** Calls that hit their timeout (counted from when the call started). */
  timeouts = 0;
  /** Live setting: when false, hosted (paid) models are skipped. */
  hostedEnabled = true;
  private readonly log: (msg: string) => void;

  constructor(config: ModelsConfig, opts: GatewayOptions = {}) {
    this.config = config;
    this.meter = new CostMeter(opts.today);
    this.log = opts.log ?? (() => {});
    for (const [name, def] of Object.entries(config.models)) this.models.set(name, this.build(name, def, opts));
    const keyless = [...this.models.values()].filter((m) => m.unavailable === 'no API key').map((m) => m.name);
    if (keyless.length) this.log(`warning: no API key for hosted models (${keyless.join(', ')}); set AI_GATEWAY_API_KEY to enable them. Using local models and autopilot meanwhile.`);
  }

  private build(name: string, def: ModelDef, opts: GatewayOptions): Built {
    const local = def.adapter === 'local' || def.adapter === 'ollama-decision';
    const fake = def.adapter === 'fake-decision' || def.adapter === 'fake-chat';
    const keyless = (def.adapter === 'gateway-decision' || def.adapter === 'openai-compatible') && !def.apiKey;
    const price: Pricer = (modelId, t) => priceUsage(modelId, t, def.price ?? (local ? LOCAL_PRICE : FREE), this.config.audPerUsd);
    const url = 'url' in def && def.url ? def.url : this.config.ollamaUrl;
    const base = { name, def, paid: !local && !fake, ...(keyless && { unavailable: 'no API key' }) };
    switch (def.adapter) {
      case 'fake-decision':
        return { ...base, tier: 'decision', decision: new FakeDecisionModel({ id: name, price }) };
      case 'fake-chat':
        return { ...base, tier: 'llm', chat: new FakeChatModel({ id: name, price }) };
      case 'jev':
        return { ...base, tier: 'decision', decision: new JevDecisionModel({ ...(def.apiKey && { apiKey: def.apiKey }) }) };
      case 'ollama-decision':
        return { ...base, tier: 'decision', decision: new OllamaDecisionModel({ url, model: def.model, price, ...(def.maxStateChars && { maxStateChars: def.maxStateChars }), ...(opts.fetch && { fetch: opts.fetch }) }) };
      case 'gateway-decision':
        return {
          ...base,
          tier: 'decision',
          decision: new SystemOneDecisionModel({
            id: name,
            url: def.url,
            model: def.model,
            price,
            ...(def.apiKey && { apiKey: def.apiKey }),
            ...(def.maxStateChars && { maxStateChars: def.maxStateChars }),
            ...(opts.fetch && { fetch: opts.fetch }),
          }),
        };
      case 'openai-compatible':
        return {
          ...base,
          tier: 'llm',
          chat: new OpenAiCompatibleChatModel({
            id: name,
            baseUrl: def.baseUrl,
            model: def.model,
            price,
            ...(def.apiKey && { apiKey: def.apiKey }),
            ...(def.structured && { structured: def.structured }),
            ...(def.providerOrder && { providerOrder: def.providerOrder }),
            ...(opts.fetch && { fetch: opts.fetch }),
          }),
        };
      case 'local':
        return { ...base, tier: 'local', chat: new LocalChatModel({ url, model: def.model, price, ...(def.numThread && { numThread: def.numThread }), ...(def.think !== undefined && { think: def.think }), ...(opts.fetch && { fetch: opts.fetch }) }) };
      case 'ai-sdk': {
        const lm = opts.languageModels?.[name];
        return {
          ...base,
          tier: 'llm',
          chat: new AiSdkChatModel({ provider: def.provider, model: def.model, price, ...(def.apiKey && { apiKey: def.apiKey }), ...(lm && { languageModel: lm }) }),
        };
      }
    }
  }

  /** Hosted models that could be used now (configured, keyed, not denied). */
  hostedAvailable(): string[] {
    return [...this.models.values()].filter((m) => m.paid && !m.unavailable).map((m) => m.name);
  }

  /** Estimated A$ of one decision with the first usable model in the decide chain (≈350 input tokens). */
  estimateDecisionCostAud(tokens = 350): number {
    const req = { job: 'decide', energy: 1, isNight: false } as JobRequest;
    for (const raw of this.config.jobs.decide ?? []) {
      const entry: ChainEntry = typeof raw === 'string' ? { use: raw } : raw;
      const m = this.models.get(entry.use)!;
      if (this.skipReason(entry, m, req)) continue;
      const local = m.def.adapter === 'local' || m.def.adapter === 'ollama-decision';
      const price = m.def.price ?? (local ? LOCAL_PRICE : FREE);
      return ((tokens * price.inputPerMTok) / 1e6) * this.config.audPerUsd;
    }
    return 0;
  }

  /** Average A$ of one decision today (decide calls), or undefined if none yet. */
  averageDecisionCostAud(): number | undefined {
    const rows = this.meter.report(this.meter.currentDay()).filter((r) => r.job === 'decide');
    const calls = rows.reduce((a, r) => a + r.calls, 0);
    return calls ? rows.reduce((a, r) => a + r.costAud, 0) / calls : undefined;
  }

  /** Run a job. Returns undefined if every entry was skipped or failed (the mind then falls back). */
  async run(req: JobRequest): Promise<ModelAnswerPayload | undefined> {
    const first = await this.runChain(req.job, req, (m, signal) => this.call(m, req, signal));
    if (!first) return undefined;
    let { answer, usage, model } = first;
    const unsure = () => typeof answer.confidence === 'number' && answer.confidence < this.config.escalateBelow;
    // Unsure decisions are asked again of a stronger decision model (e.g. Jev)...
    if (req.job === 'decide' && unsure() && this.config.escalateTo.length) {
      const again = await this.runEntries('decide', this.config.escalateTo.filter((u) => u !== model.name), req, (m, signal) => this.call(m, req, signal));
      if (again) {
        usage = sumUsage(usage, again.usage);
        answer = again.answer;
        model = again.model;
      }
    }
    // ...and if still unsure, go to the LLM plan chain.
    if (req.job === 'decide' && typeof answer.confidence === 'number' && answer.confidence < this.config.escalateBelow && this.config.jobs.plan) {
      const plan = await this.runChain('plan', req, (m, signal) => this.callPlan(m, req, signal));
      if (plan) {
        usage = sumUsage(usage, plan.usage);
        answer = plan.answer;
        model = plan.model;
      }
    }
    const energy = usage.costAud * this.config.energyPerAud;
    this.meter.record(req.job, usage, energy);
    return {
      jobId: req.jobId,
      job: req.job,
      characterId: req.characterId,
      modelId: model.name,
      promptHash: hashJson(req.context),
      answer: { ...answer, tier: model.tier },
      usage,
    };
  }

  private runChain(
    job: JobName,
    req: JobRequest,
    fn: (m: Built, signal: AbortSignal) => Promise<{ answer: Record<string, Json>; usage: Usage }>,
  ): Promise<{ answer: Record<string, Json>; usage: Usage; model: Built } | undefined> {
    return this.runEntries(job, this.config.jobs[job] ?? [], req, fn);
  }

  private async runEntries(
    job: JobName,
    entries: NonNullable<ModelsConfig['jobs'][JobName]>,
    req: JobRequest,
    fn: (m: Built, signal: AbortSignal) => Promise<{ answer: Record<string, Json>; usage: Usage }>,
  ): Promise<{ answer: Record<string, Json>; usage: Usage; model: Built } | undefined> {
    for (const raw of entries) {
      const entry: ChainEntry = typeof raw === 'string' ? { use: raw } : raw;
      const model = this.models.get(entry.use)!;
      const skip = this.skipReason(entry, model, req);
      if (skip) {
        if (!model.unavailable && !(model.paid && !this.hostedEnabled)) this.log(`${job}: skip ${entry.use} (${skip})`);
        continue;
      }
      // Timeouts count from here, when the call starts, and abort the request so a local
      // server stops working on an answer nobody will use.
      const abort = new AbortController();
      try {
        const result = await withTimeout(fn(model, abort.signal), entry.timeoutMs ?? this.config.defaultTimeoutMs, abort);
        this.latency.set(entry.use, result.usage.latencyMs);
        return { ...result, model };
      } catch (err) {
        const message = (err as Error).message;
        if (message.startsWith('timed out')) this.timeouts++;
        // A key that can't use this model won't start working mid-run: stop asking (one log line).
        const denied = /HTTP (401|403)\b/.exec(message);
        if (denied && model.paid) {
          model.unavailable = `access denied (HTTP ${denied[1]})`;
          this.log(`${job}: ${entry.use} disabled for this run: ${message.slice(0, 300)}`);
        } else this.log(`${job}: ${entry.use} failed: ${message.slice(0, 300)}`);
      }
    }
    return undefined;
  }

  /**
   * The resource a job will run on: its first eligible chain entry. Local models share their
   * Ollama endpoint; each cloud model is its own lane; fakes need no lane.
   */
  laneOf(req: JobRequest): { lane: string; concurrency: number } {
    for (const raw of this.config.jobs[req.job] ?? []) {
      const entry: ChainEntry = typeof raw === 'string' ? { use: raw } : raw;
      const m = this.models.get(entry.use)!;
      if (this.skipReason(entry, m, req)) continue;
      if (m.def.adapter === 'local' || m.def.adapter === 'ollama-decision') {
        const url = m.def.url ?? this.config.ollamaUrl;
        return { lane: `ollama:${url}`, concurrency: this.config.queue.localConcurrency };
      }
      if (m.def.adapter === 'ai-sdk' || m.def.adapter === 'jev' || m.def.adapter === 'gateway-decision' || m.def.adapter === 'openai-compatible') return { lane: `cloud:${entry.use}`, concurrency: this.config.queue.cloudConcurrency };
      return { lane: 'instant', concurrency: Infinity };
    }
    return { lane: 'instant', concurrency: Infinity };
  }

  private skipReason(e: ChainEntry, m: Built, req: JobRequest): string | undefined {
    if (m.unavailable) return m.unavailable;
    if (m.paid && !this.hostedEnabled) return 'hosted models are turned off';
    if (m.paid && this.meter.spentTodayAud() >= this.config.dailyCapAud) return 'daily AUD cap reached';
    if (m.paid && req.energy < this.config.energyFloor) return 'below energy floor';
    if (e.minEnergy !== undefined && req.energy < e.minEnergy) return `energy ${req.energy} < ${e.minEnergy}`;
    if (e.onlyAtNight && !req.isNight) return 'only at night';
    if (e.budgetRemainingAud !== undefined && this.config.dailyCapAud - this.meter.spentTodayAud() < e.budgetRemainingAud) return 'budget';
    if (e.maxLatencyMs !== undefined && (this.latency.get(e.use) ?? 0) > e.maxLatencyMs) return 'too slow lately';
    const needsDecision = DECIDE_JOBS.includes(req.job) || SCORE_JOBS.includes(req.job);
    if (needsDecision && !m.decision && !m.chat) return 'no adapter';
    if (!needsDecision && !m.chat) return 'needs a chat model';
    if (req.job === 'embed') return 'embedding is not implemented';
    return undefined;
  }

  private decisionOf(m: Built): DecisionModel {
    return m.decision ?? new LlmAsDecisionModel(m.chat!);
  }

  private async call(m: Built, req: JobRequest, signal: AbortSignal): Promise<{ answer: Record<string, Json>; usage: Usage }> {
    if (DECIDE_JOBS.includes(req.job)) {
      const r = await this.decisionOf(m).decide({ context: req.context, question: req.question, options: req.options ?? [], ...(req.multi && { multi: req.multi }), signal });
      return { answer: { choices: r.choices, confidence: r.confidence }, usage: r.usage };
    }
    if (SCORE_JOBS.includes(req.job)) {
      const r = await this.decisionOf(m).score({ context: req.context, question: req.question, signal });
      return { answer: { value: r.value, confidence: r.confidence }, usage: r.usage };
    }
    const input = req.input === undefined ? '' : `\nInput: ${JSON.stringify(req.input)}`;
    const r = await m.chat!.generate({ context: req.context, instruction: req.question + input, schema: ReflectSchema, maxOutputTokens: 600, signal });
    return { answer: r.object as Record<string, Json>, usage: r.usage };
  }

  private async callPlan(m: Built, req: JobRequest, signal: AbortSignal): Promise<{ answer: Record<string, Json>; usage: Usage }> {
    const ids = new Set((req.options ?? []).map((o) => o.id));
    const list = (req.options ?? []).map((o) => `${o.id}: ${o.label}`).join('\n');
    const r = await m.chat!.generate({
      context: req.context,
      instruction: `${req.question}\nPlan up to 6 steps in order, using only these option ids:\n${list}\nGive a one-line reason in your own voice for each.`,
      schema: PlanSchema,
      maxOutputTokens: 300,
      signal,
    });
    // Small models sometimes repeat their list ("c5, c1, c0, c5, c1, c0"); keep each option once.
    const seen = new Set<string>();
    const valid = r.object.choices.filter((c) => ids.has(c.id) && !seen.has(c.id) && seen.add(c.id));
    if (valid.length === 0) throw new Error('plan referenced no valid options');
    return {
      answer: { choices: valid.map((c) => ({ id: c.id, p: 1 })), confidence: 1, reasons: Object.fromEntries(valid.map((c) => [c.id, c.reason])) },
      usage: r.usage,
    };
  }
}

function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costAud: Math.round((a.costAud + b.costAud) * 1e8) / 1e8,
    latencyMs: a.latencyMs + b.latencyMs,
    modelId: b.modelId,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, abort: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`timed out after ${ms} ms`));
      }, ms);
    }),
  ]);
}

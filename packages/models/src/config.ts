import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { JobName } from '@uas/core';

const PriceSchema = z.strictObject({
  inputPerMTok: z.number().min(0),
  cachedInputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
});

export const ModelDefSchema = z.discriminatedUnion('adapter', [
  z.strictObject({ adapter: z.literal('fake-decision'), price: PriceSchema.optional() }),
  z.strictObject({ adapter: z.literal('fake-chat'), price: PriceSchema.optional() }),
  z.strictObject({ adapter: z.literal('jev'), apiKey: z.string().nullish(), price: PriceSchema.optional() }),
  z.strictObject({
    adapter: z.literal('ollama-decision'),
    model: z.string(),
    url: z.string().optional(),
    /** Cap on the state text sent to /v1/systemone (Laya's whole question budget is 512 tokens). */
    maxStateChars: z.int().positive().optional(),
    price: PriceSchema.optional(),
  }),
  z.strictObject({
    adapter: z.literal('local'),
    model: z.string(),
    url: z.string().optional(),
    /** llama.cpp threads per request; keep it equal to the Ollama container's CPU cap. */
    numThread: z.int().positive().optional(),
    /** Let thinking models think (default: off for qwen*, which otherwise reason at length first). */
    think: z.boolean().optional(),
    price: PriceSchema.optional(),
  }),
  z.strictObject({
    /** Hosted decision models through AI Gateway's TypeSafe-compatible API (Jev, Laya). */
    adapter: z.literal('gateway-decision'),
    model: z.string(),
    url: z.string().default('https://ai-gateway.vercel.sh/typesafe'),
    apiKey: z.string().nullish(),
    maxStateChars: z.int().positive().optional(),
    price: PriceSchema.optional(),
  }),
  z.strictObject({
    /** Hosted chat models through an OpenAI-compatible endpoint (AI Gateway `/v1`). */
    adapter: z.literal('openai-compatible'),
    model: z.string(),
    baseUrl: z.string().default('https://ai-gateway.vercel.sh/v1'),
    apiKey: z.string().nullish(),
    structured: z.enum(['json_schema', 'tools', 'prompt']).optional(),
    providerOrder: z.array(z.string()).optional(),
    price: PriceSchema.optional(),
  }),
  z.strictObject({
    adapter: z.literal('ai-sdk'),
    provider: z.literal('anthropic'),
    model: z.string(),
    apiKey: z.string().nullish(),
    price: PriceSchema.optional(),
  }),
]);

const ChainEntrySchema = z.union([
  z.string(),
  z.strictObject({
    use: z.string(),
    as: z.literal('decision').optional(),
    timeoutMs: z.int().positive().optional(),
    minEnergy: z.number().min(0).max(1).optional(),
    maxLatencyMs: z.int().positive().optional(),
    onlyAtNight: z.boolean().optional(),
    budgetRemainingAud: z.number().min(0).optional(),
  }),
]);

const JOBS = ['route', 'decide', 'appraise', 'scoreMemory', 'vocalize', 'plan', 'reflect', 'consolidate', 'sheet', 'embed'] as const;

export const ModelsConfigSchema = z.strictObject({
  /** Fixed conversion rate, from config so replays stay deterministic. */
  audPerUsd: z.number().positive().default(1.55),
  /** Hard real-money cap per world per (real) day; stops all paid calls. */
  dailyCapAud: z.number().min(0).default(0.5),
  /** Decisions below this confidence escalate to the `plan` chain. */
  escalateBelow: z.number().min(0).max(1).default(0.35),
  /** Decision models to ask again when a decision is unsure (e.g. Jev), before any LLM plan. */
  escalateTo: z.array(z.string()).default([]),
  /** Below this energy every job resolves to local models (or autopilot). */
  energyFloor: z.number().min(0).max(1).default(0.1),
  /** Energy per AUD (TODO: open question in the spec; provisional). */
  energyPerAud: z.number().min(0).default(5),
  defaultTimeoutMs: z.int().positive().default(30_000),
  ollamaUrl: z.string().default('http://localhost:11434'),
  /** The host's job queue: local models share one CPU, so they run one at a time. */
  queue: z
    .strictObject({
      /** Concurrent calls per Ollama endpoint. */
      localConcurrency: z.int().positive().default(1),
      /** Concurrent calls per cloud model. */
      cloudConcurrency: z.int().positive().default(4),
      /** Drop a job (the character falls back to autopilot) if its trigger is older than this many ticks when it reaches the front. */
      staleTicks: z.int().positive().default(75),
    })
    .prefault({}),
  models: z.record(z.string(), ModelDefSchema),
  jobs: z.partialRecord(z.enum(JOBS), z.array(ChainEntrySchema)),
});

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type ModelDef = z.infer<typeof ModelDefSchema>;
export type ChainEntry = Exclude<z.infer<typeof ChainEntrySchema>, string>;
export type { JobName };

/** `${VAR}` and `${VAR:-default}` from the environment; unset with no default becomes ''. */
export function substituteEnv(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => env[name] ?? def ?? '');
}

export function parseModelsConfig(value: unknown): ModelsConfig {
  const r = ModelsConfigSchema.safeParse(value);
  if (!r.success) throw new Error(`models config: ${z.prettifyError(r.error)}`);
  for (const use of r.data.escalateTo) if (!r.data.models[use]) throw new Error(`models config: escalateTo uses unknown model ${use}`);
  for (const [job, chain] of Object.entries(r.data.jobs)) {
    for (const e of chain ?? []) {
      const use = typeof e === 'string' ? e : e.use;
      if (!r.data.models[use]) throw new Error(`models config: jobs.${job} uses unknown model ${use}`);
    }
  }
  return r.data;
}

export function loadModelsConfigYaml(text: string, env: Record<string, string | undefined>): ModelsConfig {
  return parseModelsConfig(parseYaml(substituteEnv(text, env)));
}

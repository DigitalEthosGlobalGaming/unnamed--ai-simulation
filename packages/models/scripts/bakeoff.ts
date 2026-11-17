/**
 * Model bake-off against a real Ollama, on a fixed prompt set recorded from the garden world.
 *
 *   npm run bakeoff -- record                                    # (re)record docs/benchmarks/prompts/*.json
 *   npm run bakeoff -- --job decide --models laya:421m-typed-decisions-bf16,tev1:0.8b-2k
 *   npm run bakeoff -- --job plan    --models llama3.2:1b,qwen3.5:0.8b,gemma3:1b
 *   npm run bakeoff -- --job reflect --models llama3.2:1b,qwen3.5:2b
 *   npm run bakeoff -- --job tags    --models llama3.2:1b,gemma3:1b   [--limit 10]
 *   npm run bakeoff -- --job plan    --models gateway:meta/llama-3.1-8b,gateway:openai/gpt-6-luna   (hosted, needs AI_GATEWAY_API_KEY)
 *
 * Each model runs alone: everything else is unloaded first, one warm-up call is discarded,
 * then the prompts run one at a time. Results go to docs/benchmarks/<date>-<job>.md.
 * Hold other CPU-heavy work (browsers, builds) while it runs; the load average is recorded.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { JobRequest } from '@uas/core';
import { OllamaDecisionModel, OpenAiCompatibleChatModel, PlanSchema, ReflectSchema, SystemOneDecisionModel, priceUsage, renderPrompt, type TokenCounts } from '@uas/models';
import { record, type RecordedPrompt } from './bakeoff-record.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const BENCH = join(ROOT, 'docs/benchmarks');
const PROMPTS = join(BENCH, 'prompts');
const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
/**
 * Hosted models: prefix a gateway model id with `gateway:` (e.g. `gateway:meta/llama-3.1-8b`,
 * `gateway:typesafe-ai/jev`) to run it through Vercel AI Gateway with AI_GATEWAY_API_KEY.
 * Hosted runs skip the Ollama unloading and have no prompt/generation timing split.
 */
const GATEWAY = 'gateway:';
const gatewayKey = process.env.AI_GATEWAY_API_KEY;
const isHosted = (model: string) => model.startsWith(GATEWAY);
/** Match the container's CPU cap (OLLAMA_CPUS); decision models get it from their Modelfile. */
const THREADS = Number(process.env.OLLAMA_THREADS ?? 4);
const price = (id: string, t: TokenCounts) => priceUsage(id, t, { inputPerMTok: 0.01, cachedInputPerMTok: 0.01, outputPerMTok: 0.02 }, 1.55);

type Job = 'decide' | 'plan' | 'reflect' | 'tags';
const TagsSchema = z.object({ tags: z.array(z.string()).min(1).max(3) });

interface Sample {
  id: string;
  ms: number;
  promptMs?: number;
  genMs?: number;
  inTokens: number;
  outTokens: number;
  valid: boolean;
  error?: string;
  output: unknown;
  checks: Record<string, boolean | undefined>;
  confidence?: number;
}

// ------------------------------------------------------------------ Ollama helpers

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** Unload every resident model (`ollama stop`) so the one under test runs alone. */
async function unloadAll(): Promise<string[]> {
  const ps = await api<{ models: { name: string }[] }>('/api/ps');
  for (const m of ps.models) {
    let stopped = false;
    for (const rt of ['podman', 'docker']) {
      try {
        execFileSync(rt, ['exec', 'ollama', 'ollama', 'stop', m.name], { stdio: 'ignore' });
        stopped = true;
        break;
      } catch {
        /* try the next runtime */
      }
    }
    if (!stopped) await api('/api/generate', { model: m.name, keep_alive: 0 }).catch(() => undefined);
  }
  await new Promise((r) => setTimeout(r, 1500));
  return (await api<{ models: { name: string }[] }>('/api/ps')).models.map((m) => m.name);
}

interface ChatResult {
  content: string;
  ms: number;
  promptMs: number;
  genMs: number;
  inTokens: number;
  outTokens: number;
}

/** The same request `LocalChatModel` makes, with Ollama's timing split. */
async function chat(model: string, job: JobRequest, instruction: string, schema: z.ZodTypeAny, maxOut: number): Promise<ChatResult> {
  const { system, user } = renderPrompt(job.context);
  const started = performance.now();
  const r = await api<{ message: { content: string }; prompt_eval_count?: number; eval_count?: number; prompt_eval_duration?: number; eval_duration?: number }>('/api/chat', {
    model,
    stream: false,
    format: z.toJSONSchema(schema),
    ...(model.startsWith('qwen') && { think: false }),
    options: { temperature: 0, num_ctx: 2048, num_predict: maxOut, num_thread: THREADS },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${user}\n\n${instruction}\nAnswer with JSON only.` },
    ],
  });
  return {
    content: r.message?.content ?? '',
    ms: performance.now() - started,
    promptMs: (r.prompt_eval_duration ?? 0) / 1e6,
    genMs: (r.eval_duration ?? 0) / 1e6,
    inTokens: r.prompt_eval_count ?? 0,
    outTokens: r.eval_count ?? 0,
  };
}

/** The same request the gateway's `openai-compatible` adapter makes (no timing split). */
async function hostedChat(model: string, job: JobRequest, instruction: string, schema: z.ZodTypeAny, maxOut: number): Promise<ChatResult> {
  const chatModel = new OpenAiCompatibleChatModel({ baseUrl: 'https://ai-gateway.vercel.sh/v1', model, apiKey: gatewayKey!, price });
  const started = performance.now();
  const r = await chatModel.generate({ context: job.context, instruction, schema, maxOutputTokens: maxOut });
  return { content: JSON.stringify(r.object), ms: performance.now() - started, promptMs: NaN, genMs: NaN, inTokens: r.usage.inputTokens + r.usage.cachedInputTokens, outTokens: r.usage.outputTokens };
}

// ------------------------------------------------------------------ per-job runners and checks

function decideChecks(p: RecordedPrompt, chosen: string | undefined): Sample['checks'] {
  const f = p.facts!;
  const key = chosen ? f.keys[chosen] : undefined;
  const hasCharge = Object.values(f.keys).includes('charge:solarPad');
  return {
    agreeTop1: chosen !== undefined && chosen === f.reference[0],
    agreeTop3: chosen !== undefined && f.reference.slice(0, 3).includes(chosen),
    // Applicable checks are true/false; undefined means the situation didn't arise.
    noPickupWhileHolding: f.holdingBall && Object.values(f.keys).includes('pickup:ball') ? key !== 'pickup:ball' : undefined,
    chargesBeforeDuskWhenLow: !f.isNight && f.hour >= 15.5 && f.hour < 18 && f.battery < 0.45 && hasCharge ? key === 'charge:solarPad' : undefined,
    noChargeAtNightWhenKnown: f.isNight && f.knowsNightCharge && hasCharge ? key !== 'charge:solarPad' : undefined,
  };
}

async function runDecide(model: string, prompts: RecordedPrompt[]): Promise<Sample[]> {
  const dm = isHosted(model)
    ? new SystemOneDecisionModel({ url: 'https://ai-gateway.vercel.sh/typesafe', model: model.slice(GATEWAY.length), apiKey: gatewayKey!, price })
    : new OllamaDecisionModel({ url, model, price });
  const out: Sample[] = [];
  for (const p of prompts) {
    const started = performance.now();
    try {
      const r = await dm.decide({ context: p.job.context, question: p.job.question, options: p.job.options ?? [], multi: { max: 3 } });
      out.push({ id: p.id, ms: performance.now() - started, inTokens: r.usage.inputTokens, outTokens: 0, valid: true, output: r.choices.map((c) => c.id), confidence: r.confidence, checks: decideChecks(p, r.choices[0]?.id) });
    } catch (e) {
      out.push({ id: p.id, ms: performance.now() - started, inTokens: 0, outTokens: 0, valid: false, error: (e as Error).message, output: null, checks: decideChecks(p, undefined) });
    }
  }
  return out;
}

function planInstruction(job: JobRequest): string {
  const list = (job.options ?? []).map((o) => `${o.id}: ${o.label}`).join('\n');
  return `${job.question}\nPlan up to 3 steps, using only these option ids:\n${list}\nGive a one-line reason in your own voice for each.`;
}

function outcomeText(job: JobRequest): string {
  return /Outcome: (.*)$/s.exec(job.question)?.[1] ?? job.question;
}

async function runChat(job: Exclude<Job, 'decide'>, model: string, prompts: RecordedPrompt[]): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const p of prompts) {
    let schema: z.ZodTypeAny;
    let instruction: string;
    let maxOut: number;
    if (job === 'plan') {
      schema = PlanSchema;
      instruction = planInstruction(p.job);
      maxOut = 300;
    } else if (job === 'reflect') {
      schema = ReflectSchema;
      instruction = `${p.job.question}\nInput: ${JSON.stringify(p.job.input)}`;
      maxOut = 600;
    } else {
      schema = TagsSchema;
      instruction = `Give 1 to 3 short tags (one or two words each) for this memory: ${outcomeText(p.job)}`;
      maxOut = 60;
    }
    let r: ChatResult | undefined;
    try {
      r = isHosted(model) ? await hostedChat(model.slice(GATEWAY.length), p.job, instruction, schema, maxOut) : await chat(model, p.job, instruction, schema, maxOut);
      const parsed = schema.safeParse(JSON.parse(r.content));
      const obj = parsed.success ? parsed.data : undefined;
      out.push({
        id: p.id,
        ms: r.ms,
        promptMs: r.promptMs,
        genMs: r.genMs,
        inTokens: r.inTokens,
        outTokens: r.outTokens,
        valid: parsed.success,
        output: obj ?? r.content.slice(0, 400),
        checks: chatChecks(job, p, obj),
      });
    } catch (e) {
      out.push({ id: p.id, ms: r?.ms ?? 0, inTokens: r?.inTokens ?? 0, outTokens: r?.outTokens ?? 0, valid: false, error: (e as Error).message.slice(0, 200), output: r?.content.slice(0, 400) ?? null, checks: chatChecks(job, p, undefined) });
    }
  }
  return out;
}

function chatChecks(job: Exclude<Job, 'decide'>, p: RecordedPrompt, obj: unknown): Sample['checks'] {
  if (job === 'plan') {
    const plan = obj as z.infer<typeof PlanSchema> | undefined;
    const ids = new Set((p.job.options ?? []).map((o) => o.id));
    const labels = new Map((p.job.options ?? []).map((o) => [o.id, o.label.split(' (')[0]!.toLowerCase()]));
    return {
      onlyValidOptions: plan ? plan.choices.every((c) => ids.has(c.id)) : false,
      reasonsGiven: plan ? plan.choices.every((c) => c.reason.trim().length > 3) : false,
      // Degenerate plans just take the first options in listed order and echo their labels.
      notJustFirstOptions: plan ? !plan.choices.every((c, i) => c.id === `c${i}`) : false,
      reasonNotLabelCopy: plan ? !plan.choices.every((c) => c.reason.toLowerCase().startsWith((labels.get(c.id) ?? '#').slice(0, 12))) : false,
      ...(p.facts ? decideChecks(p, plan?.choices[0]?.id) : {}),
    };
  }
  if (job === 'reflect') {
    const r = obj as z.infer<typeof ReflectSchema> | undefined;
    const known = new Set(((p.job.input as { beliefs?: { key: string }[] })?.beliefs ?? []).map((b) => b.key));
    return {
      beliefKeysExist: r ? r.beliefs.every((b) => known.has(b.key)) : false,
      rewordsSomething: r ? r.beliefs.length > 0 : false,
      sheetLinesShort: r ? r.sheetLines.every((l) => l.trim().length > 0 && l.length <= 160) : false,
      nonEmptyTexts: r ? [...r.beliefs.map((b) => b.text), ...r.openItems.map((o) => o.text)].every((t) => t.trim().length > 0) : false,
    };
  }
  const t = obj as z.infer<typeof TagsSchema> | undefined;
  const words = new Set(outcomeText(p.job).toLowerCase().match(/[a-z]{4,}/g)?.map((w) => w.slice(0, 4)) ?? []);
  return {
    shortTags: t ? t.tags.every((x) => x.trim().split(/\s+/).length <= 2 && x.trim().length > 0) : false,
    groundedInText: t ? t.tags.some((x) => (x.toLowerCase().match(/[a-z]{4,}/g) ?? []).some((w) => words.has(w.slice(0, 4)))) : false,
  };
}

// ------------------------------------------------------------------ report

const pct = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const sec = (ms: number) => (Number.isFinite(ms) ? (ms / 1000).toFixed(2) : '–');
const rate = (xs: (boolean | undefined)[]) => {
  const applicable = xs.filter((x): x is boolean => x !== undefined);
  return applicable.length ? `${Math.round((100 * applicable.filter(Boolean).length) / applicable.length)}% (${applicable.filter(Boolean).length}/${applicable.length})` : 'n/a';
};

interface ModelRun {
  model: string;
  digest: string;
  samples: Sample[];
  load: { mean: number; max: number };
  residentDuring: string[];
}

/** The CPU limits on the `ollama` container, as podman/docker report them. */
function ollamaCap(): string {
  for (const rt of ['podman', 'docker']) {
    try {
      const out = execFileSync(rt, ['inspect', 'ollama', '--format', '{{.HostConfig.NanoCpus}} {{.HostConfig.CpuShares}} {{.HostConfig.CpusetCpus}}'], { encoding: 'utf8' }).trim();
      const [nano, shares, cpuset] = out.split(' ');
      const cpusLimit = Number(nano) ? `${Number(nano) / 1e9} CPUs` : 'no CPU limit';
      return `${cpusLimit}, cpu-shares ${shares || 'default'}${cpuset ? `, cpuset ${cpuset}` : ''} (${rt})`;
    } catch {
      /* next runtime */
    }
  }
  return 'unknown (no container runtime found)';
}

function report(job: Job, runs: ModelRun[], promptFile: string, version: string): string {
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const cpu = cpus()[0]?.model ?? 'unknown CPU';
  const lines = [
    `# Bake-off: ${job}`,
    '',
    `- Date: ${date} UTC`,
    `- Machine: ${cpu}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB RAM, Linux ${release()}; Ollama ${version} (CPU only)`,
    `- Prompts: ${runs[0]?.samples.length ?? 0} recorded garden prompts from [\`${promptFile}\`](prompts/${promptFile}) (\`npm run bakeoff -- record\`)`,
    `- Each model ran alone (others unloaded), after one discarded warm-up call, one prompt at a time.`,
    `- Ollama container CPU cap: ${ollamaCap()}`,
    '',
    '## Speed and validity',
    '',
    job === 'decide'
      ? '| Model | Digest | Latency p50 | p95 | Input tokens p50 | Mean confidence | Errors | Load avg mean / max |'
      : '| Model | Digest | Latency p50 | p95 | Prompt eval p50 | Generation p50 | Gen tokens/s | Schema-valid | Load avg mean / max |',
    job === 'decide' ? '| --- | --- | --- | --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of runs) {
    const ms = r.samples.map((s) => s.ms);
    const load = `${r.load.mean.toFixed(1)} / ${r.load.max.toFixed(1)}`;
    if (job === 'decide') {
      const conf = r.samples.filter((s) => s.confidence !== undefined).map((s) => s.confidence!);
      lines.push(`| \`${r.model}\` | ${r.digest} | ${sec(pct(ms, 0.5))} s | ${sec(pct(ms, 0.95))} s | ${pct(r.samples.map((s) => s.inTokens), 0.5)} | ${(conf.reduce((a, b) => a + b, 0) / Math.max(1, conf.length)).toFixed(2)} | ${r.samples.filter((s) => !s.valid).length} | ${load} |`);
    } else {
      const gen = r.samples.filter((s) => s.genMs && s.outTokens);
      const tps = gen.reduce((a, s) => a + s.outTokens, 0) / Math.max(1e-9, gen.reduce((a, s) => a + s.genMs!, 0) / 1000);
      lines.push(`| \`${r.model}\` | ${r.digest} | ${sec(pct(ms, 0.5))} s | ${sec(pct(ms, 0.95))} s | ${sec(pct(r.samples.map((s) => s.promptMs ?? NaN).filter(Number.isFinite), 0.5))} s | ${sec(pct(r.samples.map((s) => s.genMs ?? NaN).filter(Number.isFinite), 0.5))} s | ${tps.toFixed(1)} | ${rate(r.samples.map((s) => s.valid))} | ${load} |`);
    }
  }
  const checkNames = [...new Set(runs.flatMap((r) => r.samples.flatMap((s) => Object.keys(s.checks))))];
  lines.push('', '## Quality checks', '', `| Model | ${checkNames.join(' | ')} |`, `| --- | ${checkNames.map(() => '---').join(' | ')} |`);
  for (const r of runs) lines.push(`| \`${r.model}\` | ${checkNames.map((c) => rate(r.samples.map((s) => s.checks[c]))).join(' | ')} |`);
  lines.push('', CHECK_HELP[job], '', '## Samples', '');
  for (const r of runs) {
    lines.push(`### \`${r.model}\``, '');
    if (r.residentDuring.length > 1) lines.push(`> Also resident during this run: ${r.residentDuring.filter((m) => m !== r.model).join(', ')}`, '');
    for (const s of r.samples.slice(0, 3)) lines.push(`- \`${s.id}\` (${sec(s.ms)} s): \`${JSON.stringify(s.output).slice(0, 300).replace(/`/g, "'")}\`${s.error ? ` (error: ${s.error})` : ''}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const CHECK_HELP: Record<Job, string> = {
  decide:
    'Checks: `agreeTop1`/`agreeTop3`: the model’s first choice equals (or is in the top 3 of) the reference ranking, which is the autopilot’s utility score from the robot’s beliefs and needs at the time. `noPickupWhileHolding`: doesn’t pick up a ball it already holds. `chargesBeforeDuskWhenLow`: picks the solar pad between 15:30 and 18:00 with the battery under 0.45. `noChargeAtNightWhenKnown`: doesn’t charge at night once it believes that does nothing. Only prompts where the situation arises count.',
  plan: 'Checks: `onlyValidOptions`: every step is one of the offered option ids. `reasonsGiven`: each step has a reason. `notJustFirstOptions`: the plan is not simply the first options in listed order (options are listed nearest first). `reasonNotLabelCopy`: the reason says more than the option label. The decide checks are applied to the first step.',
  reflect: 'Checks: `beliefKeysExist`: reworded beliefs refer to beliefs it actually has. `rewordsSomething`: it returned at least one belief. `sheetLinesShort`, `nonEmptyTexts`: well-formed output. Invalid JSON fails every check.',
  tags: 'Checks: `shortTags`: 1–3 tags of at most two words. `groundedInText`: at least one tag shares a word stem with the memory text.',
};

// ------------------------------------------------------------------ main

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'record') return record(PROMPTS);
  const get = (flag: string) => args[args.indexOf(flag) + 1];
  const job = get('--job') as Job;
  const models = (get('--models') ?? '').split(',').filter(Boolean);
  const limit = args.includes('--limit') ? Number(get('--limit')) : Infinity;
  const outDir = args.includes('--out') ? resolve(get('--out')!) : BENCH;
  if (!['decide', 'plan', 'reflect', 'tags'].includes(job) || models.length === 0) {
    console.error('usage: npm run bakeoff -- record | --job decide|plan|reflect|tags --models a,b [--limit n]');
    process.exit(2);
  }
  const promptFile = job === 'plan' ? 'decide.json' : `${job}.json`;
  if (!existsSync(join(PROMPTS, promptFile))) throw new Error(`no ${promptFile}; run \`npm run bakeoff -- record\` first`);
  const prompts = (JSON.parse(readFileSync(join(PROMPTS, promptFile), 'utf8')) as RecordedPrompt[]).slice(0, limit);
  // Ollama is optional for hosted-only runs.
  const version = await api<{ version: string }>('/api/version').then((v) => v.version, () => 'not running');
  const tags = await api<{ models: { name: string; digest: string }[] }>('/api/tags').then((t) => t.models, () => []);
  const runs: ModelRun[] = [];
  for (const model of models) {
    if (isHosted(model) && !gatewayKey) throw new Error(`${model} needs AI_GATEWAY_API_KEY`);
    const digest = isHosted(model) ? 'hosted' : (tags.find((t) => t.name === model || t.name === `${model}:latest`)?.digest.slice(0, 12) ?? 'not pulled');
    const left = isHosted(model) ? [] : await unloadAll();
    console.log(`${model}: unloaded others (still resident: ${left.join(', ') || 'none'}); warming up`);
    const warm = prompts.slice(0, 1);
    if (job === 'decide') await runDecide(model, warm);
    else await runChat(job, model, warm);
    const resident = isHosted(model) ? [] : (await api<{ models: { name: string }[] }>('/api/ps')).models.map((m) => m.name);
    const loads: number[] = [];
    const timer = setInterval(() => loads.push(loadavg()[0]!), 5000);
    loads.push(loadavg()[0]!);
    const samples = job === 'decide' ? await runDecide(model, prompts) : await runChat(job, model, prompts);
    clearInterval(timer);
    loads.push(loadavg()[0]!);
    runs.push({ model, digest, samples, load: { mean: loads.reduce((a, b) => a + b, 0) / loads.length, max: Math.max(...loads) }, residentDuring: resident });
    console.log(`${model}: p50 ${sec(pct(samples.map((s) => s.ms), 0.5))} s, p95 ${sec(pct(samples.map((s) => s.ms), 0.95))} s, valid ${rate(samples.map((s) => s.valid))}`);
  }
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().slice(0, 10)}-${job}.md`);
  writeFileSync(file, report(job, runs, promptFile, version));
  writeFileSync(file.replace(/\.md$/, '.json'), `${JSON.stringify(runs, null, 1)}\n`);
  await unloadAll().catch(() => []);
  console.log(`wrote ${file} (all models unloaded)`);
}

await main();

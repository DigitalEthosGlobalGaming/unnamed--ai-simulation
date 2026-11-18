/**
 * Model evals on saved situations (docs/testing-models.md).
 *
 *   npm run eval                                   # every situation, 3 samples, the garden's decide and plan models
 *   npm run eval -- --only holding-ball,signal-low # by id (comma-separated)
 *   npm run eval -- --tag battery --samples 5      # by tag
 *   npm run eval -- --decide localDm --plan planner          # other entries from garden2.yaml's models
 *   npm run eval -- --decide gateway:typesafe-ai/jev         # any AI Gateway model id
 *   npm run eval -- --update-prompts               # rewrite golden prompts (no model calls)
 *   npm run eval -- --dry                          # build every prompt and check the situations, no calls
 *   npm run eval -- --decide-rpm 4                 # pace decision calls (hosted Laya allows 5 a minute per team)
 *   npm run eval -- --template plan@3 --db data/uas.db   # a stored prompt template version (read-only) instead of the default
 *
 * Reports go to docs/benchmarks/evals/<date>.{md,json}. AI_GATEWAY_API_KEY comes from .env and is never printed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { ModelDef } from '@uas/models';
import { ModelGateway, parseModelsConfig } from '@uas/models';
import { loadWorldYaml } from '@uas/server';
import {
  PROMPTS_DIR,
  REPORTS_DIR,
  REPO_ROOT,
  SITUATIONS_DIR,
  loadSituations,
  promptText,
  runSituation,
  situationRequest,
  validateChecks,
  type SituationOut,
} from '../src/index.ts';
import { DEFAULT_TEMPLATES, TEMPLATE_IDS, type ActiveTemplates, type TemplateId } from '@uas/mind';
import { readPromptVersion } from '@uas/store';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const all = loadSituations(SITUATIONS_DIR);
for (const s of all) validateChecks(s);

if (flag('--update-prompts')) {
  mkdirSync(PROMPTS_DIR, { recursive: true });
  const keep = new Set<string>();
  let changed = 0;
  for (const s of all) {
    const file = join(PROMPTS_DIR, `${s.id}.txt`);
    keep.add(basename(file));
    const text = promptText(s);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      writeFileSync(file, text);
      changed++;
      console.log(`updated ${relative(REPO_ROOT, file)}`);
    }
  }
  for (const f of readdirSync(PROMPTS_DIR)) {
    if (f.endsWith('.txt') && !keep.has(f)) {
      rmSync(join(PROMPTS_DIR, f));
      console.log(`removed ${f} (no such situation)`);
    }
  }
  console.log(`${changed} golden prompt(s) updated, ${all.length} situations`);
  process.exit(0);
}

const only = opt('--only')?.split(',');
const tag = opt('--tag');
const situations = all.filter((s) => (!only || only.includes(s.id)) && (!tag || s.tags.includes(tag)));
if (situations.length === 0) {
  console.error('no situations match');
  process.exit(2);
}
// ---- `--template plan@3 --db …`: a stored version (version 1 is the repo default, no database needed)
let override: { active: ActiveTemplates; label: string } | undefined;
const tplSpec = opt('--template');
if (tplSpec) {
  const m = /^([a-z]+)@(\d+)$/.exec(tplSpec);
  if (!m || !TEMPLATE_IDS.includes(m[1] as TemplateId)) {
    console.error(`--template takes <id>@<version> with id one of ${TEMPLATE_IDS.join(', ')}`);
    process.exit(2);
  }
  const id = m[1] as TemplateId;
  const version = Number(m[2]);
  let body = version === 1 ? DEFAULT_TEMPLATES[id] : undefined;
  if (!body) {
    const dbPath = opt('--db');
    if (!dbPath) {
      console.error('--template with a version above 1 needs --db <path to the server database>');
      process.exit(2);
    }
    body = readPromptVersion(dbPath, id, version)?.body;
    if (!body) {
      console.error(`no version ${version} of ${id} in ${dbPath}`);
      process.exit(2);
    }
  }
  override = { active: { [id]: { version, body } }, label: `${id}@${version}` };
}

if (flag('--dry')) {
  for (const s of situations) console.log(`${s.id}: ${situationRequest(s, override ? { active: override.active } : {}).candidates.length} options, ${s.checks.filter((c) => !c.todo).length} checks`);
  process.exit(0);
}

// ---- models: the garden's config (env substituted), plus `gateway:<id>` overrides
const world = loadWorldYaml(readFileSync(join(REPO_ROOT, 'worlds/garden2.yaml'), 'utf8'), process.env);
const raw = structuredClone(world.models) as { models: Record<string, ModelDef & Record<string, unknown>>; jobs: Record<string, (string | { use: string })[]> };
const first = (job: string) => {
  const e = raw.jobs[job]?.[0];
  return typeof e === 'string' ? e : e?.use;
};
const key = process.env.AI_GATEWAY_API_KEY ?? '';
function resolveModel(spec: string | undefined, as: 'decide' | 'plan'): string {
  const name = spec ?? first(as)!;
  if (!name.startsWith('gateway:')) {
    if (!raw.models[name]) throw new Error(`no model ${name} in worlds/garden2.yaml (or use gateway:<model id>)`);
    return name;
  }
  const id = name.slice('gateway:'.length);
  const alias = `eval-${as}`;
  raw.models[alias] =
    as === 'decide'
      ? ({ adapter: 'gateway-decision', model: id, apiKey: key, maxStateChars: 900 } as never)
      : ({ ...(raw.models.hostedText ?? {}), adapter: 'openai-compatible', model: id, apiKey: key } as never);
  return alias;
}
const decideModel = resolveModel(opt('--decide'), 'decide');
const planModel = resolveModel(opt('--plan'), 'plan');
const gateway = new ModelGateway(parseModelsConfig(raw), { log: (m) => console.log(m.replace(key || '\u0000', '[key]')) });
const label = (alias: string) => {
  const d = raw.models[alias] as { model?: string; adapter: string };
  return d.model ? `${alias} (${d.model})` : alias;
};
const samples = Math.max(1, Number(opt('--samples') ?? 3));
/** Hosted Laya is rate-limited per team (5 requests a minute, shared with any running server): pace and retry. */
const decideRpm = Number(opt('--decide-rpm') ?? (raw.models[decideModel]?.adapter === 'gateway-decision' ? 4 : 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastDecideAt = 0;
async function call(model: string, req: Parameters<ModelGateway['callModel']>[1], as: 'decide' | 'plan') {
  for (let attempt = 0; ; attempt++) {
    if (as === 'decide' && decideRpm > 0) {
      const wait = lastDecideAt + 60_000 / decideRpm - Date.now();
      if (wait > 0) await sleep(wait);
      lastDecideAt = Date.now();
    }
    try {
      return await gateway.callModel(model, req, as);
    } catch (e) {
      if (attempt < 4 && /HTTP 429|HTTP 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT/.test((e as Error).message)) {
        console.log(`  ${/429/.test((e as Error).message) ? "rate limited" : "network error"}; retrying in 20 s`);
        await sleep(20_000);
        continue;
      }
      throw e;
    }
  }
}

// ---- run
const results: SituationOut[] = [];
let totalCost = 0;
for (const s of situations) {
  const r = await runSituation(s, {
    call,
    decideModel,
    planModel,
    samples,
    ...(override && { active: override.active }),
    redact: (m) => m.replaceAll(key || '\u0000', '[key]'),
    onSample: (aud) => (totalCost += aud),
  });
  const line = Object.entries(r.checks).map(([n, c]) => `${c.ok ? 'ok' : 'FAIL'} ${n} ${c.pass}/${c.applicable}`).join(', ');
  console.log(`${s.id} [${r.job}, ${r.model}, ${r.template.id}@${r.template.version}]: ${line}`);
  results.push(r);
}

// ---- report
const date = new Date().toISOString().slice(0, 10);
mkdirSync(REPORTS_DIR, { recursive: true });
// The newest report by date and run number (`2026-11-17.json`, `2026-11-17-2.json`, …).
const runOrder = (f: string) => {
  const m = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/.exec(f);
  return m ? `${m[1]}-${(m[2] ?? '1').padStart(4, '0')}` : f;
};
const previousFile = readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json')).sort((a, b) => (runOrder(a) < runOrder(b) ? -1 : 1)).at(-1);
const previous = previousFile ? (JSON.parse(readFileSync(join(REPORTS_DIR, previousFile), 'utf8')) as { results: SituationOut[]; file: string }) : undefined;
let stem = date;
for (let n = 2; existsSync(join(REPORTS_DIR, `${stem}.json`)); n++) stem = `${date}-${n}`;
const all_ms = results.flatMap((r) => r.samples.map((x) => x.ms)).sort((a, b) => a - b);
const p = (q: number) => all_ms[Math.min(all_ms.length - 1, Math.floor(q * all_ms.length))] ?? 0;
const byCheck = new Map<string, { pass: number; applicable: number; failing: string[] }>();
for (const r of results) {
  for (const [n, c] of Object.entries(r.checks)) {
    const k = n.split('#')[0]!;
    const agg = byCheck.get(k) ?? { pass: 0, applicable: 0, failing: [] };
    agg.pass += c.pass;
    agg.applicable += c.applicable;
    if (!c.ok) agg.failing.push(r.id);
    byCheck.set(k, agg);
  }
}
const rate = (pass: number, n: number) => (n ? `${Math.round((100 * pass) / n)}% (${pass}/${n})` : 'n/a');
const prevRate = (id: string, check: string) => {
  const c = previous?.results.find((r) => r.id === id)?.checks[check];
  return c ? rate(c.pass, c.applicable) : '–';
};
const okCount = results.filter((r) => Object.values(r.checks).every((c) => c.ok)).length;
const md = [
  `# Model eval: ${stem}`,
  '',
  `- Situations: ${results.length} from [\`evals/situations\`](../../../evals/situations), ${samples} sample(s) each`,
  `- Decide model: \`${label(decideModel)}\`; plan model: \`${label(planModel)}\``,
  `- Prompt templates: ${override ? `\`${override.label}\` (others: version 1)` : 'version 1 (repo defaults)'}`,
  `- Passing every check: ${okCount}/${results.length} situations`,
  `- Cost: A$${totalCost.toFixed(6)} for ${all_ms.length} calls; latency p50 ${(p(0.5) / 1000).toFixed(2)} s, p95 ${(p(0.95) / 1000).toFixed(2)} s`,
  `- Previous run: ${previous ? `[\`${previousFile}\`](${previousFile!.replace(/\.json$/, '.md')})` : 'none'}`,
  '',
  '## By check',
  '',
  '| Check | Pass rate | Situations below threshold |',
  '| --- | --- | --- |',
  ...[...byCheck.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, c]) => `| \`${n}\` | ${rate(c.pass, c.applicable)} | ${c.failing.join(', ') || '–'} |`),
  '',
  '## By situation',
  '',
  '| Situation | Job | Check | Pass | Needed | Previous | |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...results.flatMap((r) =>
    Object.entries(r.checks).map(([n, c]) => `| \`${r.id}\` | ${r.job} | \`${n}\` | ${rate(c.pass, c.applicable)} | ${Math.round(c.minPassRate * 100)}% | ${prevRate(r.id, n)} | ${c.ok ? 'ok' : '**below**'} |`),
  ),
  '',
  '## Answers',
  '',
  ...results.flatMap((r) => [
    `### \`${r.id}\` (${r.job}, ${r.template.id}@${r.template.version}): ${r.title}`,
    '',
    `Thinking (the brain's choice): ${r.thinking.depth} (${r.thinking.why}). Options: ${r.options.map((o) => `${o.id} ${o.label}`).join('; ')}`,
    '',
    ...r.samples.map(
      (x, i) =>
        `${i + 1}. ${x.error ? `error: ${x.error}` : x.choices.map((id) => `${id}${x.reasons?.[id] ? ` ("${x.reasons[id]!.replace(/\|/g, '/')}")` : ''}`).join(', ')}${x.confidence !== undefined ? `; confidence ${x.confidence.toFixed(2)}` : ''}; ${(x.ms / 1000).toFixed(2)} s, A$${x.costAud.toFixed(6)}`,
    ),
    '',
  ]),
].join('\n');
writeFileSync(join(REPORTS_DIR, `${stem}.md`), `${md}\n`);
writeFileSync(join(REPORTS_DIR, `${stem}.json`), `${JSON.stringify({ file: stem, date, samples, decideModel: label(decideModel), planModel: label(planModel), ...(override && { template: override.label }), totalCostAud: totalCost, results }, null, 1)}\n`);
console.log(`\n${okCount}/${results.length} situations pass every check. Total cost A$${totalCost.toFixed(6)}. Wrote ${relative(REPO_ROOT, join(REPORTS_DIR, `${stem}.md`))}`);

import type { JobRequest, Json, Usage } from '@uas/core';
import type { ActiveTemplates } from '@uas/mind';
import { runChecks, type Answer } from './checks.ts';
import { situationRequest, type Situation } from './situation.ts';

/**
 * Running one situation against a model: shared by `npm run eval` and the server's prompt tests
 * (`POST /prompts/:tid/test`), so both score answers the same way.
 */

export type CallModel = (model: string, req: JobRequest, as: 'decide' | 'plan') => Promise<{ answer: Record<string, Json>; usage: Usage }>;

export interface SampleOut {
  choices: string[];
  reasons?: Record<string, string>;
  confidence?: number;
  ms: number;
  costAud: number;
  error?: string;
  checks: Record<string, boolean | undefined>;
}

export interface SituationOut {
  id: string;
  title: string;
  job: string;
  model: string;
  options: { id: string; label: string }[];
  /** How hard the brain itself would choose to think here (code, before any model). */
  thinking: { depth: string; why: string };
  /** The prompt template and version that rendered the request. */
  template: { id: string; version: number | string };
  samples: SampleOut[];
  checks: Record<string, { pass: number; applicable: number; minPassRate: number; ok: boolean }>;
}

export interface RunOptions {
  call: CallModel;
  decideModel: string;
  planModel: string;
  samples: number;
  /** Template overrides (a stored version or a draft under test). */
  active?: ActiveTemplates;
  /** Force the decision template, and with it the route (decide → decide model, plan → plan model). */
  template?: 'decide' | 'plan';
  /** Hide secrets in error messages. */
  redact?: (s: string) => string;
  /** Called after each sample (progress). */
  onSample?: (costAud: number) => void;
}

/** Where a situation's request goes: `auto` follows the brain (habit → its own top option, no call). */
export function routeOf(s: Situation, depth: string, template?: 'decide' | 'plan'): 'decide' | 'plan' | 'habit' {
  if (template) return template;
  if (s.job !== 'auto') return s.job;
  return depth === 'think' ? 'plan' : depth === 'gut' ? 'decide' : 'habit';
}

/** Whether a situation's checks pass overall: a check is ok when its pass rate reaches its threshold. */
export function passes(r: Pick<SituationOut, 'checks'>): boolean {
  return Object.values(r.checks).every((c) => c.ok);
}

export async function runSituation(s: Situation, o: RunOptions): Promise<SituationOut> {
  const { request, candidates, thinking, built, template } = situationRequest(s, { ...(o.active && { active: o.active }), ...(o.template && { template: o.template }) });
  const route = routeOf(s, thinking.depth, o.template);
  const model = route === 'plan' ? o.planModel : route === 'decide' ? o.decideModel : 'habit (no model)';
  const redact = o.redact ?? ((x: string) => x);
  const out: SampleOut[] = [];
  for (let i = 0; i < o.samples; i++) {
    const started = performance.now();
    let answer: Answer | undefined;
    let sample: Omit<SampleOut, 'checks'>;
    if (route === 'habit') {
      answer = { choices: [candidates[0]!.id] };
      out.push({ choices: answer.choices, ms: 0, costAud: 0, checks: runChecks({ situation: s, candidates, thinking, built, answer }) });
      o.onSample?.(0);
      continue;
    }
    try {
      const r = await o.call(model, { ...request, jobId: `eval-${s.id}-${i}`, multi: { max: 3 } }, route);
      const ids = Array.isArray(r.answer.choices) ? (r.answer.choices as { id: string }[]).map((c) => String(c.id)) : [];
      const reasons = r.answer.reasons && typeof r.answer.reasons === 'object' ? (r.answer.reasons as Record<string, string>) : undefined;
      answer = { choices: ids, ...(reasons && { reasons }) };
      sample = {
        choices: ids,
        ...(reasons && { reasons }),
        ...(typeof r.answer.confidence === 'number' && { confidence: r.answer.confidence }),
        ms: Math.round(r.usage.latencyMs || performance.now() - started),
        costAud: r.usage.costAud,
      };
    } catch (e) {
      sample = { choices: [], ms: Math.round(performance.now() - started), costAud: 0, error: redact((e as Error).message).slice(0, 200) };
    }
    out.push({ ...sample, checks: runChecks({ situation: s, candidates, thinking, built, answer }) });
    o.onSample?.(sample.costAud);
  }
  const checks: SituationOut['checks'] = {};
  for (const name of Object.keys(out[0]?.checks ?? {})) {
    const spec = s.checks.find((c, i) => !c.todo && (name === c.check || name === `${c.check}#${i}`))!;
    const vals = out.map((x) => x.checks[name]).filter((v): v is boolean => v !== undefined);
    const pass = vals.filter(Boolean).length;
    checks[name] = { pass, applicable: vals.length, minPassRate: spec.minPassRate, ok: vals.length === 0 || pass >= Math.round(spec.minPassRate * vals.length) /* 0.67 of 3 = 2 */ };
  }
  const job = s.job === 'auto' && !o.template ? `auto→${route}` : o.template && s.job !== o.template ? `${s.job}→${route}` : s.job;
  return { id: s.id, title: s.title, job, model, options: candidates.map((c) => ({ id: c.id, label: c.label })), thinking, template, samples: out, checks };
}

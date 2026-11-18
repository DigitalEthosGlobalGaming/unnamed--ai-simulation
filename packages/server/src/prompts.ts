import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { quoteNote, type JobRequest, type Json, type Usage } from '@uas/core';
import { buildSituation, loadSituations, runSituation, situationRequest, type Situation, type SituationOut } from '@uas/evals';
import {
  DEFAULT_TEMPLATES,
  TEMPLATES,
  TEMPLATE_IDS,
  consolidateQuestion,
  estimateTokens,
  renderPart,
  safetyBlock,
  sheetQuestion,
  validateTemplate,
  type TemplateBody,
  type TemplateId,
} from '@uas/mind';
import { renderPrompt } from '@uas/models';
import { PromptVersions, SqliteInputLog, schema, type Db } from '@uas/store';
import { latestEvalReport } from './refine.ts';

/**
 * Prompt templates on the server (docs/architecture/prompts.md): the immutable versions, preview
 * against saved situations, paid tests (one at a time, through a running world's gateway so they
 * count towards its daily cap) and the per-world activation history (from the input log).
 */

export class StatusError extends Error {
  readonly status: number;
  readonly errors?: unknown;
  constructor(status: number, message: string, errors?: unknown) {
    super(message);
    this.status = status;
    if (errors !== undefined) this.errors = errors;
  }
}

/** What a test needs from a running world: its config's models, today's spend, and a metered call. */
export interface TestWorld {
  id: string;
  models: unknown;
  costAudToday: number;
  activeVersion(tid: TemplateId): Promise<number | string>;
  call(model: string, request: JobRequest, as: 'decide' | 'plan'): Promise<{ answer: Record<string, Json>; usage: Usage }>;
}

export interface TestStatus {
  testId: string;
  templateId: TemplateId;
  version: number | 'draft';
  world: string;
  status: 'running' | 'done' | 'failed';
  progress: { done: number; total: number };
  aud: number;
  error?: string;
  results: {
    situation: string;
    passes: number;
    runs: number;
    /** Runs whose model call failed (not scored). */
    errors: number;
    /** `pass`: the check passed in every run where it applied. */
    checks: { name: string; pass: boolean; passed: number; applicable: number; minPassRate: number; ok: boolean }[];
    baseline?: { passes: number; runs: number };
    answers: { choices: string[]; reasons?: Record<string, string>; error?: string }[];
  }[];
}

export interface HistoryEntry {
  tid: string;
  version: number | string;
  tick: number;
  at?: string;
  by?: string;
}

const TESTABLE: TemplateId[] = ['decide', 'plan'];
const SAMPLE_NOTE = 'hello little robot, what do you like to do?';
/**
 * AI Gateway allows 5 requests a minute per team for the hosted models we use (Laya, and
 * llama-3.1-8b on Bedrock), shared with running worlds: tests pace hosted calls at 4 a minute and
 * retry rate-limited ones.
 */
const HOSTED_RPM = 4;
const RETRY_MS = 20_000;
const HOSTED = new Set(['gateway-decision', 'openai-compatible', 'ai-sdk', 'jev']);
const MAX_RUNS = 5;

export function isTemplateId(x: string): x is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(x);
}

export class PromptService {
  readonly store: PromptVersions;
  private readonly db: Db;
  private readonly log: SqliteInputLog;
  private readonly situationsDir: string;
  private readonly reportsDir: string;
  private readonly tests = new Map<string, TestStatus>();
  private running: string | undefined;
  /** For tests: no pacing between decision calls. */
  private readonly pace: boolean;

  constructor(db: Db, opts: { situationsDir: string; reportsDir: string; pace?: boolean }) {
    this.db = db;
    this.store = new PromptVersions(db, DEFAULT_TEMPLATES as unknown as Record<string, TemplateBody>);
    this.log = new SqliteInputLog(db);
    this.situationsDir = opts.situationsDir;
    this.reportsDir = opts.reportsDir;
    this.pace = opts.pace ?? true;
  }

  private info(tid: string) {
    if (!isTemplateId(tid)) throw new StatusError(404, `no template ${tid} (templates: ${TEMPLATE_IDS.join(', ')})`);
    return TEMPLATES[tid];
  }

  list() {
    return TEMPLATE_IDS.map((id) => {
      const t = TEMPLATES[id];
      return { id, name: t.name, description: t.description, parts: t.parts, latestVersion: this.store.latest(id) };
    });
  }

  get(tid: string) {
    const t = this.info(tid);
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      parts: t.parts,
      prefixParts: t.prefixParts,
      variables: t.variables,
      safetyBlock: safetyBlock(t.id),
      ...(t.safetyPart && { safetyPart: t.safetyPart }),
      versions: this.store.versions(t.id).map(({ version, note, createdAt, createdBy }) => ({ version, note, createdAt, createdBy })),
    };
  }

  version(tid: string, v: number) {
    this.info(tid);
    const r = this.store.get(tid, v);
    if (!r) throw new StatusError(404, `no version ${v} of ${tid}`);
    return { version: r.version, body: r.body, note: r.note, createdAt: r.createdAt, createdBy: r.createdBy };
  }

  validate(tid: string, body: unknown) {
    return validateTemplate(this.info(tid).id, body);
  }

  create(tid: string, body: unknown, note: unknown, by: string) {
    const r = this.validate(tid, body);
    if (!r.ok) throw new StatusError(400, `invalid template: ${r.errors.map((e) => `${e.part ? `${e.part}: ` : ''}${e.message}`).join('; ')}`, r.errors);
    const clean = { parts: Object.fromEntries(TEMPLATES[tid as TemplateId].parts.map((p) => [p, (body as TemplateBody).parts[p]!])) };
    return { version: this.store.create(tid, clean, typeof note === 'string' ? note.slice(0, 500) : '', by).version };
  }

  /** `{ body }` (a draft, validated) or `{ version }` (stored). */
  private resolve(tid: TemplateId, req: { body?: unknown; version?: unknown }): { version: number | 'draft'; body: TemplateBody } {
    if (req.body !== undefined) {
      const r = validateTemplate(tid, req.body);
      if (!r.ok) throw new StatusError(400, 'invalid template', r.errors);
      return { version: 'draft', body: req.body as TemplateBody };
    }
    const v = Number(req.version ?? 1);
    const row = this.store.get(tid, v);
    if (!row) throw new StatusError(404, `no version ${String(req.version)} of ${tid}`);
    return { version: v, body: row.body };
  }

  private allSituations(): (Situation & { file: string })[] {
    return loadSituations(this.situationsDir);
  }

  private templatesFor(s: Situation): TemplateId[] {
    const decision: TemplateId[] = s.job === 'auto' ? ['decide', 'plan'] : [s.job];
    return [...decision, 'consolidate', 'sheet', 'mail'];
  }

  situations() {
    return this.allSituations().map((s) => ({ id: s.id, title: s.title, templates: this.templatesFor(s) }));
  }

  private situation(id: unknown): Situation {
    const s = this.allSituations().find((x) => x.id === id);
    if (!s) throw new StatusError(404, `no situation ${String(id)}`);
    return s;
  }

  /** The prompt exactly as a model would get it, part by part (the safety block already appended). */
  preview(tid: string, req: { body?: unknown; version?: unknown; situation?: unknown }) {
    const id = this.info(tid).id;
    const { version, body } = this.resolve(id, req);
    const s = this.situation(req.situation);
    const active = { [id]: { version, body } };
    let parts: Record<string, string>;
    let packVersions = '';
    if (id === 'decide' || id === 'plan') {
      const r = situationRequest(s, { active, template: id });
      parts = { ...r.request.context } as unknown as Record<string, string>;
      packVersions = r.built.world.state.packVersions;
    } else if (id === 'mail') {
      const note = buildSituation(s).world.state.mailbox?.queue[0]?.text ?? SAMPLE_NOTE;
      parts = { line: renderPart(body.parts.line ?? '', { note: quoteNote(note) }) };
    } else {
      const m = buildSituation(s).character.mind!;
      const q = id === 'consolidate' ? consolidateQuestion(m, active) : sheetQuestion(m, undefined, active);
      parts = { system: q.question, input: q.input };
    }
    const text = Object.values(parts).join('\n\n');
    return { parts, safetyBlock: safetyBlock(id, packVersions), tokens: estimateTokens(text), version };
  }

  /** Estimate a test: calls, A$ (from the world's model prices) and minutes (decision calls are paced). */
  private plan(tid: TemplateId, req: { body?: unknown; version?: unknown; situations?: unknown; runs?: unknown }, w: TestWorld) {
    if (!TESTABLE.includes(tid)) throw new StatusError(400, `${tid} can't be tested yet: there are no ${tid === 'mail' ? 'mail' : 'sleep'} situations to score it. Use preview.`);
    const { version, body } = this.resolve(tid, req);
    const all = this.allSituations().filter((s) => this.templatesFor(s).includes(tid));
    const wanted = Array.isArray(req.situations) ? req.situations.map(String) : undefined;
    const situations = wanted ? wanted.map((id) => all.find((s) => s.id === id) ?? this.situation(id)) : all;
    for (const s of situations) if (!this.templatesFor(s).includes(tid)) throw new StatusError(400, `situation ${s.id} doesn't exercise ${tid}`);
    if (situations.length === 0) throw new StatusError(400, `no situations exercise ${tid}`);
    const runs = Math.min(MAX_RUNS, Math.max(1, Math.round(Number(req.runs ?? 1)) || 1));
    const models = modelsOf(w.models);
    const model = models.first(tid);
    if (!model) throw new StatusError(409, `world ${w.id} has no model for ${tid}`);
    const def = models.def(model);
    const active = { [tid]: { version, body } };
    let usd = 0;
    for (const s of situations) {
      const { request } = situationRequest(s, { active, template: tid as 'decide' | 'plan' });
      const { system, user } = renderPrompt(request.context);
      const decisionModel = def.adapter === 'gateway-decision' || def.adapter === 'ollama-decision';
      const inTok = decisionModel ? Math.ceil((def.maxStateChars ?? 1200) / 4) + 60 : estimateTokens(system + user) + 40;
      const outTok = decisionModel ? 20 : 200;
      usd += runs * ((inTok * (def.price?.inputPerMTok ?? 0) + outTok * (def.price?.outputPerMTok ?? 0)) / 1e6);
    }
    const calls = situations.length * runs;
    const paced = this.pace && HOSTED.has(def.adapter);
    const minutes = paced ? calls / HOSTED_RPM : (calls * 4) / 60;
    const aud = usd * models.audPerUsd;
    return { version, body, situations, runs, model, estimate: { calls, aud: Number(aud.toFixed(6)), minutes: Math.round(minutes * 10) / 10 }, paced };
  }

  /** Without `confirm`: the estimate only. With it: start the test in the background. */
  async test(tid: string, req: { body?: unknown; version?: unknown; situations?: unknown; runs?: unknown; confirm?: unknown }, w: TestWorld | undefined) {
    const id = this.info(tid).id;
    if (!w) throw new StatusError(409, 'no running world to run the test through (tests use a world’s models and count towards its daily cap)');
    const p = this.plan(id, req, w);
    if (req.confirm !== true) return { estimate: p.estimate };
    if (this.running) throw new StatusError(409, `a test is already running (${this.running})`);
    const cap = modelsOf(w.models).dailyCapAud;
    if (w.costAudToday + p.estimate.aud > cap) throw new StatusError(409, `the estimate (A$${p.estimate.aud.toFixed(4)}) would pass world ${w.id}'s daily cap (A$${cap}, A$${w.costAudToday.toFixed(4)} spent today)`);
    const testId = randomBytes(6).toString('hex');
    const status: TestStatus = { testId, templateId: id, version: p.version, world: w.id, status: 'running', progress: { done: 0, total: p.estimate.calls }, aud: 0, results: [] };
    this.tests.set(testId, status);
    this.running = testId;
    const baseline = await this.baseline(id, w);
    void this.run(status, p, w, baseline).finally(() => {
      if (this.running === testId) this.running = undefined;
    });
    return { testId, estimate: p.estimate };
  }

  private async run(status: TestStatus, p: ReturnType<PromptService['plan']>, w: TestWorld, baseline: Map<string, { passes: number; runs: number }> | undefined): Promise<void> {
    let last = 0;
    const call = async (model: string, request: JobRequest, as: 'decide' | 'plan') => {
      for (let attempt = 0; ; attempt++) {
        if (p.paced) {
          const wait = last + 60_000 / HOSTED_RPM - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          last = Date.now();
        }
        try {
          return await w.call(model, request, as);
        } catch (e) {
          if (!p.paced || attempt >= 2 || !/HTTP 429|HTTP 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT/.test((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      }
    };
    const models = modelsOf(w.models);
    try {
      for (const s of p.situations) {
        const out: SituationOut = await runSituation(s, {
          call,
          decideModel: models.first('decide') ?? p.model,
          planModel: models.first('plan') ?? p.model,
          samples: p.runs,
          active: { [status.templateId]: { version: p.version, body: p.body } },
          template: status.templateId as 'decide' | 'plan',
          onSample: (aud) => {
            status.progress.done++;
            status.aud += aud;
          },
        });
        const okSamples = out.samples.filter((x) => !x.error && Object.values(x.checks).every((c) => c !== false)).length;
        const b = baseline?.get(s.id);
        status.results.push({
          situation: s.id,
          passes: okSamples,
          runs: out.samples.length,
          errors: out.samples.filter((x) => x.error).length,
          checks: Object.entries(out.checks).map(([name, c]) => ({ name, pass: c.pass === c.applicable, passed: c.pass, applicable: c.applicable, minPassRate: c.minPassRate, ok: c.ok })),
          ...(b && { baseline: b }),
          answers: out.samples.map((x) => ({ choices: x.choices, ...(x.reasons && { reasons: x.reasons }), ...(x.error && { error: x.error }) })),
        });
      }
      status.status = 'done';
    } catch (e) {
      status.status = 'failed';
      status.error = (e as Error).message.slice(0, 300);
    }
  }

  /** The active version's results from the latest eval report, when that report ran the version that's active now. */
  private async baseline(tid: TemplateId, w: TestWorld): Promise<Map<string, { passes: number; runs: number }> | undefined> {
    const report = latestEvalReport(this.reportsDir) as { template?: string; results?: SituationOut[] } | undefined;
    if (!report?.results) return undefined;
    const active = await w.activeVersion(tid);
    const ran = report.template?.startsWith(`${tid}@`) ? report.template.slice(tid.length + 1) : '1';
    if (String(active) !== ran) return undefined;
    const out = new Map<string, { passes: number; runs: number }>();
    for (const r of report.results) {
      // Only results that went through this template's route.
      const route = r.job.includes('→') ? r.job.split('→')[1] : r.job;
      if (route !== tid) continue;
      out.set(r.id, { passes: r.samples.filter((x) => Object.values(x.checks).every((c) => c !== false)).length, runs: r.samples.length });
    }
    return out;
  }

  testStatus(testId: string): TestStatus {
    const t = this.tests.get(testId);
    if (!t) throw new StatusError(404, `no test ${testId} (tests are kept in memory until the server restarts)`);
    return t;
  }

  /** A world's activations, oldest first, including its fork parents' before the fork. */
  history(worldId: string): HistoryEntry[] {
    const row = this.db.select().from(schema.worlds).where(eq(schema.worlds.id, worldId)).get();
    const inherited = row?.parentWorldId && row.forkTick !== null ? this.history(row.parentWorldId).filter((h) => h.tick < row.forkTick!) : [];
    const own = this.log.ofType(worldId, 'prompts.activate').map((e) => {
      const p = e.payload as { templateId: string; version: number | string; at?: string; by?: string };
      return { tid: p.templateId, version: p.version, tick: e.tick, ...(p.at && { at: p.at }), ...(p.by && { by: p.by }) };
    });
    return [...inherited, ...own];
  }

  /** The `prompts.activate` payload for a stored version. */
  activation(tid: string, version: unknown, by: string) {
    const id = this.info(tid).id;
    const v = Number(version);
    const row = Number.isInteger(v) ? this.store.get(id, v) : undefined;
    if (!row) throw new StatusError(404, `no version ${String(version)} of ${id}`);
    return { templateId: id, version: v, body: row.body, at: new Date().toISOString(), by };
  }

  /** The version to roll back to: the one active before the current one (409 if there's none). */
  rollbackTarget(worldId: string, tid: string): number {
    const id = this.info(tid).id;
    const h = this.history(worldId).filter((x) => x.tid === id);
    if (h.length === 0) throw new StatusError(409, `nothing to roll back to: ${id} has never been activated in ${worldId}`);
    const current = h.at(-1)!.version;
    const previous = h.length >= 2 ? h.at(-2)!.version : 1;
    if (previous === current) throw new StatusError(409, `nothing to roll back to: ${id}@${current} was also active before`);
    return Number(previous);
  }
}

interface RawModels {
  audPerUsd?: number;
  dailyCapAud?: number;
  models?: Record<string, { adapter: string; maxStateChars?: number; price?: { inputPerMTok: number; outputPerMTok: number } }>;
  jobs?: Record<string, (string | { use: string })[]>;
}

/** The parts of a world's model config a test needs (never the keys). */
function modelsOf(raw: unknown) {
  const m = (raw ?? {}) as RawModels;
  return {
    audPerUsd: Number(m.audPerUsd ?? 1.55),
    dailyCapAud: Number(m.dailyCapAud ?? 0.5),
    first(job: string): string | undefined {
      const e = m.jobs?.[job]?.[0];
      return typeof e === 'string' ? e : e?.use;
    },
    def(name: string) {
      return m.models?.[name] ?? { adapter: 'unknown' };
    },
  };
}

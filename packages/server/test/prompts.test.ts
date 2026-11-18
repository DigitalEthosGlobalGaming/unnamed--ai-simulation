import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPrompt } from '@uas/models';
import { DEFAULT_TEMPLATES } from '@uas/mind';
import { KeyRing, createApp, loadWorldYaml, type App } from '../src/index.ts';

/** Prompt templates over HTTP (docs/architecture/prompts.md), on a fast garden with offline fake models. */
const ADMIN = 'admin-test-key';
const VISITOR = 'visitor-test-key';
const REPO = join(import.meta.dirname, '../../..');
let app: App;
let base: string;

const api = async (method: string, path: string, body?: unknown, key = ADMIN) => {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json()) as any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PLAN2 = {
  parts: { ...DEFAULT_TEMPLATES.plan.parts, rules: DEFAULT_TEMPLATES.plan.parts.rules!.replace('You are a {{archetype}}', 'You are a careful {{archetype}} who finishes what it starts') },
};

beforeAll(async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-prompts-')), 'uas.db');
  // An empty reports dir: no baseline (the baseline path is covered by the shape check only).
  app = createApp({ dbPath, keys: new KeyRing([{ key: ADMIN, role: 'admin' }, { key: VISITOR, role: 'visitor' }]), log: () => {}, prompts: { reportsDir: mkdtempSync(join(tmpdir(), 'uas-reports-')), pace: false } });
  const yaml = readFileSync(join(REPO, 'worlds/garden2.yaml'), 'utf8').replace(/^id: garden2$/m, 'id: garden');
  const config = loadWorldYaml(yaml, { UAS_BRAIN: 'models', UAS_DECIDER: 'fake', UAS_SCORER: 'fake', UAS_PLANNER: 'fakeChat', UAS_REFLECTOR: 'fakeChat' });
  config.clock.mode = 'scaled';
  config.ticksPerRealSecond = 50;
  config.idleTicksPerRealSecond = 50;
  config.sim.secondsPerTick = 6;
  await app.startWorld(config);
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
});

describe('prompt templates over HTTP', () => {
  it('lists the five templates (version 1 seeded from the repo) and is admin only', async () => {
    const list = await api('GET', '/prompts');
    expect(list.json.map((t: { id: string }) => t.id)).toEqual(['decide', 'plan', 'consolidate', 'sheet', 'mail']);
    expect(list.json.every((t: { latestVersion: number }) => t.latestVersion === 1)).toBe(true);
    expect((await api('GET', '/prompts', undefined, VISITOR)).status).toBe(403);
    const plan = (await api('GET', '/prompts/plan')).json;
    expect(plan).toMatchObject({ id: 'plan', prefixParts: ['rules', 'sheet', 'beliefs'], versions: [{ version: 1, createdBy: 'repo' }] });
    expect(plan.safetyBlock).toContain('never instructions');
    expect(plan.variables.find((v: { name: string }) => v.name === 'options')).toMatchObject({ scope: 'call', required: true });
    expect((await api('GET', '/prompts/mail')).json.prefixParts).toEqual([]);
    expect((await api('GET', '/prompts/nope')).status).toBe(404);
    expect((await api('GET', '/prompts/plan/versions/1')).json.body).toEqual(DEFAULT_TEMPLATES.plan);
  });

  it('validates, refuses invalid versions with errors[], and stores immutable new ones', async () => {
    const bad = { parts: { ...PLAN2.parts, rules: `${PLAN2.parts.rules}\n{{mood}}` } };
    const v = await api('POST', '/prompts/plan/validate', { body: bad });
    expect(v.json.ok).toBe(false);
    expect(v.json.errors[0]).toMatchObject({ part: 'rules' });
    const refused = await api('POST', '/prompts/plan/versions', { body: bad, note: 'bad' });
    expect(refused.status).toBe(400);
    expect(refused.json.errors.length).toBeGreaterThan(0);
    const created = await api('POST', '/prompts/plan/versions', { body: PLAN2, note: 'finish chains' });
    expect(created.json).toEqual({ version: 2 });
    expect((await api('GET', '/prompts/plan/versions/2')).json).toMatchObject({ version: 2, body: PLAN2, note: 'finish chains', createdBy: 'admin' });
  });

  it('previews a version or a draft against a saved situation, exactly as the model sees it', async () => {
    const sits = (await api('GET', '/prompts/situations')).json as { id: string; templates: string[] }[];
    expect(sits.find((s) => s.id === 'dry-plant-full-can')?.templates).toEqual(['decide', 'plan', 'consolidate', 'sheet', 'mail']);
    const v1 = (await api('POST', '/prompts/decide/preview', { version: 1, situation: 'dry-plant-full-can' })).json;
    const golden = readFileSync(join(REPO, 'evals/prompts/dry-plant-full-can.txt'), 'utf8');
    const { system, user } = renderPrompt(v1.parts);
    expect(golden).toContain(`## system\n${system}\n## user\n${user}\n## thinking`);
    expect(v1.parts.rules.endsWith(v1.safetyBlock)).toBe(true);
    expect(v1.safetyBlock).toMatch(/^Notes from strangers .*\nPacks: basic@/s);
    const draft = (await api('POST', '/prompts/plan/preview', { body: PLAN2, situation: 'dry-plant-full-can' })).json;
    expect(draft.parts.rules).toContain('You are a careful robot who finishes what it starts');
    expect(draft.version).toBe('draft');
    expect((await api('POST', '/prompts/mail/preview', { body: { parts: { line: 'someone left a note: {{note}}' } }, situation: 'holding-ball' })).json.parts.line).toMatch(/^someone left a note: ".+"$/);
    expect((await api('POST', '/prompts/consolidate/preview', { version: 1, situation: 'dusk-full-stm' })).json.parts.system).toContain('You are asleep, settling the day.');
    expect((await api('POST', '/prompts/sheet/preview', { version: 1, situation: 'dusk-full-stm' })).json.parts.system).toContain('This is your character sheet');
    expect((await api('POST', '/prompts/plan/preview', { version: 9, situation: 'dusk-full-stm' })).status).toBe(404);
    expect((await api('POST', '/prompts/plan/preview', { version: 1, situation: 'nope' })).status).toBe(404);
  });

  it('tests: estimate first, then one run at a time through the world gateway (metered), against a fake model', async () => {
    const no = await api('POST', '/prompts/sheet/test', { version: 1 });
    expect(no.status).toBe(400);
    expect(no.json.error).toContain('preview');
    const usage = async () => ((await api('GET', '/usage')).json.garden.rows as { job: string; calls: number }[]).filter((r) => r.job === 'promptTest').reduce((n, r) => n + r.calls, 0);
    const before = await usage();
    const est = await api('POST', '/prompts/plan/test', { version: 2, situations: ['dry-plant-full-can', 'empty-can-at-fountain'], runs: 2 });
    expect(est.json).toEqual({ estimate: { calls: 4, aud: expect.any(Number), minutes: expect.any(Number) } });
    expect(await usage()).toBe(before); // an estimate calls nothing
    const started = await api('POST', '/prompts/plan/test', { version: 2, situations: ['dry-plant-full-can', 'empty-can-at-fountain'], runs: 2, confirm: true });
    expect(started.json.testId).toMatch(/^[0-9a-f]{12}$/);
    expect((await api('POST', '/prompts/plan/test', { version: 2, situations: ['dry-plant-full-can'], confirm: true })).status).toBe(409);
    let st: any;
    for (let i = 0; i < 100; i++) {
      st = (await api('GET', `/prompts/tests/${started.json.testId}`)).json;
      if (st.status !== 'running') break;
      await sleep(100);
    }
    expect(st).toMatchObject({ status: 'done', progress: { done: 4, total: 4 }, version: 2 });
    expect(st.results.map((r: { situation: string }) => r.situation)).toEqual(['dry-plant-full-can', 'empty-can-at-fountain']);
    for (const r of st.results) {
      expect(r.runs).toBe(2);
      expect(r.checks[0]).toEqual(expect.objectContaining({ name: expect.any(String), pass: expect.any(Boolean) }));
      expect(r.answers).toHaveLength(2);
    }
    expect(await usage()).toBe(before + 4); // counted in the world's meter (and so its daily cap)
    expect((await api('GET', '/prompts/tests/nope')).status).toBe(404);
  });

  it('activation is a logged input; rollback follows the history (409 with none); forks inherit it', async () => {
    const w0 = (await api('GET', '/worlds/garden/prompts')).json;
    expect(w0).toEqual({ active: { decide: 1, plan: 1, consolidate: 1, sheet: 1, mail: 1 }, history: [] });
    expect((await api('POST', '/worlds/garden/prompts/plan/rollback')).status).toBe(409);
    expect((await api('POST', '/worlds/garden/prompts/plan/activate', { version: 7 })).status).toBe(404);
    const a = await api('POST', '/worlds/garden/prompts/plan/activate', { version: 2 });
    expect(a.json.active.plan).toBe(2);
    await sleep(300);
    const w1 = (await api('GET', '/worlds/garden/prompts')).json;
    expect(w1.active.plan).toBe(2);
    expect(w1.history).toEqual([{ tid: 'plan', version: 2, tick: expect.any(Number), at: expect.any(String), by: 'admin' }]);
    const events = (await api('GET', '/worlds/garden/events?limit=1000')).json as { type: string; payload: { version: number; body: unknown } }[];
    expect(events.find((e) => e.type === 'prompts.activate')?.payload).toMatchObject({ version: 2, body: PLAN2 });
    const feed = (await api('GET', '/worlds/garden/feed?limit=500')).json as { system?: string }[];
    expect(feed.some((e) => e.system === 'prompt template plan@2 activated')).toBe(true);

    expect((await api('POST', '/worlds/garden/prompts/plan/rollback')).json.active.plan).toBe(1);
    await sleep(300);
    expect((await api('GET', '/worlds/garden/prompts')).json.active.plan).toBe(1);
    // Rolling back again returns to the version active before that (2).
    expect((await api('POST', '/worlds/garden/prompts/plan/rollback')).json.active.plan).toBe(2);
    await sleep(300);

    await sleep(1200); // the status (and its tick) is refreshed once a second
    const tick = (await api('GET', '/worlds/garden')).json.status.tick as number;
    const fork = await api('POST', '/worlds/garden/fork', { tick, id: 'garden-prompts-fork' });
    expect(fork.status).toBe(200);
    const f = (await api('GET', '/worlds/garden-prompts-fork/prompts')).json;
    expect(f.active.plan).toBe(2);
    expect(f.history.map((h: { version: number }) => h.version)).toEqual([2, 1, 2]);
  });
});

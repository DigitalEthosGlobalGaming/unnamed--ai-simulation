import { describe, expect, it } from 'vitest';
import type { JobRequest, PromptParts } from '@uas/core';
import { ModelGateway, loadModelsConfigYaml, priceUsage } from '../src/index.ts';
import { BASE_YAML, fakeOllama, jobsYaml, runWithModels } from './harness.ts';

const context: PromptParts = { rules: 'r', sheet: 's', beliefs: 'b', shortTerm: '', state: 'battery: good', observations: '', question: 'q' };
const job = (over: Partial<JobRequest> = {}): JobRequest => ({
  jobId: 'j1', job: 'decide', characterId: 'robot', tick: 1, energy: 0.8, isNight: false, context, question: 'Which?',
  options: [{ id: 'c0', label: 'charge the solarPad (0 tiles away)' }, { id: 'c1', label: 'wait and watch' }], ...over,
});

describe('M4: model gateway', () => {
  it('prices uncached, cached and output tokens separately, in AUD', () => {
    const u = priceUsage('m', { inputTokens: 1000, cachedInputTokens: 10_000, outputTokens: 100, latencyMs: 5 }, { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 5 }, 1.5);
    // (1000·1 + 10000·0.1 + 100·5) / 1e6 USD = 0.0025 USD → 0.00375 AUD
    expect(u.costAud).toBeCloseTo(0.00375, 10);
  });

  it.each([
    ['fake', 'decision'],
    ['{ use: chat, as: decision }', 'llm'],
    ['local', 'local'],
    ['tev', 'decision'],
  ])('runs the same world with decide: [%s] by config change only', async (decider, tier) => {
    const run = await runWithModels(jobsYaml(decider), 1500);
    const modelEntries = run.feed.filter((f) => f.tier === tier && f.modelId);
    expect(modelEntries.length).toBeGreaterThan(0);
    expect(run.deltas.filter((d) => d.kind === 'action' && d.status === 'done').length).toBeGreaterThan(3);
    // Every model call is charged: feed energy cost = AUD cost × energyPerAud.
    for (const f of modelEntries) expect(f.energyCost).toBeCloseTo(f.usage!.costAud * 2, 3);
    const rows = run.gateway.meter.report();
    expect(rows.every((r) => Math.abs(r.energy - r.costAud * 2) < 1e-9)).toBe(true);
    expect(rows.some((r) => r.job === 'appraise') && rows.some((r) => r.job === 'scoreMemory')).toBe(true);
  });

  it('charges the robot the energy for a recorded answer, cached tokens at the cached price', async () => {
    const run = await runWithModels(jobsYaml('fake'), 200);
    const f = run.feed.find((x) => x.modelId === 'fake')!;
    const u = f.usage!;
    expect(u.cachedInputTokens).toBeGreaterThan(0);
    const expected = ((u.inputTokens * 1 + u.cachedInputTokens * 0.1 + u.outputTokens * 5) / 1e6) * 1.5;
    expect(u.costAud).toBeCloseTo(expected, 8);

    // Apply one answer by hand and check the battery drop (minus one tick of idle drain).
    const { world, robot } = run;
    const pending = robot.mind!.pendingJobs[0] ?? undefined;
    const jobId = pending?.jobId ?? 'late';
    const before = robot.energy;
    world.enqueue({
      worldId: 'm4', seq: 10_000, tick: world.tick, type: 'model.answer', packVersions: world.state.packVersions,
      payload: { jobId, job: 'appraise', characterId: 'robot', modelId: 'fake', promptHash: '', answer: { value: 0.5 }, usage: { ...u, costAud: 0.01 } },
    });
    world.step();
    const idle = (0.02 * 6) / 3600;
    expect(before - robot.energy).toBeCloseTo(0.02 + idle, 3);
  });

  it('falls through on error and timeout, and honours minEnergy and the daily cap', async () => {
    const yaml = `${BASE_YAML.replace('dailyCapAud: 5', 'dailyCapAud: 0')}
  big: { adapter: ai-sdk, provider: anthropic, model: claude-sonnet-5-5 }
  broken: { adapter: local, model: nope, url: "http://127.0.0.1:9" }
jobs:
  decide: [{ use: chat, minEnergy: 0.9 }, big, broken, fake]
`;
    const log: string[] = [];
    const gw = new ModelGateway(loadModelsConfigYaml(yaml, {}), { today: () => 'd', log: (m) => log.push(m) });
    const a = await gw.run(job());
    expect(a?.modelId).toBe('fake');
    expect(log[0]).toBe('decide: skip chat (energy 0.8 < 0.9)');
    expect(log[1]).toBe('decide: skip big (daily AUD cap reached)');
    expect(log[2]).toMatch(/^decide: broken failed/);
  });

  it('times out slow models and falls through', async () => {
    const slow: typeof fetch = (u, i) => new Promise((r) => setTimeout(() => r(fakeOllama(u, i)), 200));
    const yaml = `${BASE_YAML}\njobs:\n  decide: [{ use: local, timeoutMs: 20 }, fake]\n`;
    const gw = new ModelGateway(loadModelsConfigYaml(yaml, {}), { fetch: slow, today: () => 'd' });
    expect((await gw.run(job()))?.modelId).toBe('fake');
  });

  it('escalates low-confidence decisions to the plan chain', async () => {
    const yaml = `${BASE_YAML.replace('escalateBelow: 0', 'escalateBelow: 0.99')}
jobs:
  decide: [fake]
  plan: [chat]
`;
    const gw = new ModelGateway(loadModelsConfigYaml(yaml, {}), { today: () => 'd' });
    const a = await gw.run(job());
    expect(a?.answer).toMatchObject({ tier: 'llm', reasons: expect.any(Object) });
    expect(a?.modelId).toBe('chat');
  });

  it('substitutes environment variables in YAML', () => {
    const cfg = loadModelsConfigYaml(`ollamaUrl: \${OLLAMA_URL:-http://localhost:11434}\nmodels: {}\njobs: {}\n`, { OLLAMA_URL: 'http://ollama:11434' });
    expect(cfg.ollamaUrl).toBe('http://ollama:11434');
  });
});

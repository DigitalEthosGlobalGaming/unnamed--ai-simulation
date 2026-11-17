import { describe, expect, it } from 'vitest';
import type { Action, Character, Delta, JobRequest, Json, SimInputEvent } from '@uas/core';
import { allowedDepth } from '../src/sleep.ts';
import { DEFAULT_MIND_CONFIG, type MindConfig } from '../src/config.ts';
import { mindWorld, registry } from './helpers.ts';

/** Iteration 2, Stage 1: battery as thinking budget, thinking tiers and sleep (decisions 42–47). */

const usage = (costAud = 0) => ({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, costAud, latencyMs: 1, modelId: 'test' });
const HOUR = 600; // ticks per in-world hour at 6 s per tick (the test world)

function setup(mind: Partial<MindConfig> = { brain: 'autopilot' }) {
  const { world, minds } = mindWorld(11, mind);
  let seq = 0;
  const input = (type: SimInputEvent['type'], payload: unknown) =>
    world.enqueue({ worldId: 'garden', seq: seq++, tick: world.tick, type, payload, packVersions: registry.packVersions } as SimInputEvent);
  const deltas: Delta[] = [];
  const jobs: JobRequest[] = [];
  const run = (n: number) => {
    for (let i = 0; i < n; i++) {
      deltas.push(...world.step().changes);
      jobs.push(...minds.drain());
    }
  };
  const robot = () => world.entity('robot') as Character;
  const decide = (...actions: Action[]) =>
    input('model.answer', { jobId: `s${seq}`, job: 'decide', characterId: 'robot', modelId: 'test', promptHash: '', usage: usage(), answer: { actions } as unknown as Json });
  const answer = (job: JobRequest, a: Record<string, Json>, costAud = 0) =>
    input('model.answer', { jobId: job.jobId, job: job.job, characterId: 'robot', modelId: 'test', promptHash: '', usage: usage(costAud), answer: a });
  run(3);
  return { world, minds, input, run, robot, decide, answer, deltas, jobs };
}

/** Put the robot to sleep where it stands (with something in short-term memory to settle). */
const sleepNow = (t: ReturnType<typeof setup>) => {
  const m = t.robot().mind!;
  if (m.stm.length === 0) {
    m.stm.push({ id: 'm1', store: 'stm', tick: t.world.tick, day: 0, kind: 'outcome', text: 'I tried push at the ball by day: the ball rolled away', about: { verb: 'push', objectType: 'ball', when: 'day' }, valence: 0.2, strength: 0.4, recalls: 0, recallDays: [], lastRecallTick: t.world.tick });
  }
  t.decide({ verb: 'rest', reason: 'sleep', args: { ticks: 100 } });
  t.run(2);
  expect(t.robot().mind!.sleep).toBe('asleep');
};

describe('battery as thinking budget', () => {
  it('physical actions never drain it: a day on autopilot never lowers the battery, and only sleep raises it', () => {
    const t = setup();
    let last = t.robot().energy;
    for (let i = 0; i < 14_400; i++) {
      const asleep = t.robot().mind!.sleep === 'asleep';
      t.run(1);
      const e = t.robot().energy;
      expect(e).toBeGreaterThanOrEqual(last);
      if (e > last) expect(asleep || t.robot().mind!.sleep === 'asleep').toBe(true);
      last = e;
    }
    expect(t.deltas.filter((d) => d.kind === 'action' && d.status === 'done').length).toBeGreaterThan(50);
  });

  it('thinking drains it: a priced answer costs costAud × energyPerAud (5: a full battery is A$0.20)', () => {
    const t = setup();
    t.robot().mind!.pendingJobs = [{ jobId: 'j1', job: 'appraise', tick: t.world.tick, deadlineTick: t.world.tick + 100, trigger: 'action-finished' }];
    const before = t.robot().energy;
    t.answer({ jobId: 'j1', job: 'appraise' } as JobRequest, { value: 0.5 }, 0.02);
    t.run(1);
    expect(before - t.robot().energy).toBeCloseTo(0.1, 6);
  });
});

describe('thinking tiers', () => {
  const cfg = { ...DEFAULT_MIND_CONFIG, brain: 'models' as const };
  it('step down with the battery: plan model, decision model, habits, autopilot only', () => {
    expect(allowedDepth(0.9, cfg, false)).toBe('think');
    expect(allowedDepth(0.45, cfg, false)).toBe('gut');
    expect(allowedDepth(0.2, cfg, false)).toBe('habit');
    expect(allowedDepth(0.02, cfg, false)).toBe('none');
    expect(allowedDepth(0.9, cfg, true)).toBe('none'); // empty until it sleeps
    expect(allowedDepth(0.5, { ...cfg, batteryGutAbove: 0.6, batteryPlanAbove: 0.8 }, false)).toBe('habit');
  });

  it('the brain follows them: low battery → no model call; medium → gut only; and records the depth in the feed', () => {
    const low = setup({ brain: 'models' });
    low.robot().energy = 0.2;
    low.robot().mind!.pendingJobs = [];
    low.jobs.length = 0;
    low.input('admin.poke', { characterId: 'robot' });
    low.run(2);
    expect(low.jobs.filter((j) => j.job === 'decide')).toEqual([]);
    const entry = low.deltas.filter((d) => d.kind === 'feed').at(-1);
    expect(entry?.kind === 'feed' && entry.entry).toMatchObject({ tier: 'autopilot', depth: 'habit', depthWhy: 'battery low: habits only' });

    const mid = setup({ brain: 'models' });
    mid.robot().energy = 0.45;
    mid.robot().mind!.pendingJobs = [];
    mid.jobs.length = 0;
    mid.input('admin.poke', { characterId: 'robot' });
    mid.run(2);
    const job = mid.jobs.find((j) => j.job === 'decide')!;
    expect(job.depth).toBe('gut'); // important (a poke) wants to think it through; the battery allows a gut call
    expect(mid.robot().mind!.pendingJobs.find((p) => p.jobId === job.jobId)).toMatchObject({ depth: 'gut', depthWhy: expect.stringContaining('battery allows a gut call') });
  });
});

describe('sleep', () => {
  it('a nap soon after waking recharges almost nothing, and it sleeps at least an hour', () => {
    const t = setup();
    const r = t.robot();
    r.energy = 0.4;
    r.mind!.awakeSinceTick = t.world.tick;
    r.mind!.unsettled = 0;
    sleepNow(t);
    t.run(Math.round(0.9 * HOUR));
    expect(r.mind!.sleep).toBe('asleep'); // the minimum hour
    t.run(Math.round(0.2 * HOUR));
    expect(r.mind!.sleep).toBe('awake'); // rested: nothing to repay
    expect(r.energy - 0.4).toBeLessThan(0.01);
  });

  it('recharges with sleep pressure, and wakes when rested', () => {
    const t = setup();
    const r = t.robot();
    r.energy = 0.3;
    r.mind!.awakeSinceTick = t.world.tick - 14 * HOUR; // a long day
    r.mind!.unsettled = 40; // and a foggy head
    t.run(1);
    expect(r.mind!.sleepPressure!).toBeGreaterThan(0.8);
    sleepNow(t);
    t.run(2 * HOUR);
    expect(r.mind!.sleep).toBe('asleep'); // still tired after two hours
    let woke = -1;
    for (let i = 0; i < 12 * HOUR && woke < 0; i++) {
      t.run(1);
      if (r.mind!.sleep !== 'asleep') woke = i;
    }
    expect(woke).toBeGreaterThan(0);
    // Rested, or full and no longer really tired.
    expect(r.mind!.sleepPressure!).toBeLessThan(0.3);
    expect(r.energy).toBeGreaterThan(0.6);
    expect(t.deltas.some((d) => d.kind === 'diary' && /^woke up \((rested|battery full)\)/.test(d.text))).toBe(true);
  });

  it('a strong event wakes it, but only after the minimum hour', () => {
    const t = setup();
    const r = t.robot();
    r.mind!.awakeSinceTick = t.world.tick - 14 * HOUR;
    r.mind!.unsettled = 40;
    sleepNow(t);
    t.run(HOUR / 2);
    t.input('admin.poke', { characterId: 'robot' });
    t.run(2);
    expect(r.mind!.sleep).toBe('asleep');
    t.run(HOUR / 2 + 10);
    t.input('admin.poke', { characterId: 'robot' });
    t.run(2);
    // It wakes (and, still very tired, may well choose to go back to sleep).
    expect(t.deltas.some((d) => d.kind === 'diary' && d.text.startsWith('woke up (woken by something)'))).toBe(true);
  });

  it('runs the pipeline in order (consolidate → habits → sheet → refine), paid from the battery', () => {
    const t = setup({ brain: 'models' });
    const r = t.robot();
    r.energy = 0.8;
    r.mind!.pendingJobs = [];
    r.mind!.outcomeDays = { 'push:ball@day': [0, 1, 2] }; // a pattern over three days → a habit
    sleepNow(t);
    const consolidate = t.jobs.find((j) => j.job === 'consolidate')!;
    expect(consolidate).toBeDefined();
    expect(t.jobs.some((j) => j.job === 'sheet')).toBe(false); // in order: the sheet waits
    const before = r.energy;
    t.answer(consolidate, { beliefs: [], openItems: [], forget: [] }, 0.004);
    t.run(1);
    expect(before - r.energy).toBeGreaterThan(0.019); // 0.004 × 5, minus a tick of recharge
    const sheet = t.jobs.find((j) => j.job === 'sheet')!;
    expect(sheet.question).toContain('Sleeping recharges me and settles my memories. [locked]');
    t.answer(sheet, { op: 'add', text: 'I like pushing the ball.', goal: 'Find out what the piano does at night.', why: 'it is fun' }, 0.002);
    t.run(1);
    const steps = t.deltas.flatMap((d) => (d.kind === 'sleepWork' ? [d.step] : [])).filter((s, i, a) => s !== a[i - 1]);
    expect(steps).toEqual(['consolidating', 'habits', 'sheet', 'refine', 'done']);
    const m = r.mind!;
    expect(m.habits!.map((h) => h.name)).toEqual(['by day I push the ball']);
    expect(m.sheet.at(-1)!.text).toBe('I like pushing the ball.');
    expect(m.goal).toBe('Find out what the piano does at night.');
    expect(m.sheetHistory!.map((e) => [e.op, e.by])).toEqual([['add', 'model'], ['goal', 'model']]);
    expect(m.stm).toEqual([]); // settled: the fog clears
  });

  it('locked lines never change, one step per sleep, and without models code makes the step', () => {
    const t = setup({ brain: 'models' });
    const r = t.robot();
    r.mind!.pendingJobs = [];
    sleepNow(t);
    t.answer(t.jobs.find((j) => j.job === 'consolidate')!, { beliefs: [], openItems: [], forget: [] });
    t.run(1);
    t.answer(t.jobs.find((j) => j.job === 'sheet')!, { op: 'remove', line: 1 });
    t.run(1);
    expect(r.mind!.sheet[0]).toMatchObject({ text: 'I am a small robot who lives in a garden.', locked: true });
    expect(r.mind!.sheetHistory!.at(-1)).toMatchObject({ op: 'none', why: 'that line is locked' });
  });
});

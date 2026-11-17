import { describe, expect, it } from 'vitest';
import type { Character, Delta, JobRequest, SleepWorkStep } from '@uas/core';
import { ModelGateway, loadModelsConfigYaml } from '../src/index.ts';
import { BASE_YAML, jobsYaml, runWithModels } from './harness.ts';

const DAY = 14_400;

/**
 * M6, iteration 2 (decisions 42–47): the battery is the thinking budget and sleep is the only
 * recharge. With fake models (priced like cheap hosted ones) the robot spends its battery
 * thinking, gets foggy, chooses to sleep, recharges, and its sheet and habits change overnight.
 */
describe('M6: thinking budget and sleep', async () => {
  const prefixes: { tick: number; prefix: string; wakes: number }[] = [];
  const steps: SleepWorkStep[][] = [];
  let drained = 0;
  let wakes = 0;
  let maxFog = 0;
  let recharge = 0;
  let lastEnergy = 0.75;
  const run = await runWithModels(jobsYaml('fake'), 3 * DAY, {}, {}, {
    after: (w, changes: Delta[]) => {
      const r = w.entity('robot') as Character;
      for (const d of changes) {
        if (d.kind === 'sleep' && d.phase === 'awake') wakes++;
        if (d.kind === 'sleep' && d.phase === 'asleep') steps.push([]);
        if (d.kind === 'sleepWork') {
          const cur = steps.at(-1)!;
          if (cur.at(-1) !== d.step) cur.push(d.step);
        }
      }
      maxFog = Math.max(maxFog, r.mind!.fog ?? 0);
      if (r.mind!.sleep === 'asleep' && r.energy > lastEnergy) recharge += r.energy - lastEnergy;
      if (r.energy < lastEnergy) drained += lastEnergy - r.energy;
      lastEnergy = r.energy;
    },
    jobs: (w, jobs: JobRequest[]) => {
      for (const j of jobs) if (j.job === 'decide') prefixes.push({ tick: w.tick, prefix: j.context.rules + j.context.sheet + j.context.beliefs, wakes });
    },
  });
  const robot = run.robot as Character;
  const m = robot.mind!;

  it('spends its battery only on thinking (the meter shows every A$)', () => {
    const charged = run.gateway.meter.report().reduce((a, r) => a + r.energy, 0);
    expect(charged).toBeGreaterThan(0.1);
    // Every bit of battery that went down was paid thinking (as the meter priced it).
    // (within 1%: a charge and a recharge can land on the same tick while asleep)
    expect(Math.abs(drained - charged)).toBeLessThan(0.01 * charged);
    // The daily cap is never exceeded.
    expect(run.gateway.meter.spentTodayAud()).toBeLessThanOrEqual(run.gateway.config.dailyCapAud);
  });

  it('gets foggy, chooses to sleep, and recharges only while asleep', () => {
    expect(maxFog).toBeGreaterThan(0.5);
    expect(wakes).toBeGreaterThan(0);
    expect(recharge).toBeGreaterThan(0.1);
    expect(run.feed.some((e) => e.actions.some((a) => a.verb === 'rest'))).toBe(true);
  });

  it('runs the sleep pipeline in order, paid from the battery', () => {
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps.slice(0, -1)) expect(s).toEqual(['consolidating', 'habits', 'sheet', 'refine', 'done']);
    const jobs = run.gateway.meter.report().map((r) => r.job);
    expect(jobs).toEqual(expect.arrayContaining(['consolidate', 'sheet']));
  });

  it('its sheet changes overnight (one step per sleep, locked core kept, history kept)', () => {
    expect(m.sheet.filter((l) => l.locked).map((l) => l.text)).toEqual(['I am a small robot who lives in a garden.', 'Sleeping recharges me and settles my memories.']);
    // One step per sleep, but naps don't rewrite it: at most one sheet step per in-world day.
    const stepsByDay = new Map<number, number>();
    for (const e of m.sheetHistory!) if (e.op !== 'goal') stepsByDay.set(e.day, (stepsByDay.get(e.day) ?? 0) + 1);
    expect(stepsByDay.size).toBeGreaterThanOrEqual(2);
    expect(Math.max(...stepsByDay.values())).toBe(1);
    expect(m.sheetHistory!.some((e) => e.op === 'add' && e.by === 'model')).toBe(true);
  });

  it('cached prefix: no byte changes outside sleep', () => {
    expect(prefixes.length).toBeGreaterThan(50);
    let changes = 0;
    for (let i = 1; i < prefixes.length; i++) {
      const [a, b] = [prefixes[i - 1]!, prefixes[i]!];
      if (a.prefix !== b.prefix) {
        changes++;
        expect(b.wakes, `prefix changed at tick ${b.tick} without a sleep in between`).toBeGreaterThan(a.wakes);
      }
    }
    expect(changes).toBeGreaterThan(0);
  });
});

describe('M6: sleep work on a low battery uses the cheaper model', () => {
  it('routes by minEnergy', async () => {
    const yaml = `${BASE_YAML}
  big: { adapter: fake-chat }
  small: { adapter: fake-chat }
jobs:
  consolidate: [{ use: big, minEnergy: 0.5 }, small]
`;
    const gw = new ModelGateway(loadModelsConfigYaml(yaml, {}), { today: () => 'd' });
    const ctx = { rules: '', sheet: '', beliefs: '', shortTerm: '', state: '', observations: '', question: '' };
    const req = (energy: number): JobRequest => ({ jobId: `r${energy}`, job: 'consolidate', characterId: 'robot', tick: 0, energy, isNight: true, context: ctx, question: 'Settle.' });
    expect((await gw.run(req(0.8)))?.modelId).toBe('big');
    expect((await gw.run(req(0.3)))?.modelId).toBe('small');
  });
});

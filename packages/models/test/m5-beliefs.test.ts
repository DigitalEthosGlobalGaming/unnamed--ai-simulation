import { describe, expect, it } from 'vitest';
import type { Character, Delta } from '@uas/core';
import type { World } from '@uas/sim';
import { buildCandidates, buildPrompt } from '@uas/mind';
import { heuristicRank } from '../src/index.ts';
import { jobsYaml, runWithModels } from './harness.ts';

const DAY = 14_400;
/** Ticks from the 08:00 start to `hour` on `day`. */
const at = (day: number, hour: number) => day * DAY + (hour - 8) * 600;
const hourOf = (w: World) => w.timeOfDay * 24;

describe('M5: memory and beliefs', async () => {
  const charges: { day: number; hour: number; night: boolean; observation: string }[] = [];
  const nightStarts: { day: number; hour: number }[] = [];
  const duskEnergy: number[] = [];
  let counterfactual: { withBelief: string; withoutBelief: string } | undefined;
  const memories: Delta[] = [];
  // A thinking budget where a full battery buys a few hundred cheap decisions a day.
  const run = await runWithModels(jobsYaml('fake').replace('energyPerAud: 2', 'energyPerAud: 0.5'), at(3, 8), {}, {}, {
    // A power glitch just before dusk on day 0 leaves the battery low going into the first night.
    before: (w) => (w.tick === at(0, 17.75) ? [{ type: 'admin.edit', payload: { id: 'robot', energy: 0.35 } }] : undefined),
    after: (w, changes) => {
      for (const d of changes) {
        if (d.kind === 'action' && d.action.verb === 'charge' && d.status === 'done') {
          charges.push({ day: Math.floor(w.tick / DAY), hour: hourOf(w), night: !w.isDaylight, observation: d.observation ?? '' });
        }
        if (d.kind === 'action' && d.action.verb === 'charge' && d.status === 'started' && !w.isDaylight) {
          nightStarts.push({ day: Math.floor(w.tick / DAY), hour: hourOf(w) });
        }
        if (d.kind === 'memory') memories.push(d);
      }
      if ((w.tick - at(0, 18)) % DAY === 0) duskEnergy.push((w.entity('robot') as Character).energy);
      if (w.tick === at(2, 16.5)) {
        // What would the decision model pick at 16:30 with, and without, the night belief in its prompt?
        const r = w.entity('robot') as Character;
        const robot = structuredClone(r);
        robot.energy = 0.6;
        const arch = w.archetype('robot')!;
        const cands = buildCandidates(w, robot, robot.mind!);
        const prompt = buildPrompt(robot, robot.mind!, arch, { isNight: false, timeWord: 'evening, dusk soon', trigger: 'action-finished', question: 'Which action next?', candidates: cands });
        const label = (id: string) => cands.find((c) => c.id === id)!.label;
        const withoutNight = { ...prompt, beliefs: prompt.beliefs.split('\n').filter((l) => !l.includes('at the solarPad at night')).join('\n') };
        counterfactual = { withBelief: label(heuristicRank(prompt, cands)[0]!.id), withoutBelief: label(heuristicRank(withoutNight, cands)[0]!.id) };
      }
    },
  });
  const robot = run.robot as Character;
  const nightOf = (c: (typeof charges)[number]) => (c.hour < 8 ? c.day - 1 : c.day);

  it('finds out on the first night that the pad does nothing in the dark', () => {
    // A charge that straddles dusk can finish just after 18:00 with the daytime result; skip the boundary.
    const night0 = charges.filter((c) => c.night && nightOf(c) === 0 && Math.abs(c.hour - 18) > 0.05);
    expect(night0.length).toBeGreaterThan(0);
    expect(night0[0]!.observation).toBe('the pad stayed dark and cold');
  });

  it('after 3 days holds a firm belief that the pad does not charge at night', () => {
    const night = robot.mind!.beliefs.find((b) => b.key === 'charge:solarPad@night')!;
    const day = robot.mind!.beliefs.find((b) => b.key === 'charge:solarPad@day')!;
    expect(night.text).toBe('charge at the solarPad at night does nothing much');
    expect(night.expectedNeedDeltas.energy ?? 0).toBeLessThanOrEqual(0.01);
    expect(day.expectedNeedDeltas.energy).toBeGreaterThan(0.05);
    expect(day.text).toContain('fills my battery');
  });

  it('changes its behaviour: no more night charging, and it charges before dusk', () => {
    // Charges started before dusk may finish just after it; none are started at night after night 0.
    expect(nightStarts.filter((c) => (c.hour < 8 ? c.day - 1 : c.day) >= 1)).toEqual([]);
    for (const day of [1, 2]) {
      const evening = charges.filter((c) => c.day === day && c.hour >= 15.5 && c.hour < 18);
      expect(evening.length, `day ${day} evening charges`).toBeGreaterThan(0);
    }
  });

  it('the night belief is what makes it charge before dusk', () => {
    expect(counterfactual!.withBelief).toMatch(/^charge the solarPad/);
    expect(counterfactual!.withoutBelief).not.toMatch(/^charge the solarPad/);
    expect(duskEnergy.slice(1).every((e) => e > 0.85)).toBe(true);
  });

  it('stores memories competitively: STM and LTM never exceed capacity or the subject ceiling', () => {
    expect(memories.length).toBeGreaterThan(20);
    const m = robot.mind!;
    expect(m.stm.length).toBeLessThanOrEqual(12);
    const keys = new Map<string, number>();
    for (const x of m.stm) {
      const k = `${x.about.verb}:${x.about.objectType}@${x.about.when}`;
      keys.set(k, (keys.get(k) ?? 0) + 1);
    }
    expect(Math.max(...keys.values())).toBeLessThanOrEqual(4);
    expect(m.ltm.length).toBeGreaterThan(0);
  });

  it('keeps a diary', () => {
    expect(robot.mind!.diaryToday.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { Character, Delta } from '@uas/core';
import { buildRegistry, type Pack } from '@uas/core';
import { basicPack } from '@uas/pack-basic';
import { doneKeys, mindWorld, TICKS_PER_DAY } from './helpers.ts';

/** The same pack with boredom switched off, as a control. */
function noBoredom() {
  const pack: Pack = structuredClone({ ...basicPack(), handlers: {}, senses: [] });
  const real = basicPack();
  pack.handlers = real.handlers;
  pack.senses = real.senses;
  pack.archetypes[0]!.mind.boredomStep = 0;
  for (const o of pack.objects) for (const v of Object.values(o.verbs)) delete v.boredomStep;
  pack.contentHash = 'control';
  return buildRegistry([pack]);
}

/** Longest run of the same activity, ignoring walking and standby. */
function longestStreak(keys: string[]): number {
  let best = 0;
  let run = 0;
  let prev = '';
  for (const k of keys.filter((k) => !k.startsWith('moveTo') && k !== 'rest:dock')) {
    run = k === prev ? run + 1 : 1;
    prev = k;
    best = Math.max(best, run);
  }
  return best;
}

function week(seed: number, registry?: ReturnType<typeof buildRegistry>, staleHours?: number) {
  const { world, minds } = mindWorld(seed, { brain: 'autopilot', ...(staleHours !== undefined && { staleHours }) }, undefined, registry);
  const keysByDay: string[][] = [];
  const dull: number[] = [];
  const tiers = new Set<string>();
  let minEnergy = 1;
  let afterDull: string[] = [];
  const switchedAfterDull: boolean[] = [];
  for (let t = 0; t < 7 * TICKS_PER_DAY; t++) {
    const { changes } = world.step();
    for (const k of doneKeys(world, changes)) {
      (keysByDay[world.day] ??= []).push(k);
      // The next activity after something got dull (not walking, and not sleeping, which is about sleep pressure).
      if (afterDull.length === 1 && !k.startsWith('moveTo') && !k.startsWith('rest:')) {
        switchedAfterDull.push(k !== afterDull[0]);
        afterDull = [];
      }
    }
    for (const d of changes as Delta[]) {
      if (d.kind === 'diary' && d.text.endsWith('is getting dull')) {
        dull.push(world.tick);
        const [verb, , , type] = d.text.split(' ');
        afterDull = [`${verb}:${type}`];
      }
      if (d.kind === 'feed') tiers.add(d.entry.tier);
    }
    minEnergy = Math.min(minEnergy, (world.entity('robot') as Character).energy);
  }
  expect(minds.outbox).toEqual([]);
  return { world, keysByDay, dull, minEnergy, tiers, switchedAfterDull };
}

describe('M3: a week on autopilot', () => {
  const run = week(7);
  // Boredom on its own (no "nothing new" penalty), against the same with boredom switched off.
  const bored = week(7, undefined, 0);
  const control = week(7, noBoredom(), 0);

  it('survives the week: on autopilot it never thinks, so the battery never drops', () => {
    expect(run.minEnergy).toBeGreaterThan(0.2);
    expect(run.tiers).toEqual(new Set(['autopilot']));
  });

  it('keeps several activities going every day', () => {
    for (let day = 0; day < 7; day++) {
      const distinct = new Set(run.keysByDay[day]!.filter((k) => !k.startsWith('moveTo') && k !== 'rest:dock'));
      expect(distinct.size, `day ${day}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('boredom steers it: after something gets dull it is repeated far less than without boredom', () => {
    expect(bored.dull.length).toBeGreaterThan(20);
    const repeatAfterDull = bored.switchedAfterDull.filter((x) => !x).length / bored.switchedAfterDull.length;
    const keys = control.keysByDay.flat().filter((k) => !k.startsWith('moveTo') && k !== 'rest:dock');
    const repeatControl = keys.slice(1).filter((k, i) => k === keys[i]).length / (keys.length - 1);
    console.log(`dull ${bored.dull.length}x; repeated right after dull ${(repeatAfterDull * 100).toFixed(0)}%, control repeat rate ${(repeatControl * 100).toFixed(0)}%`);
    // Iteration 2: sleeping (driven by sleep pressure, not boredom) now breaks up the day for both
    // runs, so the gap is smaller than in iteration 1 (where it was more than 20%).
    expect(repeatAfterDull).toBeLessThan(repeatControl * 0.9);
  });

  it('boredom is what breaks up long streaks (compared with boredom switched off)', () => {
    const withB = longestStreak(bored.keysByDay.flat());
    const without = longestStreak(control.keysByDay.flat());
    console.log(`longest streak with boredom ${withB}, without ${without}`);
    expect(withB * 2).toBeLessThanOrEqual(without);
  });

  it('learns beliefs from experience, by day and by night', () => {
    const robot = run.world.entity('robot') as Character;
    const keys = robot.mind!.beliefs.map((b) => b.key);
    expect(keys.some((k) => k.endsWith('@day'))).toBe(true);
    // Rinsing cools it down (the solar pad charges nothing since iteration 2); it mostly sleeps at night now.
    expect(robot.mind!.beliefs.find((b) => b.key === 'rinse:fountain@day')?.expectedNeedDeltas.cool ?? 0).toBeGreaterThan(0.02);
    expect(robot.mind!.beliefs.every((b) => (b.expectedNeedDeltas.energy ?? 0) === 0)).toBe(true);
  });

  it('is deterministic with the mind attached', () => {
    const a = mindWorld(3).world;
    const b = mindWorld(3).world;
    for (let t = 0; t < TICKS_PER_DAY / 2; t++) {
      a.step();
      b.step();
    }
    expect(a.hash()).toBe(b.hash());
  });
});

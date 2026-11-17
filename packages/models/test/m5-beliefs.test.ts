import { describe, expect, it } from 'vitest';
import type { Character, Delta } from '@uas/core';
import { jobsYaml, runWithModels } from './harness.ts';

const DAY = 14_400;
/** Ticks from the 08:00 start to `hour` on `day`. */
const at = (day: number, hour: number) => day * DAY + (hour - 8) * 600;

/**
 * M5 (memory and beliefs), updated for iteration 2: the solar-pad twist is gone (the pad charges
 * nothing since decision 42), so this checks that the robot learns what things do to its body.
 */
describe('M5: memory and beliefs', async () => {
  const memories: Delta[] = [];
  let diary = 0;
  const run = await runWithModels(jobsYaml('fake'), at(3, 8), {}, {}, {
    after: (_w, changes) => {
      for (const d of changes) {
        if (d.kind === 'memory') memories.push(d);
        if (d.kind === 'diary') diary++;
      }
    },
  });
  const robot = run.robot as Character;

  it('learns what things do to its body (cool, signal, curiosity), never to its battery', () => {
    const m = robot.mind!;
    expect(m.beliefs.length).toBeGreaterThan(3);
    const felt = m.beliefs.flatMap((b) => Object.entries(b.expectedNeedDeltas).filter(([, v]) => Math.abs(v) >= 0.02).map(([k]) => k));
    expect(new Set(felt).size).toBeGreaterThanOrEqual(2);
    expect(m.beliefs.every((b) => (b.expectedNeedDeltas.energy ?? 0) === 0)).toBe(true);
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
    expect(keys.size === 0 || Math.max(...keys.values()) <= 4).toBe(true);
    expect(m.ltm.length).toBeGreaterThan(0);
  });

  it('keeps a diary', () => {
    expect(diary).toBeGreaterThan(10);
  });
});

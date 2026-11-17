import { describe, expect, it } from 'vitest';
import type { Character, Delta, JobRequest } from '@uas/core';
import { ModelGateway, loadModelsConfigYaml } from '../src/index.ts';
import { BASE_YAML, jobsYaml, runWithModels } from './harness.ts';

const DAY = 14_400;
const at = (day: number, hour: number) => day * DAY + (hour - 8) * 600;

describe('M6: sleep (standby at the dock)', async () => {
  const prefixes: { tick: number; prefix: string; wakes: number }[] = [];
  const ltm: Delta[] = [];
  const sheetHistory: { day: number; lines: string[] }[] = [];
  let wakes = 0;
  let removedType: string | undefined;
  let trickle = 0;
  const run = await runWithModels(jobsYaml('fake').replace('energyPerAud: 2', 'energyPerAud: 0.5'), at(8, 8), {}, {}, {
    before: (w) => {
      // Once a self-noticed habit is on the sheet, take its object away so the habit can fade.
      const r = w.entity('robot') as Character | undefined;
      const active = r?.mind!.sheet.find((l) => l.source === 'self' && (l.seenDays?.length ?? 0) >= 2);
      if (active && !removedType) {
        removedType = /at the (\w+)\./.exec(active.text)![1]!;
        return w.entities().filter((e) => e.type === removedType).map((e) => ({ type: 'admin.despawn' as const, payload: { id: e.id } }));
      }
      return undefined;
    },
    after: (w, changes) => {
      for (const d of changes) {
        if (d.kind === 'sleep' && d.phase === 'awake') wakes++;
        if (d.kind === 'memory' && d.memory.store === 'ltm') ltm.push(d);
        if (d.kind === 'needs' && d.id === 'robot' && d.values.energy !== undefined) {
          const r = w.entity('robot') as Character;
          if (r.mind!.sleep === 'asleep' && r.current?.action.targetId === 'dock') trickle++;
        }
      }
      if (w.tick % DAY === 0) {
        const r = w.entity('robot') as Character;
        sheetHistory.push({ day: w.tick / DAY, lines: r.mind!.sheet.filter((l) => l.source === 'self' && (l.seenDays?.length ?? 0) >= 2).map((l) => l.text) });
      }
    },
    jobs: (w, jobs: JobRequest[]) => {
      for (const j of jobs) prefixes.push({ tick: w.tick, prefix: j.context.rules + j.context.sheet + j.context.beliefs, wakes });
    },
  });

  it('goes into standby at the dock at night and trickle-charges there', () => {
    expect(trickle).toBeGreaterThan(10);
  });

  it('consolidates memories into LTM overnight', () => {
    expect(ltm.length).toBeGreaterThan(0);
    // Consolidation only happens while asleep, i.e. at night.
    expect((run.robot as Character).mind!.ltm.length).toBeGreaterThan(0);
  });

  it('cached prefix: no byte changes outside sleep', () => {
    expect(prefixes.length).toBeGreaterThan(100);
    let changes = 0;
    for (let i = 1; i < prefixes.length; i++) {
      const [a, b] = [prefixes[i - 1]!, prefixes[i]!];
      if (a.prefix !== b.prefix) {
        changes++;
        expect(b.wakes, `prefix changed at tick ${b.tick} without a sleep in between`).toBeGreaterThan(a.wakes);
      }
    }
    expect(changes).toBeGreaterThan(0); // it does change across nights as beliefs grow
  });

  it('a self-added sheet line appears and later fades', () => {
    expect(removedType).toBeDefined();
    const appeared = sheetHistory.findIndex((h) => h.lines.length > 0);
    expect(appeared).toBeGreaterThan(0);
    const line = sheetHistory[appeared]!.lines[0]!;
    const gone = sheetHistory.findIndex((h, i) => i > appeared && !h.lines.includes(line) && !(run.robot as Character).mind!.sheet.some((l) => l.text === line));
    expect(gone, `"${line}" should fade after the ${removedType} is gone`).toBeGreaterThan(appeared);
  });
});

describe('M6: reflection on a low battery uses the cheaper model', () => {
  it('routes reflect by minEnergy', async () => {
    const yaml = `${BASE_YAML}
  big: { adapter: fake-chat }
  small: { adapter: fake-chat }
jobs:
  reflect: [{ use: big, minEnergy: 0.5 }, small]
`;
    const gw = new ModelGateway(loadModelsConfigYaml(yaml, {}), { today: () => 'd' });
    const ctx = { rules: '', sheet: '', beliefs: '', shortTerm: '', state: '', observations: '', question: '' };
    const req = (energy: number): JobRequest => ({ jobId: `r${energy}`, job: 'reflect', characterId: 'robot', tick: 0, energy, isNight: true, context: ctx, question: 'Reflect.' });
    expect((await gw.run(req(0.8)))?.modelId).toBe('big');
    expect((await gw.run(req(0.3)))?.modelId).toBe('small');
  });
});

/**
 * Records a fixed prompt set from the garden world for the model bake-off:
 *   npm run bakeoff -- record
 * Runs several seeded garden worlds offline (fake models) and keeps real `decide`, `reflect`
 * and outcome prompts, plus the facts needed to sanity-check answers. Writes
 * docs/benchmarks/prompts/{decide,reflect,tags}.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRegistry, type Character, type JobRequest, type Json } from '@uas/core';
import { MindSystem, buildCandidates, score } from '@uas/mind';
import { basicPack, gardenGrid } from '@uas/pack-basic';
import { World } from '@uas/sim';
import { ModelGateway, ModelHost, parseModelsConfig } from '@uas/models';

export interface DecideFacts {
  battery: number;
  hour: number;
  isNight: boolean;
  holdingBall: boolean;
  /** Candidate id → 'verb:type' */
  keys: Record<string, string>;
  /** Autopilot's ranking (code utility from beliefs and needs): the reference. */
  reference: string[];
  /** Beliefs say charging at the pad does nothing at night. */
  knowsNightCharge: boolean;
}
export interface RecordedPrompt {
  id: string;
  job: JobRequest;
  facts?: DecideFacts;
}

const DAY = 14_400;
const SEEDS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const WANT = { decide: 50, reflect: 30, tags: 40 };

const registry = buildRegistry([basicPack()]);
const config = parseModelsConfig({
  escalateBelow: 0,
  models: { fake: { adapter: 'fake-decision' }, chat: { adapter: 'fake-chat' } },
  jobs: { decide: ['fake'], vocalize: ['fake'], appraise: ['fake'], scoreMemory: ['fake'], reflect: ['chat'] },
});

function facts(world: World, c: Character, req: JobRequest): DecideFacts {
  const m = c.mind!;
  const arch = world.archetype(c.type)!;
  const isNight = !world.isDaylight;
  const cands = buildCandidates(world, c, m);
  const h = world.timeOfDay * 24;
  const ranked = score(c, m, arch, cands, isNight, world.isDaylight ? 18 - h : Infinity).sort((a, b) => b.value - a.value);
  const keyOf = Object.fromEntries((req.options ?? []).map((o) => [o.id, cands.find((x) => x.id === o.id)?.key ?? '']));
  return {
    battery: Math.round(c.energy * 100) / 100,
    hour: Math.round(h * 10) / 10,
    isNight,
    holdingBall: world.entities().some((e) => e.type === 'ball' && e.heldBy === c.id),
    keys: keyOf,
    reference: ranked.map((r) => r.candidate.id),
    knowsNightCharge: m.beliefs.some((b) => b.key === 'charge:solarPad@night' && (b.expectedNeedDeltas.energy ?? 0) <= 0.01),
  };
}

export async function record(outDir: string): Promise<void> {
  const pools: { decide: RecordedPrompt[]; reflect: RecordedPrompt[]; tags: RecordedPrompt[] } = { decide: [], reflect: [], tags: [] };
  for (const seed of SEEDS) {
    const minds = new MindSystem();
    const world = World.create({ worldId: `bake-${seed}`, seed, grid: gardenGrid() }, registry, [
      { id: 'robot', type: 'robot', pos: { x: 10, y: 10 } },
      { id: 'pad', type: 'solarPad', pos: { x: 8, y: 8 } },
      { id: 'dock', type: 'dock', pos: { x: 2, y: 7 } },
      { id: 'ball', type: 'ball', pos: { x: 12, y: 12 } },
      { id: 'fountain', type: 'fountain', pos: { x: 14, y: 6 } },
      { id: 'piano', type: 'piano', pos: { x: 3, y: 3 } },
    ], minds, { mind: { brain: 'models', appraiseOutcomes: true, energyPerAud: 0.5 } as Json });
    const host = new ModelHost(new ModelGateway(config, { today: () => 'rec' }));
    let seq = 0;
    for (let t = 0; t < 4 * DAY; t++) {
      for (const p of host.flush()) world.enqueue({ worldId: world.state.config.worldId, seq: seq++, tick: world.tick, type: 'model.answer', payload: p, packVersions: registry.packVersions });
      // Low-battery evenings and nights make the charging decisions worth testing.
      // (world starts at 08:00; these are 15:40, 16:40, 17:20, 19:00 and 22:00)
      if ([7.67, 8.67, 9.33, 11, 14].some((h) => t % DAY === Math.round((h * DAY) / 24) + (seed % 3) * 20)) {
        world.enqueue({ worldId: world.state.config.worldId, seq: seq++, tick: world.tick, type: 'admin.edit', payload: { id: 'robot', energy: 0.3 }, packVersions: registry.packVersions });
      }
      world.step();
      const jobs = minds.drain();
      const robot = world.entity('robot') as Character;
      for (const j of jobs) {
        const id = `${seed}-${j.tick}-${j.job}`;
        if (j.job === 'decide') pools.decide.push({ id, job: j, facts: facts(world, robot, j) });
        if (j.job === 'reflect') pools.reflect.push({ id, job: j });
        if (j.job === 'appraise') pools.tags.push({ id, job: j }); // the outcome text is in the question
      }
      host.dispatch(jobs);
      await host.idle();
    }
  }
  mkdirSync(outDir, { recursive: true });
  const spread = <T>(all: T[], n: number) => {
    const step = Math.max(1, all.length / n);
    return Array.from({ length: Math.min(n, all.length) }, (_, i) => all[Math.floor(i * step)]!);
  };
  for (const [kind, all] of Object.entries(pools)) {
    const want = WANT[kind as keyof typeof WANT];
    let sample: RecordedPrompt[];
    if (kind === 'decide') {
      // Make sure the sanity-check situations are represented, then spread the rest over the pool.
      const has = (p: RecordedPrompt, k: string) => Object.values(p.facts!.keys).includes(k);
      const special = [
        all.filter((p) => p.facts!.holdingBall && has(p, 'pickup:ball')),
        all.filter((p) => !p.facts!.isNight && p.facts!.hour >= 15.5 && p.facts!.hour < 18 && p.facts!.battery < 0.45 && has(p, 'charge:solarPad')),
        all.filter((p) => p.facts!.isNight && p.facts!.knowsNightCharge && has(p, 'charge:solarPad')),
      ];
      console.log(`decide pool: holding ${special[0]!.length}, low at dusk ${special[1]!.length}, night with belief ${special[2]!.length}`);
      sample = [...new Set(special.flatMap((s) => spread(s, 8)))];
      const rest = all.filter((p) => !sample.includes(p));
      sample = [...sample, ...spread(rest, want - sample.length)].sort((a, b) => (a.id < b.id ? -1 : 1));
    } else sample = spread(all, want); // spread over all seeds and times of day
    writeFileSync(join(outDir, `${kind}.json`), `${JSON.stringify(sample, null, 1)}\n`);
    console.log(`${kind}: kept ${sample.length} of ${all.length}`);
  }
}

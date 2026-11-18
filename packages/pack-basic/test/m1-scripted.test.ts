import { describe, expect, it } from 'vitest';
import { buildRegistry, type Action, type Delta, type SimInputEvent } from '@uas/core';
import { ScriptedBrain, World } from '@uas/sim';
import { basicPack, gardenGrid } from '../src/index.ts';

const act = (verb: string, targetId?: string, args?: Action['args']): Action => ({
  verb,
  reason: `scripted ${verb}`,
  ...(targetId && { targetId }),
  ...(args && { args }),
});

/** Every object verb in the pack, plus a rejection and every built-in. */
const PLANS: Action[][] = [
  [act('water', 'plant')], // rejected: out of range
  // The gardening loop (iteration 2): fill the can at the fountain, water the plant, plant a seed.
  [act('moveTo', 'can'), act('pickup', 'can'), act('moveTo', 'fountain')],
  [act('fill', 'fountain'), act('moveTo', 'plant'), act('water', 'plant')],
  [act('drop', 'can'), act('moveTo', 'seed'), act('pickup', 'seed')],
  [act('moveTo', 'bed'), act('plant', 'bed'), act('scan', 'mast')],
  [act('moveTo', 'ball'), act('pickup', 'ball'), act('moveTo', undefined, { x: 14, y: 13 })],
  [act('drop', 'ball'), act('push', 'ball'), act('chase', 'ball')],
  [act('moveTo', 'fountain'), act('rinse', 'fountain'), act('splash', 'fountain')],
  [act('scan', 'fountain'), act('vocalize', undefined, { notes: ['beep-C', 'chirp-E', 'buzz-C'] }), act('wait', undefined, { ticks: 5 })],
  [act('vocalize', undefined, { notes: ['honk-C'] })], // rejected: not in the noise set
  [act('moveTo', 'piano'), act('play', 'piano'), act('press', 'piano')],
  [act('scan', 'piano'), act('moveTo', 'dock'), act('dock', 'dock')],
  [act('rest', 'dock'), act('rest', undefined, { ticks: 20 }), act('follow', 'ball', { ticks: 30 })],
];

function run(seed: number) {
  const registry = buildRegistry([basicPack()]);
  const world = World.create({ worldId: 'm1', seed, grid: gardenGrid() }, registry, [
    { id: 'robot', type: 'robot', pos: { x: 10, y: 10 } },
    { id: 'dock', type: 'dock', pos: { x: 2, y: 7 } },
    { id: 'bed', type: 'garden-bed', pos: { x: 5, y: 11 } },
    { id: 'plant', type: 'plant', pos: { x: 6, y: 11 } },
    { id: 'seed', type: 'seed', pos: { x: 9, y: 12 } },
    { id: 'can', type: 'watering-can', pos: { x: 13, y: 8 } },
    { id: 'mast', type: 'antenna-mast', pos: { x: 8, y: 14 } },
    { id: 'ball', type: 'ball', pos: { x: 12, y: 12 } },
    { id: 'fountain', type: 'fountain', pos: { x: 19, y: 6 } },
    { id: 'piano', type: 'piano', pos: { x: 3, y: 3 } }, // inside the hut: the path goes through the door
  ]);
  let seq = 0;
  const brain = new ScriptedBrain('robot', PLANS, (e: SimInputEvent) => world.enqueue(e));
  const deltas: Delta[] = [];
  const hashes: string[] = [];
  const water: { can: number; plant: number }[] = [];
  while (world.tick < 5_000) {
    if (brain.think(world, seq)) seq++;
    const { changes } = world.step();
    deltas.push(...changes);
    for (const d of changes) {
      if (d.kind === 'action' && (d.action.verb === 'fill' || d.action.verb === 'water') && d.status === 'done') {
        water.push({ can: Number(world.entity('can')!.state.water), plant: Number(world.entity('plant')!.state.water) });
      }
    }
    if (world.tick % 100 === 0) hashes.push(world.hash());
    const robot = world.entity('robot');
    if (brain.finished && robot?.kind === 'character' && !robot.current && robot.queue.length === 0) break;
  }
  return { world, deltas, hashes, water, hash: world.hash() };
}

describe('M1: scripted robot in the garden', () => {
  const a = run(1234);

  it('runs every verb on the garden objects', () => {
    const done = new Set(
      a.deltas.flatMap((d) => {
        if (d.kind !== 'action' || d.status !== 'done' || !d.action.targetId) return [];
        return [`${a.world.state.entities[d.action.targetId]?.type ?? d.action.targetId}.${d.action.verb}`];
      }),
    );
    for (const v of [
      'watering-can.pickup', 'watering-can.drop', 'fountain.fill', 'plant.water', 'seed.pickup', 'garden-bed.plant', 'antenna-mast.scan',
      'dock.dock', 'dock.rest',
      'ball.pickup', 'ball.drop', 'ball.push', 'ball.chase',
      'fountain.rinse', 'fountain.splash', 'fountain.scan',
      'piano.play', 'piano.press', 'piano.scan',
    ]) expect(done, v).toContain(v);
    const failed = a.deltas.filter((d) => d.kind === 'action' && d.status === 'failed');
    expect(failed).toEqual([]);
  });

  it('moves the character along paths and runs the built-ins', () => {
    expect(a.deltas.filter((d) => d.kind === 'moved' && d.id === 'robot').length).toBeGreaterThan(20);
    const doneVerbs = new Set(a.deltas.flatMap((d) => (d.kind === 'action' && d.status === 'done' ? [d.action.verb] : [])));
    for (const v of ['moveTo', 'vocalize', 'wait', 'rest', 'follow']) expect(doneVerbs, v).toContain(v);
    expect(a.deltas).toContainEqual({ kind: 'vocalize', id: 'robot', pos: expect.anything(), notes: ['beep-C', 'chirp-E', 'buzz-C'] });
  });

  it('feeds rejections back as events', () => {
    const rejected = a.deltas.filter((d) => d.kind === 'action' && d.status === 'rejected');
    expect(rejected.map((d) => d.kind === 'action' && d.reason)).toEqual(['out of range', 'unknown note "honk-C"']);
  });

  it('fills the can, waters the plant and plants a seed (schema-2 blocks); the battery never moves', () => {
    expect(a.water[0]!.can).toBe(1); // fill sets it full
    expect(a.water[1]!.can).toBe(0.75); // watering takes a quarter
    expect(a.water[1]!.plant).toBeGreaterThan(a.water[0]!.plant); // and the soil gets wetter
    const planted = a.world.entities().filter((e) => e.type === 'plant' && e.id !== 'plant');
    expect(planted).toHaveLength(1);
    expect(planted[0]).toMatchObject({ pos: { x: 5, y: 11 }, createdBy: { entityId: 'robot' } });
    expect(a.world.entity('seed')).toBeUndefined(); // used up
    expect((a.world.entity('robot') as { energy: number }).energy).toBe(0.75);
  });

  it('produces identical state hashes across two runs', () => {
    const b = run(1234);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.hash).toBe(a.hash);
    expect(run(99).hash).not.toBe(a.hash);
  });
});

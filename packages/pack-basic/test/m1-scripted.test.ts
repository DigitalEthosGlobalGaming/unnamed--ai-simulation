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
  [act('charge', 'pad')], // rejected: out of range
  [act('moveTo', 'pad'), act('charge', 'pad'), act('scan', 'pad')],
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
    { id: 'pad', type: 'solarPad', pos: { x: 8, y: 8 } },
    { id: 'dock', type: 'dock', pos: { x: 2, y: 7 } },
    { id: 'ball', type: 'ball', pos: { x: 12, y: 12 } },
    { id: 'fountain', type: 'fountain', pos: { x: 19, y: 6 } },
    { id: 'piano', type: 'piano', pos: { x: 3, y: 3 } }, // inside the hut: the path goes through the door
  ]);
  let seq = 0;
  const brain = new ScriptedBrain('robot', PLANS, (e: SimInputEvent) => world.enqueue(e));
  const deltas: Delta[] = [];
  const hashes: string[] = [];
  const energyAfterCharge: number[] = [];
  while (world.tick < 5_000) {
    if (brain.think(world, seq)) seq++;
    const { changes } = world.step();
    deltas.push(...changes);
    for (const d of changes) {
      if (d.kind === 'action' && d.action.verb === 'charge' && d.status === 'done') {
        energyAfterCharge.push((world.entity('robot') as { energy: number }).energy);
      }
    }
    if (world.tick % 100 === 0) hashes.push(world.hash());
    const robot = world.entity('robot');
    if (brain.finished && robot?.kind === 'character' && !robot.current && robot.queue.length === 0) break;
  }
  return { world, deltas, hashes, energyAfterCharge, hash: world.hash() };
}

describe('M1: scripted robot in the garden', () => {
  const a = run(1234);

  it('runs every verb on all five objects', () => {
    const done = new Set(
      a.deltas.flatMap((d) => {
        if (d.kind !== 'action' || d.status !== 'done' || !d.action.targetId) return [];
        return [`${a.world.state.entities[d.action.targetId]?.type ?? d.action.targetId}.${d.action.verb}`];
      }),
    );
    for (const v of [
      'solarPad.charge', 'solarPad.scan',
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

  it('the solar pad charges nothing any more: physical actions leave the battery alone (iteration 2)', () => {
    expect(a.energyAfterCharge[0]).toBeCloseTo(0.75);
  });

  it('produces identical state hashes across two runs', () => {
    const b = run(1234);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.hash).toBe(a.hash);
    expect(run(99).hash).not.toBe(a.hash);
  });
});

import { describe, expect, it } from 'vitest';
import { buildRegistry, type Action, type Character, type Delta, type SimInputEvent, type WorldObject } from '@uas/core';
import { World, type WorldState } from '@uas/sim';
import { basicPack, garden2Grid } from '../src/index.ts';

/** Iteration 2, Stage 2: schema-2 objects in the new garden (docs/architecture/objects.md). */

const registry = buildRegistry([basicPack()]);
const HOUR = 60; // ticks per in-world hour at 60 s per tick

function setup(extra: { id: string; type: string; pos: { x: number; y: number }; state?: Record<string, number> }[] = []) {
  const world = World.create({ worldId: 'g2', seed: 7, grid: garden2Grid(), secondsPerTick: 60, startSecond: 8 * 3600 }, registry, [
    { id: 'robot', type: 'robot', pos: { x: 10, y: 10 } },
    { id: 'bed', type: 'garden-bed', pos: { x: 5, y: 11 } },
    { id: 'plant', type: 'plant', pos: { x: 6, y: 11 } },
    { id: 'fountain', type: 'fountain', pos: { x: 14, y: 6 } },
    { id: 'can', type: 'watering-can', pos: { x: 13, y: 8 } },
    ...extra,
  ]);
  let seq = 0;
  const input = (type: SimInputEvent['type'], payload: unknown) => world.enqueue({ worldId: 'g2', seq: seq++, tick: world.tick, type, payload, packVersions: registry.packVersions } as SimInputEvent);
  const deltas: Delta[] = [];
  const run = (n: number) => {
    for (let i = 0; i < n; i++) deltas.push(...world.step().changes);
  };
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 't' };
  const decide = (...actions: Action[]) => input('model.answer', { jobId: `j${seq}`, job: 'decide', characterId: 'robot', modelId: 't', promptHash: '', usage, answer: { actions } });
  const obj = (id: string) => world.entity(id) as WorldObject;
  const done = (verb: string) => deltas.filter((d): d is Extract<Delta, { kind: 'action' }> => d.kind === 'action' && d.action.verb === verb && (d.status === 'done' || d.status === 'failed' || d.status === 'rejected'));
  return { world, input, run, decide, obj, deltas, done };
}
const act = (verb: string, targetId?: string): Action => ({ verb, reason: 'test', ...(targetId && { targetId }) });

describe('schema-2 objects in the sim', () => {
  it('rules run on the in-world clock: water drains, growth needs water, the appearance follows', () => {
    const t = setup();
    expect(t.obj('plant').appearance).toEqual(['a bare patch of soil', 'the soil is damp']);
    t.run(10 * HOUR + 1); // rules start counting at the first tick: 10 hour marks
    const p = t.obj('plant');
    expect(p.state.water).toBeCloseTo(0.6 - 10 * 0.025, 6);
    expect(p.state.growth).toBeCloseTo(10 * 0.015, 6); // water stayed ≥ 0.3
    expect(p.appearance).toEqual(['a small green shoot', 'the soil looks dry']);
    expect(t.deltas.some((d) => d.kind === 'objectView' && d.id === 'plant')).toBe(true);
    t.run(15 * HOUR); // the soil is now below 0.05: wilting has begun
    expect(Number(t.obj('plant').state.water)).toBeLessThan(0.05);
    const g = Number(t.obj('plant').state.growth);
    expect(g).toBeGreaterThan(0.05);
    t.run(5 * HOUR);
    expect(Number(t.obj('plant').state.growth)).toBeLessThan(g); // dry: it wilts
    expect(t.obj('plant').appearance).toContain('the soil is cracked and dry');
  });

  it('a verb is requirements then effects, all or nothing: fill needs a can, water needs water in it', () => {
    const t = setup();
    t.decide(act('moveTo', 'fountain'), act('fill', 'fountain'));
    t.run(60);
    expect(t.done('fill')[0]).toMatchObject({ status: 'failed', reason: 'you need to be holding a watering can to fill it', observation: 'you need to be holding a watering can to fill it' });
    t.decide(act('moveTo', 'can'), act('pickup', 'can'), act('moveTo', 'plant'));
    t.run(200);
    t.decide(act('water', 'plant'));
    t.run(20);
    expect(t.done('water')[0]).toMatchObject({ status: 'failed', reason: 'you need a watering can with water in it' });
    expect(t.obj('can').state.water).toBe(0); // untouched
    t.decide(act('moveTo', 'fountain'), act('fill', 'fountain'), act('moveTo', 'plant'));
    t.run(200);
    expect(t.obj('can').state.water).toBe(1);
    const before = Number(t.obj('plant').state.water);
    t.decide(act('water', 'plant'));
    t.run(20);
    expect(t.obj('can').state.water).toBe(0.75);
    expect(Number(t.obj('plant').state.water)).toBeGreaterThan(before + 0.3);
    expect(t.obj('can').appearance).toEqual(['a watering can with some water']);
  });

  it('products fill on a timer while their condition holds; harvest puts one in the hands; reset applies', () => {
    const t = setup();
    // A seedling isn't filling anything: no countdown until the slot's `when` holds.
    t.run(HOUR + 1);
    expect(t.obj('plant').products!.map((p) => p.nextInHours)).toEqual([undefined, undefined]);
    t.world.state.entities.plant!.state.growth = 1;
    t.world.state.entities.plant!.state.water = 1;
    t.run(23 * HOUR);
    expect(t.obj('plant').products!.map((p) => [p.slot, p.ready])).toEqual([['flower', 0], ['seeds', 0]]);
    t.run(2 * HOUR);
    expect(t.obj('plant').products!.map((p) => [p.slot, p.ready])).toEqual([['flower', 1], ['seeds', 1]]);
    expect(t.deltas.some((d) => d.kind === 'objectView' && d.id === 'plant' && d.products[0]!.ready === 1)).toBe(true);
    t.decide(act('moveTo', 'plant'), act('pick', 'plant'));
    t.run(30);
    const flower = t.world.entities().find((e) => e.type === 'flower')!;
    expect(flower.heldBy).toBe('robot');
    expect(t.obj('plant').products![0]!.ready).toBe(0);
    t.decide(act('gather', 'plant'));
    t.run(10);
    expect(t.done('gather')[0]).toMatchObject({ status: 'failed', reason: 'your grippers are full' });
    t.decide(act('drop', flower.id), act('gather', 'plant'));
    t.run(10);
    expect(t.world.entities().find((e) => e.type === 'seed')?.heldBy).toBe('robot');
    expect(t.obj('plant').state.growth).toBe(0.6); // reset after gathering seeds
  });

  it('planting: a held seed becomes a plant on the nearest free tile of the bed; a full bed has no room', () => {
    const t = setup([
      { id: 's1', type: 'seed', pos: { x: 9, y: 12 } },
      { id: 'p2', type: 'plant', pos: { x: 5, y: 11 } },
      { id: 'p3', type: 'plant', pos: { x: 7, y: 11 } },
      { id: 'p4', type: 'plant', pos: { x: 5, y: 12 } },
      { id: 'p5', type: 'plant', pos: { x: 6, y: 12 } },
    ]);
    t.decide(act('moveTo', 's1'), act('pickup', 's1'), act('moveTo', 'bed'));
    t.run(60);
    t.decide(act('plant', 'bed'));
    t.run(20);
    const planted = t.world.entities().find((e) => e.type === 'plant' && (e as WorldObject).createdBy)!;
    expect(planted).toMatchObject({ pos: { x: 7, y: 12 }, createdBy: { entityId: 'robot' } });
    expect(t.world.entity('s1')).toBeUndefined();
    // Now full: another seed has nowhere to go, and nothing changes.
    t.input('admin.spawn', { id: 's2', type: 'seed', pos: { ...(t.world.entity('robot') as Character).pos } });
    t.run(1);
    t.decide(act('pickup', 's2'), act('plant', 'bed'));
    t.run(30);
    expect(t.done('plant').at(-1)).toMatchObject({ status: 'failed', reason: 'no room' });
    expect(t.world.entity('s2')?.heldBy).toBe('robot');
  });

  it('the antenna mast lifts signal nearby, scaled by time in range; a picked flower wilts and goes', () => {
    const t = setup([{ id: 'mast', type: 'antenna-mast', pos: { x: 11, y: 10 } }, { id: 'f', type: 'flower', pos: { x: 3, y: 3 } }]);
    const r = t.world.entity('robot') as Character;
    r.needs.signal = 0.2;
    t.run(HOUR);
    expect(r.needs.signal).toBeCloseTo(0.4, 2); // +0.2 per hour in range
    expect(t.obj('f').appearance).toEqual(['a fresh flower']);
    t.run(48 * HOUR);
    expect(t.world.entity('f')).toBeUndefined();
  });

  it('a clock jump catches up period by period, capped at 7 in-world days', () => {
    const t = setup();
    t.run(2);
    const now = t.world.seconds;
    // An anchor at "now", then a jump 30 days later.
    t.input('clock.anchor', { epochMs: now * 1000, tzOffsetMinutes: 0, timezone: 'UTC' });
    t.run(1);
    t.input('clock.jump', { epochMs: (now + 30 * 86_400) * 1000, tzOffsetMinutes: 0, timezone: 'UTC', reason: 'restart' });
    t.run(1);
    const c = t.deltas.find((d) => d.kind === 'catchUp');
    expect(c).toMatchObject({ periods: 7 * 24, capped: true });
    expect(t.obj('plant').state.water).toBe(0);
  });
});

describe('replay determinism with a growing plant, across a fork', () => {
  it('a fork from a snapshot and the original stay identical with the same inputs', () => {
    const a = setup();
    a.decide(act('moveTo', 'can'), act('pickup', 'can'), act('moveTo', 'fountain'));
    a.run(5 * HOUR);
    const snap = structuredClone(a.world.snapshot()) as WorldState;
    const b = World.fromSnapshot(snap, registry);
    const inputs: SimInputEvent[] = [];
    let seq = 1000;
    const both = (type: SimInputEvent['type'], payload: unknown) => {
      for (const w of [a.world, b]) w.enqueue({ worldId: 'g2', seq, tick: w.tick, type, payload, packVersions: registry.packVersions } as SimInputEvent);
      inputs.push({ type } as SimInputEvent);
      seq++;
    };
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 't' };
    both('model.answer', { jobId: 'x', job: 'decide', characterId: 'robot', modelId: 't', promptHash: '', usage, answer: { actions: [act('fill', 'fountain'), act('moveTo', 'plant'), act('water', 'plant')] } });
    for (let i = 0; i < 40 * HOUR; i++) {
      a.world.step();
      b.step();
      if (i % 200 === 0) expect(b.hash()).toBe(a.world.hash());
    }
    expect(b.hash()).toBe(a.world.hash());
    expect(Number((b.entity('plant') as WorldObject).state.growth)).toBeGreaterThan(0.3);
  });
});

import { describe, expect, it } from 'vitest';
import type { Action, Character, Delta, EntityDef, FeedEntry, Json, Memory, SimInputEvent } from '@uas/core';
import { garden2Grid } from '@uas/pack-basic';
import { World } from '@uas/sim';
import { admit, buildCandidates, computeMood, mergeDuplicates, MindSystem, score } from '../src/index.ts';
import { registry } from './helpers.ts';

/**
 * Plans that hold (a commitment that walks to its targets, repairs a missing item and outlasts
 * weak interruptions), loops that escalate, repeats on unchanged things, merged memories, and a
 * calm mood while asleep.
 */
const GARDEN2: EntityDef[] = [
  { id: 'robot', type: 'robot', pos: { x: 10, y: 10 }, state: { name: 'Robot' } },
  { id: 'fountain', type: 'fountain', pos: { x: 14, y: 6 } },
  { id: 'piano', type: 'piano', pos: { x: 3, y: 3 } },
  { id: 'ball', type: 'ball', pos: { x: 12, y: 12 } },
  { id: 'can', type: 'watering-can', pos: { x: 13, y: 8 } },
  { id: 'bed', type: 'garden-bed', pos: { x: 5, y: 11 } },
  { id: 'plant', type: 'plant', pos: { x: 6, y: 11 }, state: { growth: 0, water: 0.6 } },
  { id: 'mast', type: 'antenna-mast', pos: { x: 19, y: 12 } },
];
const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 'test' };

function setup(brain: 'models' | 'autopilot' = 'models') {
  const minds = new MindSystem();
  const world = World.create({ worldId: 'g2', seed: 3, grid: garden2Grid() }, registry, GARDEN2, minds, { mind: { brain } as Json });
  let seq = 0;
  const deltas: Delta[] = [];
  const jobs: ReturnType<MindSystem['drain']> = [];
  const input = (type: SimInputEvent['type'] | 'prompts.activate', payload: unknown) =>
    world.enqueue({ worldId: 'g2', seq: seq++, tick: world.tick, type, payload, packVersions: registry.packVersions } as SimInputEvent);
  const step = () => {
    deltas.push(...world.step().changes);
    jobs.push(...minds.drain());
  };
  const run = (n: number) => {
    for (let i = 0; i < n; i++) step();
  };
  const until = (pred: (d: Delta) => boolean, max = 2000) => {
    for (let i = 0; i < max; i++) {
      const from = deltas.length;
      step();
      if (deltas.slice(from).some(pred)) return;
    }
    throw new Error('never happened');
  };
  const robot = () => world.entity('robot') as Character;
  const feed = () => deltas.flatMap((d) => (d.kind === 'feed' ? [d.entry] : []));
  /** Answer the newest pending decide job with these candidate keys, in order. */
  const answer = (keys: string[]) => {
    const job = [...jobs].reverse().find((j) => j.job === 'decide')!;
    const cands = robot().mind!.pendingJobs.find((p) => p.jobId === job.jobId)!.candidates!;
    const ids = keys.map((k) => cands.find((c) => c.key === k)?.id).filter((x): x is string => !!x);
    expect(ids.length, `options ${cands.map((c) => c.key).join(', ')}`).toBe(keys.length);
    input('model.answer', { jobId: job.jobId, job: 'decide', characterId: 'robot', modelId: 'test', promptHash: '', usage, answer: { choices: ids.map((id) => ({ id, p: 1 })) } });
    return cands;
  };
  const scripted = (...actions: Action[]) =>
    input('model.answer', { jobId: `s${seq}`, job: 'decide', characterId: 'robot', modelId: 'test', promptHash: '', usage, answer: { actions } as unknown as Json });
  run(3);
  return { world, minds, input, run, step, until, robot, feed, answer, scripted, deltas, jobs };
}

/** Poke it and answer the decision with a plan. */
function plan(t: ReturnType<typeof setup>, keys: string[]) {
  // It knows the whole garden (as a robot that has looked around would).
  for (const e of GARDEN2.slice(1)) {
    const ent = t.world.entity(e.id!)!;
    t.robot().mind!.known[e.id!] = { type: ent.type, pos: { ...ent.pos }, affordances: Object.keys(registry.objects.get(ent.type)!.verbs), tick: t.world.tick };
  }
  t.input('admin.poke', { characterId: 'robot' });
  t.run(3);
  t.answer(keys);
  t.run(1);
}

describe('plans that hold', () => {
  it('a plan walks to every target, outlasts a weak interruption, ends with a "finished" line, then considers what came up', () => {
    const t = setup();
    plan(t, ['push:ball', 'pickup:watering-can', 'inspect:plant']);
    const start = t.feed().find((e) => e.intent);
    expect(start?.intent).toBe('inspect the plant');
    expect(t.robot().mind!.plan).toMatchObject({ total: 3, done: 0 });
    // A new thing appears in sight while it walks (salience 0.7 < 0.8): noted, not acted on.
    t.until((d) => d.kind === 'action' && d.action.verb === 'pickup' && d.status === 'started');
    t.input('admin.spawn', { id: 'rock', type: 'ball', pos: { x: 12, y: 10 } });
    t.run(3);
    expect(t.robot().mind!.deferred?.kind).toBe('sensed');
    t.until((d) => d.kind === 'feed' && !!d.entry.plan, 4000);
    const end = t.feed().find((e) => e.plan)!;
    // (inspecting a seedling 'fails': there is nothing much to see yet; every step still ran)
    expect(end.plan).toMatchObject({ status: 'finished', feedTick: start!.tick, intent: 'inspect the plant', total: 3 });
    expect(end.plan!.done).toBeGreaterThanOrEqual(2);
    const statuses = t.feed().filter((e) => e.tick >= start!.tick && !e.plan).flatMap((e) => e.actions.map((a) => a.status));
    expect(statuses).not.toContain('superseded');
    expect(statuses).not.toContain('rejected');
    // The deferred sighting is raised when the plan ends.
    expect(t.robot().mind!.deferred).toBeUndefined();
    t.run(2);
    expect(t.robot().mind!.pendingJobs.some((j) => j.job === 'decide' && j.trigger === 'sensed')).toBe(true);
  });

  it('a strong trigger replaces the plan, which is recorded as abandoned', () => {
    const t = setup();
    plan(t, ['push:ball', 'pickup:watering-can']);
    t.run(5);
    t.input('admin.poke', { characterId: 'robot' });
    t.run(2);
    const end = t.feed().find((e) => e.plan);
    // The poke dispatches a new decision; the plan ends when that decision is queued.
    t.answer(['push:ball']);
    t.run(2);
    expect(end ?? t.feed().find((e) => e.plan)).toMatchObject({ plan: { status: 'abandoned', why: 'replaced: admin-poke' } });
  });

  it('a step that needs something held is repaired: it fetches the thing and tries again', () => {
    const t = setup('autopilot');
    t.robot().mind!.known.can = { type: 'watering-can', pos: { x: 13, y: 8 }, affordances: ['pickup'], tick: 0 };
    t.scripted({ verb: 'fill', targetId: 'fountain', reason: 'test' });
    t.until((d) => d.kind === 'action' && d.action.verb === 'fill' && d.status === 'done' && d.action.args?.repaired === true, 3000);
    expect(t.world.entity('can')!.heldBy).toBe('robot');
    expect(t.world.entity('can')!.state.water).toBe(1);
    const repair = t.feed().find((e) => e.reason?.startsWith('repair:'));
    expect(repair?.reason).toBe('repair: I need the watering-can to fill the fountain');
    expect(repair?.actions.map((a) => a.verb)).toEqual(['moveTo', 'pickup', 'fill']);
  });

  it('replays to the same state', () => {
    const go = () => {
      const t = setup();
      plan(t, ['push:ball', 'pickup:watering-can', 'inspect:plant']);
      t.input('admin.spawn', { id: 'rock', type: 'ball', pos: { x: 4, y: 4 } });
      t.run(1500);
      return t.world.hash();
    };
    expect(go()).toBe(go());
  });
});

describe('repeats on unchanged things', () => {
  it('doing the same thing to an unchanged thing again is "nothing new", until the thing changes', () => {
    const t = setup('autopilot');
    t.scripted({ verb: 'moveTo', targetId: 'mast', reason: 'test' }, { verb: 'scan', targetId: 'mast', reason: 'test' });
    t.until((d) => d.kind === 'action' && d.action.verb === 'scan' && d.status === 'done');
    const m = t.robot().mind!;
    m.known.mast = { type: 'antenna-mast', pos: { x: 19, y: 12 }, affordances: ['scan'], tick: t.world.tick };
    const scan = () => buildCandidates(t.world, t.robot(), m).find((c) => c.key === 'scan:antenna-mast')!;
    expect(scan().stale).toBe(true);
    const arch = t.world.archetype('robot')!;
    const scored = score(t.robot(), m, arch, buildCandidates(t.world, t.robot(), m), false);
    const value = (k: string) => scored.find((s) => s.candidate.key === k)!.value;
    expect(value('scan:antenna-mast')).toBeLessThan(value('wait:self'));
    // …and a model isn't offered it.
    expect(t.minds.decisionRequest(t.world, t.robot(), 'action-finished').candidates.map((c) => c.key)).not.toContain('scan:antenna-mast');
    // The mast moves: it has changed, so looking again is worth it.
    t.input('admin.edit', { id: 'mast', pos: { x: 18, y: 12 } });
    t.run(1);
    expect(scan().stale).toBeUndefined();
  });
});

describe('memories and mood', () => {
  const mem = (id: string, text: string, strength = 0.75): Memory => ({
    id,
    store: 'ltm',
    tick: 1,
    day: 0,
    kind: 'outcome',
    text,
    about: { verb: 'splash', objectType: 'fountain', when: 'night' },
    valence: 0.5,
    strength,
    recalls: 0,
    recallDays: [0],
    lastRecallTick: 1,
  });
  const tuning = { stmHalfLifeDays: 1, ltmHalfLifeDays: 7, recallAlpha: 0.5, subjectCeiling: 5 } as never;

  it('long-term memory keeps one copy of a repeated experience, with a count', () => {
    const store = [mem('a', 'I tried splash at the fountain at night: my circuits fizzed')];
    for (const id of ['b', 'c']) expect(admit(store, mem(id, 'I tried splash at the fountain at night: my circuits fizzed'), 50, 10, 1000, tuning).merged?.id).toBe('a');
    expect(store).toHaveLength(1);
    expect(store[0]).toMatchObject({ text: 'I tried splash at the fountain at night: my circuits fizzed (×3)', count: 3 });
    expect(store[0]!.strength).toBeGreaterThan(0.75);
    // Older stores are cleaned up at sleep.
    const old = [mem('x', 'same'), mem('y', 'other'), mem('z', 'same'), mem('w', 'same')];
    expect(mergeDuplicates(old).map((p) => p.removed.id)).toEqual(['z', 'w']);
    expect(old.map((m) => m.text)).toEqual(['same (×3)', 'other']);
  });

  it('a bad mood fades at a quarter-second tick, and asleep the robot is calm', () => {
    const t = setup('autopilot');
    t.world.state.config.secondsPerTick = 0.25;
    const m = t.robot().mind!;
    m.sleep = 'asleep'; // nothing to add to the bias meanwhile
    m.mood.bias = -1;
    t.run(400); // 100 in-world seconds: each tick's decay is far below 0.001
    expect(m.mood.bias).toBeCloseTo(-Math.pow(0.5, 100 / 3600), 6);
    expect(m.mood.bias).toBeGreaterThan(-1);
    expect(computeMood([0.75, 0.72, 0.8, 0.93], -1, true, true)).toMatchObject({ arousal: 0.2 });
    expect(computeMood([0.75, 0.72, 0.8, 0.93], -1, true, true).word).not.toBe('agitated');
  });
});

export type { FeedEntry };

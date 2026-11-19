import { describe, expect, it } from 'vitest';
import type { Action, Character, Delta, Json, SimInputEvent } from '@uas/core';
import { buildCandidates, score, setAside } from '../src/autopilot.ts';
import { buildPrompt } from '../src/prompt.ts';
import type { MindConfig } from '../src/config.ts';
import { GARDEN, mindWorld, registry } from './helpers.ts';

const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 'test' };

function setup(mind: Partial<MindConfig> = { brain: 'autopilot' }) {
  // The robot starts beside the ball, so scripted steps aren't interrupted by new sights on the way.
  const entities = GARDEN.map((e) => (e.id === 'robot' ? { ...e, pos: { x: 12, y: 11 } } : e));
  const { world, minds } = mindWorld(5, mind, entities);
  let seq = 0;
  const input = (type: SimInputEvent['type'], payload: unknown) =>
    world.enqueue({ worldId: 'garden', seq: seq++, tick: world.tick, type, payload, packVersions: registry.packVersions } as SimInputEvent);
  const deltas: Delta[] = [];
  const jobs: string[] = [];
  const run = (n: number) => {
    for (let i = 0; i < n; i++) {
      deltas.push(...world.step().changes);
      jobs.push(...minds.drain().map((j) => j.job));
    }
  };
  const decide = (...actions: Action[]) =>
    input('model.answer', { jobId: `s${seq}`, job: 'decide', characterId: 'robot', modelId: 'test', promptHash: '', usage, answer: { actions } as unknown as Json });
  const robot = () => world.entity('robot') as Character;
  /** Step until a delta matches (at most `max` ticks). */
  const until = (pred: (d: Delta) => boolean, max = 100) => {
    for (let i = 0; i < max; i++) {
      const out = world.step().changes;
      deltas.push(...out);
      jobs.push(...minds.drain().map((j) => j.job));
      if (out.some(pred)) return;
    }
    throw new Error('never happened');
  };
  const arch = registry.archetypes.get('robot')!;
  run(3); // past the spawn's woke-up decision
  return { world, input, run, until, decide, robot, deltas, jobs, arch };
}

const act = (verb: string, targetId?: string): Action => ({ verb, ...(targetId && { targetId }), reason: 'test' });

describe('behaviour loops', () => {
  it('while carrying the ball: no pickup offered, drop and push are; the prompt says so; pickup says why it fails', () => {
    const t = setup();
    t.decide(act('pickup', 'ball'));
    t.until((d) => d.kind === 'action' && d.action.verb === 'pickup' && d.status === 'done');
    expect(t.world.entity('ball')!.heldBy).toBe('robot');
    const keys = buildCandidates(t.world, t.robot(), t.robot().mind!).map((c) => c.key);
    expect(keys).not.toContain('pickup:ball');
    expect(keys).toEqual(expect.arrayContaining(['drop:ball', 'push:ball']));
    const p = buildPrompt(t.robot(), t.robot().mind!, t.arch, { isNight: false, timeWord: 'morning', trigger: 'action-finished', question: 'Which?', carrying: ['ball'] });
    expect(p.state).toContain('carrying: the ball');
    // A scripted plan that starts with a failing pickup still runs its later steps.
    t.decide(act('pickup', 'ball'), act('drop', 'ball'));
    t.run(30);
    const ball = t.deltas.filter((d): d is Extract<Delta, { kind: 'action' }> => d.kind === 'action' && d.action.targetId === 'ball');
    expect(ball.find((d) => d.action.verb === 'pickup' && d.status === 'failed')?.reason).toBe("you're already holding it");
    expect(ball.some((d) => d.action.verb === 'drop' && d.status === 'done')).toBe(true);
    expect(t.world.entity('ball')!.heldBy).toBeUndefined();
  });

  it('pushing a held ball tosses it', () => {
    const t = setup();
    t.decide(act('pickup', 'ball'), act('push', 'ball'));
    t.run(80);
    expect(t.deltas.some((d) => d.kind === 'action' && d.action.verb === 'push' && d.status === 'done' && d.observation === 'you tossed the ball and it rolled away')).toBe(true);
    expect(t.world.entity('ball')!.heldBy).toBeUndefined();
  });

  it('an option that fails twice in a row is set aside, longer each time that day (10 min, 1 h, the rest of the day)', () => {
    const t = setup();
    const m = () => t.robot().mind!;
    const spt = t.world.state.config.secondsPerTick;
    t.decide(act('pickup', 'ball'));
    t.until((d) => d.kind === 'action' && d.action.verb === 'pickup' && d.status === 'done');
    const failTwice = () => {
      if (t.world.entity('ball')!.heldBy !== 'robot') {
        t.decide(act('pickup', 'ball'));
        t.until((d) => d.kind === 'action' && d.action.verb === 'pickup' && d.status === 'done', 400);
      }
      for (let i = 0; i < 2; i++) {
        t.decide(act('pickup', 'ball'));
        t.until((d) => d.kind === 'action' && d.action.verb === 'pickup' && d.status === 'failed');
      }
    };
    const left = () => (m().failures!['pickup:ball']!.until! - t.world.tick) * spt; // in-world seconds
    failTwice();
    expect(setAside(t.world, m(), 'pickup:ball')).toBe(true);
    expect(left()).toBeGreaterThan(560);
    expect(left()).toBeLessThanOrEqual(600);
    // Ten in-world minutes later it may be tried again.
    t.run(Math.ceil(600 / spt) + 1);
    expect(setAside(t.world, m(), 'pickup:ball')).toBe(false);
    // The second time today: an hour; the third: the rest of the in-world day.
    failTwice();
    expect(left()).toBeGreaterThan(3500);
    expect(left()).toBeLessThanOrEqual(3600);
    m().failures!['pickup:ball']!.until = t.world.tick; // skip ahead
    failTwice();
    expect(left()).toBeGreaterThan(3600);
    expect(left()).toBeLessThanOrEqual(86_400);
    expect(m().loops?.['pickup:ball']?.count).toBe(3);
  });

  it('waiting again after a wait, with nothing new, goes to autopilot without a model call', () => {
    const t = setup({ brain: 'models' });
    t.run(2);
    t.jobs.length = 0;
    t.robot().mind!.idle = true;
    t.robot().queue = [];
    t.robot().mind!.pendingJobs = []; // the spawn's own decision is still out
    delete t.robot().current;
    t.robot().mind!.triggers.push({ kind: 'action-finished', tick: t.world.tick, salience: 0.3 });
    t.run(1);
    expect(t.jobs).not.toContain('decide');
    const feed = t.deltas.filter((d) => d.kind === 'feed').at(-1);
    expect(feed?.kind === 'feed' && feed.entry.tier).toBe('autopilot');
  });

  it('the same routine trigger after a non-idle decision still asks the model', () => {
    const t = setup({ brain: 'models' });
    t.jobs.length = 0;
    t.robot().mind!.idle = false;
    t.robot().queue = [];
    t.robot().mind!.pendingJobs = [];
    delete t.robot().current;
    t.robot().mind!.triggers.push({ kind: 'action-finished', tick: t.world.tick, salience: 0.3 });
    t.run(1);
    expect(t.jobs).toContain('decide');
  });

  it('restlessness makes looking around beat waiting', () => {
    const t = setup();
    const c = t.robot();
    c.needs.curiosity = 0.2;
    const scored = score(c, c.mind!, t.arch, buildCandidates(t.world, c, c.mind!), false);
    const explore = scored.find((s) => s.candidate.key === 'explore:self')!;
    const wait = scored.find((s) => s.candidate.key === 'wait:self')!;
    expect(explore.value).toBeGreaterThan(wait.value);
    c.needs.curiosity = 1;
    const sated = score(c, c.mind!, t.arch, buildCandidates(t.world, c, c.mind!), false);
    expect(sated.find((s) => s.candidate.key === 'explore:self')!.value).toBeLessThan(0.01);
  });

  it('feed steps resolve: done with the observation, failed or rejected with the reason, superseded when replaced', () => {
    const t = setup();
    t.run(400);
    const entries = new Map<string, { verb: string; status: string; result?: string }[]>();
    for (const d of t.deltas) {
      if (d.kind === 'feed') entries.set(`${d.entry.characterId}@${d.entry.tick}`, d.entry.actions.map((a) => ({ ...a })));
      if (d.kind === 'feedStep') {
        const steps = entries.get(`${d.characterId}@${d.feedTick}`);
        expect(steps, 'a step of a known entry').toBeDefined();
        expect(steps![d.step]!.status).toBe('queued'); // resolved once
        steps![d.step] = { ...steps![d.step]!, status: d.status, ...(d.result && { result: d.result }) };
      }
    }
    const all = [...entries.values()];
    const resolved = all.slice(0, -1).flat(); // the latest entry may still be running
    expect(resolved.length).toBeGreaterThan(3);
    expect(resolved.filter((a) => a.status === 'queued')).toEqual([]);
    const done = resolved.filter((a) => a.status === 'done' && a.verb !== 'moveTo' && a.verb !== 'wait');
    expect(done.some((a) => (a.result ?? '').length > 3)).toBe(true);
  });

  it('pickup then drop without using it sets the pickup aside and leaves a question; using it in between does not', () => {
    const t = setup();
    const m = () => t.robot().mind!;
    t.decide(act('pickup', 'ball'), act('drop', 'ball'));
    t.until((d) => d.kind === 'action' && d.action.verb === 'drop' && d.status === 'done');
    expect(setAside(t.world, m(), 'pickup:ball')).toBe(true);
    expect(m().openItems.some((i) => i.kind === 'question' && i.text.includes('put it down without using it'))).toBe(true);
    expect(buildCandidates(t.world, t.robot(), m()).map((c) => c.key)).not.toContain('pickup:ball');
    // Used in between: no guard.
    const u = setup();
    u.decide(act('pickup', 'ball'), act('push', 'ball'));
    u.until((d) => d.kind === 'action' && d.action.verb === 'push' && d.status === 'done');
    // The ball rolled away: it walks to it, picks it up and tosses it again.
    u.decide(act('pickup', 'ball'), act('push', 'ball'));
    u.until((d) => d.kind === 'action' && d.action.verb === 'push' && d.status === 'done' && d.action.args === undefined, 400);
    expect(setAside(u.world, u.robot().mind!, 'pickup:ball')).toBe(false);
  });
});

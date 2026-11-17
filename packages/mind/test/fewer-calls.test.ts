import { describe, expect, it } from 'vitest';
import type { Character, Delta, FeedEntry, Json, SimInputEvent } from '@uas/core';
import { mindWorld, registry } from './helpers.ts';

function setup() {
  const { world, minds } = mindWorld(5, { brain: 'models', appraiseOutcomes: false, jobTimeoutTicks: 10_000 });
  let seq = 0;
  const input = (type: SimInputEvent['type'], payload: unknown) =>
    world.enqueue({ worldId: 'garden', seq: seq++, tick: world.tick, type, payload, packVersions: registry.packVersions } as SimInputEvent);
  const robot = () => world.entity('robot') as Character;
  const run = (n: number) => {
    const out: Delta[] = [];
    for (let i = 0; i < n; i++) out.push(...world.step().changes);
    return out;
  };
  return { world, minds, input, robot, run };
}

describe('fewer model calls', () => {
  it('a critical battery with a known charger is an obvious choice: autopilot, no model call', () => {
    const t = setup();
    t.run(5);
    t.minds.drain();
    const m = t.robot().mind!;
    m.beliefs.push({ key: 'charge:solarPad@day', text: 'charge at the solarPad by day fills my battery', expectedNeedDeltas: { energy: 0.15 }, expectedValence: 0.5, support: 5, firmness: 0.9, lastSupportedDay: 0 });
    m.pendingJobs = [];
    t.input('admin.edit', { id: 'robot', energy: 0.05 });
    t.input('admin.poke', { characterId: 'robot' });
    const ds = t.run(2);
    const feed = ds.flatMap((d) => (d.kind === 'feed' ? [d.entry] : []));
    expect(feed.at(-1)).toMatchObject({ tier: 'autopilot', actions: [{ verb: 'moveTo', targetId: 'pad' }, { verb: 'charge', targetId: 'pad' }] });
    expect(feed.at(-1)!.reason).toMatch(/battery is nearly flat/);
    expect(t.minds.drain().filter((j) => j.job === 'decide')).toEqual([]);
  });

  it('offers a decision model only the 5–6 most relevant options', () => {
    const t = setup();
    t.run(30);
    const decide = t.minds.drain().filter((j) => j.job === 'decide');
    expect(decide.length).toBeGreaterThan(0);
    for (const j of decide) expect(j.options!.length).toBeLessThanOrEqual(6);
  });

  it('one plan covers several steps: the rest of the plan runs without another model call', () => {
    const t = setup();
    t.run(30);
    const job = t.minds.drain().find((j) => j.job === 'decide')!;
    const pending = t.robot().mind!.pendingJobs.find((p) => p.jobId === job.jobId)!;
    // Three two-action steps (walk there, use it) = 6 actions: longer than the 3-action queue.
    const steps = pending.candidates!.filter((c) => c.actions.length === 2).slice(0, 3);
    expect(steps).toHaveLength(3);
    const ids = steps.map((c) => c.id);
    t.input('model.answer', {
      jobId: job.jobId, job: 'decide', characterId: 'robot', modelId: 'test', promptHash: '',
      answer: { choices: ids.map((id) => ({ id, p: 1 })), confidence: 0.9, tier: 'llm' } as unknown as Json,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 'test' },
    });
    const ds = t.run(1500);
    const feed = ds.flatMap((d) => (d.kind === 'feed' ? [d.entry] : [])) as FeedEntry[];
    expect(feed[0]).toMatchObject({ tier: 'llm' });
    expect(feed[0]!.actions).toHaveLength(3);
    expect(feed.some((f) => f.tier === 'carry-on' && f.actions.length === 3)).toBe(true);
  });
});

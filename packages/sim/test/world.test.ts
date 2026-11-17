import { describe, expect, it } from 'vitest';
import { buildRegistry, gridFromRows, loadPack, type Action, type Delta, type Json, type SimInputEvent } from '@uas/core';
import { World, findPath } from '../src/index.ts';

const terrain = {
  '.': { walkable: true, blocksSight: false, soundDamping: 0 },
  '#': { walkable: false, blocksSight: true, soundDamping: 1 },
};
const registry = buildRegistry([
  loadPack({
    manifest: { name: 't', version: '0.0.1', licence: 'MIT' },
    objects: [
      { type: 'rock', solid: true, verbs: { kick: { range: 1, durationTicks: 3, handler: 't.kick' } } },
      { type: 'mat', verbs: {} },
    ],
    archetypes: [
      {
        type: 'bot',
        needs: { fun: { decayPerHour: 0 } },
        energy: { label: 'battery', idleDrainPerHour: 0 },
        noises: { pitches: { C: 1, D: 2 }, set: { beep: { synth: { wave: 'sine', ms: 100 } } }, maxChain: 2 },
      },
    ],
    handlers: { kick: () => ({ ok: true, needDeltas: { fun: 0.5, energy: -0.1 }, observation: 'thunk' }) },
  }),
]);

function setup(rows: string[]) {
  const world = World.create({ worldId: 'w', seed: 1, grid: gridFromRows(rows, terrain), moveTicksPerTile: 1 }, registry, [
    { id: 'bot', type: 'bot', pos: { x: 0, y: 0 } },
  ]);
  let seq = 0;
  const input = (type: SimInputEvent['type'], payload: unknown) =>
    world.enqueue({ worldId: 'w', seq: seq++, tick: world.tick, type, payload, packVersions: registry.packVersions } as SimInputEvent);
  const decide = (...actions: Action[]) =>
    input('model.answer', {
      jobId: 'j', job: 'decide', characterId: 'bot', modelId: 'm', promptHash: '',
      answer: { actions } as unknown as Json,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 'm' },
    });
  const run = (ticks: number) => {
    const out: Delta[] = [];
    for (let i = 0; i < ticks; i++) out.push(...world.step().changes);
    return out;
  };
  const statuses = (ds: Delta[]) => ds.flatMap((d) => (d.kind === 'action' ? [`${d.action.verb}:${d.status}${d.reason ? `:${d.reason}` : ''}`] : []));
  return { world, input, decide, run, statuses };
}

const a = (verb: string, extra: Partial<Action> = {}): Action => ({ verb, reason: 'test', ...extra });

describe('pathfinding', () => {
  it('routes around walls and returns null when walled in', () => {
    const grid = gridFromRows(['..#..', '..#..', '.....'], terrain);
    const walk = (p: { x: number; y: number }) => grid.tiles[p.y * grid.width + p.x] === '.' && p.x >= 0 && p.y >= 0 && p.x < 5 && p.y < 3;
    expect(findPath({ x: 0, y: 0 }, { target: { x: 4, y: 0 }, radius: 0 }, walk)).toHaveLength(8);
    expect(findPath({ x: 0, y: 0 }, { target: { x: 4, y: 0 }, radius: 0 }, (p) => walk(p) && p.y < 2)).toBeNull();
  });
});

describe('world', () => {
  it('walks to a solid object, stops beside it and resolves its verb', () => {
    const t = setup(['.....', '.....']);
    t.input('admin.spawn', { id: 'rock', type: 'rock', pos: { x: 4, y: 0 } });
    t.decide(a('moveTo', { targetId: 'rock' }), a('kick', { targetId: 'rock' }));
    const ds = t.run(20);
    expect(t.world.entity('bot')!.pos).toEqual({ x: 3, y: 0 });
    expect(t.statuses(ds)).toEqual(['moveTo:queued', 'kick:queued', 'moveTo:started', 'moveTo:done', 'kick:started', 'kick:done']);
    expect(ds).toContainEqual({ kind: 'needs', id: 'bot', values: { energy: 0.65, fun: 1 } });
  });

  it('rejects out-of-range verbs, unknown verbs, bad notes and a 4th queued action', () => {
    const t = setup(['.....']);
    t.input('admin.spawn', { id: 'rock', type: 'rock', pos: { x: 4, y: 0 } });
    t.decide(a('kick', { targetId: 'rock' }), a('dance', { targetId: 'rock' }), a('vocalize', { args: { notes: ['beep-C', 'beep-D', 'beep-C'] } }), a('wait'));
    const s = t.statuses(t.run(2));
    expect(s).toContain('wait:rejected:queue holds at most 3 actions');
    expect(s).toContain('kick:rejected:out of range');
    expect(s).toContain('dance:rejected:rock has no verb dance');
    expect(s).toContain('vocalize:rejected:at most 2 notes');
  });

  it('rejects unwalkable destinations and unreachable targets', () => {
    const t = setup(['..#..']);
    t.decide(a('moveTo', { args: { x: 2, y: 0 } }), a('moveTo', { args: { x: 4, y: 0 } }));
    expect(t.statuses(t.run(1))).toEqual([
      'moveTo:queued', 'moveTo:queued', 'moveTo:rejected:destination is not walkable', 'moveTo:rejected:no path',
    ]);
  });

  it('a new decision cancels the running action', () => {
    const t = setup(['.....']);
    t.decide(a('wait', { args: { ticks: 50 } }));
    t.run(3);
    t.decide(a('vocalize', { args: { notes: ['beep-D'] } }));
    const ds = t.run(5);
    expect(t.statuses(ds)).toEqual(['wait:cancelled:replaced by a new decision', 'vocalize:queued', 'vocalize:started', 'vocalize:done']);
    expect(ds).toContainEqual({ kind: 'vocalize', id: 'bot', pos: { x: 0, y: 0 }, notes: ['beep-D'] });
  });

  it('repaths when a solid object is dropped in the way', () => {
    const t = setup(['.....', '.....']);
    t.decide(a('moveTo', { args: { x: 4, y: 0 } }));
    t.run(2);
    t.input('admin.spawn', { id: 'rock', type: 'rock', pos: { x: 2, y: 0 } });
    t.run(10);
    expect(t.world.entity('bot')!.pos).toEqual({ x: 4, y: 0 });
  });

  it('follow keeps the character next to a moving target', () => {
    const t = setup(['......']);
    t.input('admin.spawn', { id: 'mat', type: 'mat', pos: { x: 3, y: 0 } });
    t.decide(a('follow', { targetId: 'mat', args: { ticks: 20 } }));
    t.run(5);
    expect(t.world.entity('bot')!.pos).toEqual({ x: 2, y: 0 });
    t.input('admin.edit', { id: 'mat', pos: { x: 5, y: 0 } });
    t.run(5);
    expect(t.world.entity('bot')!.pos).toEqual({ x: 4, y: 0 });
  });

  it('reports bad inputs as inputRejected deltas', () => {
    const t = setup(['..']);
    t.input('admin.spawn', { type: 'dragon', pos: { x: 0, y: 0 } });
    t.input('admin.despawn', { id: 'nope' });
    const ds = t.run(1);
    expect(ds.map((d) => d.kind === 'inputRejected' && d.reason)).toEqual(['unknown entity type dragon', 'no entity nope']);
  });

  it('refuses inputs for past ticks or other pack versions', () => {
    const t = setup(['..']);
    t.run(2);
    const e = { worldId: 'w', seq: 9, tick: 1, type: 'admin.despawn', payload: { id: 'bot' }, packVersions: registry.packVersions } as const;
    expect(() => t.world.enqueue(e)).toThrow(/past tick/);
    expect(() => t.world.enqueue({ ...e, tick: 5, packVersions: 'other' })).toThrow(/packs/);
  });

  it('snapshots round-trip to the same hash and continue identically', () => {
    const t = setup(['.....', '.....']);
    t.decide(a('moveTo', { args: { x: 4, y: 1 } }), a('wait'));
    t.run(3);
    const copy = World.fromSnapshot(t.world.snapshot(), registry);
    expect(copy.hash()).toBe(t.world.hash());
    for (let i = 0; i < 20; i++) expect(copy.step()).toEqual(t.world.step());
    expect(copy.hash()).toBe(t.world.hash());
  });
});

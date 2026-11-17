import { describe, expect, it } from 'vitest';
import { RngStreams, buildRegistry, type Action, type Json } from '@uas/core';
import { World, type WorldState } from '@uas/sim';
import { basicPack, gardenGrid } from '@uas/pack-basic';
import { MemoryInputLog, MemorySnapshotStore, Recorder, replay } from '../src/index.ts';

const TICKS = 10_000;
const registry = buildRegistry([basicPack()]);
const usage = { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, costAud: 0.0001, latencyMs: 300, modelId: 'fake' };
const OBJECT_VERBS: Record<string, string[]> = {
  solarPad: ['charge', 'scan'],
  dock: ['dock', 'rest'],
  ball: ['pickup', 'drop', 'push', 'chase'],
  fountain: ['rinse', 'splash', 'scan'],
  piano: ['play', 'press', 'scan'],
};
const NOTES = ['beep', 'chirp', 'trill', 'buzz', 'honk'].flatMap((n) => ['C', 'D', 'E', 'G'].map((p) => `${n}-${p}`));

/** Drives a recorded world with random inputs from an RNG that lives outside the sim. */
function record() {
  const log = new MemoryInputLog();
  const snapshots = new MemorySnapshotStore<WorldState>();
  const world = World.create({ worldId: 'm2', seed: 2026, grid: gardenGrid() }, registry, [
    { id: 'r1', type: 'robot', pos: { x: 10, y: 10 } },
    { id: 'r2', type: 'robot', pos: { x: 5, y: 12 } },
    { id: 'pad', type: 'solarPad', pos: { x: 8, y: 8 } },
    { id: 'dock', type: 'dock', pos: { x: 2, y: 7 } },
    { id: 'ball', type: 'ball', pos: { x: 12, y: 12 } },
    { id: 'fountain', type: 'fountain', pos: { x: 19, y: 6 } },
    { id: 'piano', type: 'piano', pos: { x: 3, y: 3 } },
  ]);
  const rec = new Recorder(world, log, snapshots, { worldId: 'm2', packVersions: registry.packVersions });
  const rng = new RngStreams(777).get('inputs');

  const randomAction = (): Action => {
    const ids = world.entities().map((e) => e.id);
    const target = rng.next() < 0.9 ? rng.pick(ids) : 'ghost';
    const ent = world.entity(target);
    const r = rng.next();
    if (r < 0.35) return { verb: 'moveTo', targetId: target, reason: 'go' };
    if (r < 0.45) return { verb: 'moveTo', args: { x: rng.int(-1, 24), y: rng.int(-1, 16) }, reason: 'wander' };
    if (r < 0.5) return { verb: 'vocalize', args: { notes: Array.from({ length: rng.int(0, 5) }, () => rng.pick(NOTES)) }, reason: 'hi' };
    if (r < 0.55) return { verb: 'follow', targetId: target, args: { ticks: rng.int(1, 200) }, reason: 'tag along' };
    if (r < 0.6) return { verb: rng.pick(['wait', 'rest']), args: { ticks: rng.int(1, 80) }, reason: 'pause' };
    const verbs = ent ? (OBJECT_VERBS[ent.type] ?? ['poke']) : ['poke'];
    return { verb: rng.pick(verbs), targetId: target, reason: 'try it' };
  };

  /** Walk to an object, then use it: most of these succeed. */
  const purposeful = (): Action[] => {
    const obj = rng.pick(world.entities().filter((e) => e.kind === 'object'));
    const verb = rng.pick(OBJECT_VERBS[obj.type]!);
    return [{ verb: 'moveTo', targetId: obj.id, reason: 'go' }, { verb, targetId: obj.id, reason: 'try it' }, randomAction()];
  };
  const hashes: string[] = [world.hash()];
  const counts: Record<string, number> = {};
  for (let t = 0; t < TICKS; t++) {
    const r = rng.next();
    if (r < 0.015) {
      rec.submit('model.answer', {
        jobId: `job-${t}`, job: 'decide', characterId: rng.pick(['r1', 'r2']), modelId: 'fake', promptHash: 'x', usage,
        answer: { actions: rng.next() < 0.5 ? purposeful() : Array.from({ length: rng.int(1, 4) }, randomAction) } as unknown as Json,
      });
    } else if (r < 0.02) {
      rec.submit('admin.edit', { id: rng.pick(['ball', 'piano', 'pad', 'r2']), pos: { x: rng.int(0, 23), y: rng.int(0, 15) } });
    } else if (r < 0.022) {
      rec.submit('admin.spawn', { type: rng.pick(['ball', 'fountain', 'unicorn']), pos: { x: rng.int(0, 23), y: rng.int(0, 15) } });
    } else if (r < 0.023) {
      const balls = world.entities().filter((e) => e.type === 'ball' || e.type === 'fountain');
      rec.submit('admin.despawn', { id: balls.length ? rng.pick(balls).id : 'none' });
    } else if (r < 0.024) {
      rec.submit('admin.edit', { id: rng.pick(['ball', 'fountain']), state: { flowing: rng.next() < 0.5, color: rng.int(0, 9) } });
    }
    for (const d of rec.step().changes) {
      const key = d.kind === 'action' ? `${d.status}` : d.kind;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    hashes.push(world.hash());
  }
  return { log, snapshots, world, hashes, counts };
}

const restore = (s: { state: WorldState }) => World.fromSnapshot(s.state, registry);

describe('M2: event log, snapshots and replay', () => {
  const run = record();

  it('records a busy 10,000-tick run', () => {
    expect(run.world.tick).toBe(TICKS);
    expect(run.snapshots.list('m2').map((s) => s.tick)).toEqual(Array.from({ length: 11 }, (_, i) => i * 1000));
    expect(run.log.lastSeq('m2')).toBeGreaterThan(150);
    // The random inputs exercise success, failure and rejection paths.
    for (const k of ['done', 'rejected', 'cancelled', 'moved', 'needs', 'state', 'held', 'vocalize', 'spawned', 'despawned', 'inputRejected']) {
      expect(run.counts[k], k).toBeGreaterThan(0);
    }
    const dist = new Set(run.hashes);
    expect(dist.size).toBeGreaterThan(TICKS / 2);
  });

  it('replays from every snapshot to identical hashes at every tick', () => {
    for (const snap of run.snapshots.list('m2')) {
      const world = replay({
        worldId: 'm2', log: run.log, snapshots: run.snapshots, restore,
        fromTick: snap.tick, toTick: TICKS,
        onTick: (w) => {
          if (w.hash() !== run.hashes[w.tick]) throw new Error(`diverged at tick ${w.tick} replaying from ${snap.tick}`);
        },
      });
      expect(world.hash()).toBe(run.hashes[TICKS]);
    }
  });

  it('seeks to an arbitrary tick', () => {
    for (const t of [1, 999, 1000, 4321, 9999]) {
      expect(replay({ worldId: 'm2', log: run.log, snapshots: run.snapshots, restore, toTick: t }).hash()).toBe(run.hashes[t]);
    }
  });

  it('refuses to replay without the recorded content pack version', () => {
    const other = buildRegistry([{ ...basicPack(), contentHash: 'deadbeefdeadbeef' }]);
    expect(() =>
      replay({ worldId: 'm2', log: run.log, snapshots: run.snapshots, restore: (s) => World.fromSnapshot(s.state, other), toTick: 10 }),
    ).toThrow(/basic@0\.1\.0#[0-9a-f]{16}/);
  });

  it('enforces a gap-free, monotonic seq', () => {
    const log = new MemoryInputLog();
    const e = { worldId: 'w', seq: 0, tick: 0, type: 'x', payload: null, packVersions: '' };
    log.append(e);
    expect(() => log.append(e)).toThrow(/expected seq 1/);
  });
});

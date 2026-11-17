import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRegistry, type Json } from '@uas/core';
import { World, type WorldState } from '@uas/sim';
import { MindSystem } from '@uas/mind';
import { basicPack, gardenGrid } from '@uas/pack-basic';
import { Recorder, SqliteInputLog, SqliteReadModels, SqliteSnapshotStore, openDb, replay } from '../src/index.ts';

describe('SQLite store (Drizzle, WAL)', () => {
  it('records a mind world and replays it from SQLite to the same hash', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'uas-')), 'test.db'));
    const registry = buildRegistry([basicPack()]);
    const log = new SqliteInputLog(db);
    const snaps = new SqliteSnapshotStore<WorldState>(db);
    const reads = new SqliteReadModels(db);
    const world = World.create({ worldId: 'w', seed: 5, grid: gardenGrid() }, registry, [
      { id: 'robot', type: 'robot', pos: { x: 10, y: 10 } },
      { id: 'pad', type: 'solarPad', pos: { x: 8, y: 8 } },
      { id: 'fountain', type: 'fountain', pos: { x: 14, y: 6 } },
    ], new MindSystem(), { mind: { brain: 'autopilot' } as Json });
    const rec = new Recorder(world, log, snaps, { worldId: 'w', packVersions: registry.packVersions, snapshotEveryTicks: 500 });
    for (let t = 0; t < 2000; t++) {
      if (t === 700) rec.submit('admin.edit', { id: 'pad', pos: { x: 5, y: 12 } });
      if (t === 900) rec.submit('admin.poke', { characterId: 'robot' });
      const out = rec.step();
      reads.write('w', out.tick, out.changes);
    }
    expect(snaps.list('w').map((s) => s.tick)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(log.read('w').map((e) => e.type)).toEqual(['admin.edit', 'admin.poke']);
    const replayed = replay({ worldId: 'w', log, snapshots: snaps, restore: (s) => World.fromSnapshot(s.state, registry, new MindSystem()), fromTick: 500, toTick: 2000 });
    expect(replayed.hash()).toBe(world.hash());
    expect(reads.feed('w', 'robot', 5).length).toBe(5);
    expect(reads.diary('w', 'robot', 0).length).toBeGreaterThan(0);
  });

  it('feed step deltas update the stored feed entry', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'uas-')), 'feed.db'));
    const reads = new SqliteReadModels(db);
    const entry = { tick: 7, characterId: 'robot', trigger: 'action-finished' as const, tier: 'autopilot' as const, actions: [
      { verb: 'moveTo', targetId: 'ball', reason: 'go', status: 'queued' as const },
      { verb: 'push', targetId: 'ball', reason: 'fun', status: 'queued' as const },
    ] };
    reads.write('w', 8, [{ kind: 'feed', entry }]);
    reads.write('w', 20, [{ kind: 'feedStep', characterId: 'robot', feedTick: 7, step: 0, status: 'done' }]);
    reads.write('w', 30, [{ kind: 'feedStep', characterId: 'robot', feedTick: 7, step: 1, status: 'failed', result: 'it is being held' }]);
    expect(reads.feed('w', 'robot')[0]!.actions.map((a) => [a.status, a.result])).toEqual([['done', undefined], ['failed', 'it is being held']]);
  });

  it('replays a mind world across a full sleep (pipeline, recharge, wake) to identical hashes', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'uas-')), 'sleep.db'));
    const registry = buildRegistry([basicPack()]);
    const log = new SqliteInputLog(db);
    const snaps = new SqliteSnapshotStore<WorldState>(db);
    const world = World.create({ worldId: 's', seed: 9, grid: gardenGrid() }, registry, [
      { id: 'robot', type: 'robot', pos: { x: 10, y: 10 } },
      { id: 'dock', type: 'dock', pos: { x: 2, y: 7 } },
      { id: 'ball', type: 'ball', pos: { x: 12, y: 12 } },
    ], new MindSystem(), { mind: { brain: 'autopilot' } as Json });
    const rec = new Recorder(world, log, snaps, { worldId: 's', packVersions: registry.packVersions, snapshotEveryTicks: 1000 });
    const hashes = [world.hash()];
    const phases: string[] = [];
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 't' };
    for (let t = 0; t < 6000; t++) {
      if (t === 500) {
        // A long day and a foggy head, then sleep.
        rec.submit('admin.edit', { id: 'robot', energy: 0.3 });
        rec.submit('model.answer', { jobId: 'x', job: 'decide', characterId: 'robot', modelId: 't', promptHash: '', usage, answer: { actions: [{ verb: 'rest', reason: 'sleep', args: { ticks: 100 } }] } });
      }
      for (const d of rec.step().changes) if (d.kind === 'sleep') phases.push(d.phase);
      hashes.push(world.hash());
    }
    expect(phases).toEqual(expect.arrayContaining(['asleep', 'awake']));
    for (const snap of snaps.list('s')) {
      const w = replay({
        worldId: 's', log, snapshots: snaps, restore: (x) => World.fromSnapshot(x.state, registry, new MindSystem()), fromTick: snap.tick, toTick: 6000,
        onTick: (x) => {
          if (x.hash() !== hashes[x.tick]) throw new Error(`diverged at ${x.tick} from ${snap.tick}`);
        },
      });
      expect(w.hash()).toBe(hashes[6000]);
    }
  });
});

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
});

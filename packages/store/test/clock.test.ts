import { describe, expect, it } from 'vitest';
import { buildRegistry, type Delta, type Json } from '@uas/core';
import { MindSystem } from '@uas/mind';
import { basicPack, gardenGrid } from '@uas/pack-basic';
import { World, type WorldState } from '@uas/sim';
import { MemoryInputLog, MemorySnapshotStore, Recorder, replay } from '../src/index.ts';

const registry = buildRegistry([basicPack()]);
const EPOCH = Date.UTC(2026, 10, 17, 20, 30, 0); // 2026-11-17 20:30 UTC
const clock = (epochMs: number, tz = 600, reason?: string) => ({ epochMs, tzOffsetMinutes: tz, timezone: 'Test/Zone', ...(reason && { reason }) });

function realtimeWorld() {
  const world = World.create({ worldId: 'rt', seed: 3, grid: gardenGrid(), secondsPerTick: 1, moveTicksPerTile: 2 }, registry, [
    { id: 'robot', type: 'robot', pos: { x: 10, y: 10 } },
    { id: 'pad', type: 'solarPad', pos: { x: 8, y: 8 } },
    { id: 'dock', type: 'dock', pos: { x: 2, y: 7 } },
  ], new MindSystem(), { mind: { brain: 'autopilot' } as Json });
  const log = new MemoryInputLog();
  const snaps = new MemorySnapshotStore<WorldState>();
  const rec = new Recorder(world, log, snaps, { worldId: 'rt', packVersions: registry.packVersions, snapshotEveryTicks: 500 });
  return { world, log, snaps, rec };
}

describe('real-time clock (anchor, jump, replay)', () => {
  it('anchors to local wall-clock time and counts days from the anchor date', () => {
    const { world, rec } = realtimeWorld();
    rec.submit('clock.anchor', clock(EPOCH)); // UTC+10 → 06:30 on the 18th, local
    const out = rec.step();
    expect(out.changes).toContainEqual(expect.objectContaining({ kind: 'clock', reason: 'anchor', timezone: 'Test/Zone' }));
    expect(world.timeOfDay * 24).toBeCloseTo(6.5 + 1 / 3600, 3);
    expect(world.day).toBe(0);
    for (let i = 0; i < 3600; i++) rec.step();
    expect(world.timeOfDay * 24).toBeCloseTo(7.5 + 1 / 3600, 3); // one in-world second per tick
  });

  it('a downtime jump moves time forward, needs do not drain over the gap, and the robot remembers waking up', () => {
    const { world, rec } = realtimeWorld();
    rec.submit('clock.anchor', clock(EPOCH));
    for (let i = 0; i < 100; i++) rec.step();
    const robot = () => world.entity('robot') as { energy: number; needs: Record<string, number>; mind: { stm: { text: string }[] } };
    const before = { energy: robot().energy, cool: robot().needs.cool! };
    rec.submit('clock.jump', clock(EPOCH + 7 * 3600_000, 600, 'restart'));
    const out = rec.step();
    const jump = out.changes.find((d): d is Extract<Delta, { kind: 'clock' }> => d.kind === 'clock')!;
    expect(jump.seconds - jump.previous).toBeGreaterThan(7 * 3600 - 200);
    expect(world.timeOfDay * 24).toBeCloseTo(13.5, 1);
    // One tick of drain, not seven hours of it.
    expect(before.energy - robot().energy).toBeLessThan(0.001);
    expect(before.cool - robot().needs.cool!).toBeLessThan(0.001);
    expect(out.changes.some((d) => d.kind === 'diary' && /switched off for 7\.0 hours and woke up at 13:3/.test(d.text))).toBe(true);
    expect(robot().mind.stm.some((m) => m.text.startsWith('I was switched off'))).toBe(true);
  });

  it('small re-alignments (drift sync) are not felt as being switched off', () => {
    const { world, rec } = realtimeWorld();
    rec.submit('clock.anchor', clock(EPOCH));
    rec.step();
    rec.submit('clock.jump', clock(EPOCH + 4000, 600, 'sync'));
    const out = rec.step();
    expect(out.changes.some((d) => d.kind === 'clock' && d.reason === 'sync')).toBe(true);
    expect(out.changes.some((d) => d.kind === 'diary' && d.text.includes('switched off'))).toBe(false);
    void world;
  });

  it('replays anchor and jumps exactly, without reading a clock', () => {
    const { world, log, snaps, rec } = realtimeWorld();
    rec.submit('clock.anchor', clock(EPOCH));
    const hashes: string[] = [world.hash()];
    for (let t = 0; t < 1500; t++) {
      if (t === 400) rec.submit('clock.jump', clock(EPOCH + 3 * 3600_000, 600, 'restart'));
      if (t === 900) rec.submit('clock.jump', clock(EPOCH + 3 * 3600_000 + 500_000, 600, 'realign'));
      rec.step();
      hashes.push(world.hash());
    }
    for (const from of [0, 500, 1000]) {
      const again = replay({
        worldId: 'rt', log, snapshots: snaps, fromTick: from, toTick: 1500,
        restore: (s) => World.fromSnapshot(s.state, registry, new MindSystem()),
        onTick: (w) => {
          if (w.hash() !== hashes[w.tick]) throw new Error(`diverged at ${w.tick} from ${from}`);
        },
      });
      expect(again.hash()).toBe(world.hash());
      expect(again.timeOfDay).toBe(world.timeOfDay);
    }
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorldRuntime, parseWorldFile, tzOffsetMinutes } from '../src/index.ts';

const config = (over: Record<string, unknown> = {}) =>
  parseWorldFile({
    id: 'clockworld',
    seed: 1,
    clock: { mode: 'realtime', timezone: 'Asia/Kolkata' },
    mind: { brain: 'autopilot' },
    entities: [{ id: 'robot', type: 'robot', pos: [10, 10] }],
    ...over,
  });

const localHour = (tz: string) => {
  const now = Date.now();
  return (((now / 1000 + tzOffsetMinutes(tz, now) * 60) % 86400) / 3600 + 24) % 24;
};

describe('real-time world clock (server)', () => {
  it('resolves real-time defaults: 1 s per tick, 1 tick per real second watched or not, 2 ticks per tile', () => {
    const c = config({ snapshotEverySeconds: 3600, mind: { jobTimeoutSeconds: 300, visitorQueue: { ttlSeconds: 600, cooldownSeconds: 60 } }, models: { models: {}, jobs: {}, queue: { staleSeconds: 60 } } });
    expect(c.sim.secondsPerTick).toBe(1);
    expect([c.ticksPerRealSecond, c.idleTicksPerRealSecond]).toEqual([1, 1]);
    expect(c.sim.moveTicksPerTile).toBe(2);
    expect(c.snapshotEveryTicks).toBe(3600);
    expect(c.mind).toMatchObject({ jobTimeoutTicks: 300, visitorQueue: { ttlTicks: 600, cooldownTicks: 60 } });
    expect(c.models.queue).toMatchObject({ staleTicks: 60 });
    expect(parseWorldFile({ id: 'x', seed: 1 }).clock.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('anchors a new world to local wall time, jumps over downtime on restart, and re-aligns on request', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-clock-')), 'uas.db');
    const a = new WorldRuntime(config(), { dbPath });
    a.start();
    a.tick();
    expect(a.log.read('clockworld').map((e) => e.type)).toEqual(['clock.anchor']);
    expect(a.world.timeOfDay * 24).toBeCloseTo(localHour('Asia/Kolkata'), 1);
    expect(Math.abs(a.drift())).toBeLessThan(3);
    for (let i = 0; i < 20; i++) a.tick();
    a.shutdown();

    // Restart on the same database: the world resumes and jumps to now with a logged input.
    const b = new WorldRuntime(config(), { dbPath });
    b.start();
    b.tick();
    expect(b.log.read('clockworld').map((e) => e.type)).toEqual(['clock.anchor', 'clock.jump']);
    expect(b.log.read('clockworld')[1]!.payload).toMatchObject({ reason: 'restart', timezone: 'Asia/Kolkata' });
    expect(Math.abs(b.drift())).toBeLessThan(3);

    // A sped-up world drifts ahead; realign brings it back with another logged jump.
    for (let i = 0; i < 600; i++) b.tick();
    expect(b.drift()).toBeGreaterThan(500);
    b.realign();
    b.tick();
    expect(b.log.read('clockworld').at(-1)!.payload).toMatchObject({ reason: 'realign' });
    expect(Math.abs(b.drift())).toBeLessThan(3);
  });

  it('scaled worlds keep the old fast clock and are never re-aligned', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-clock-')), 'uas.db');
    const c = config({ id: 'fast', clock: { mode: 'scaled' }, sim: { startSecond: 28800 } });
    expect([c.sim.secondsPerTick, c.ticksPerRealSecond, c.idleTicksPerRealSecond]).toEqual([2, 5, 0.75]);
    const rt = new WorldRuntime(c, { dbPath });
    rt.start();
    rt.tick();
    rt.realign();
    expect(rt.log.read('fast')).toEqual([]);
    expect(rt.world.timeOfDay * 24).toBeCloseTo(8, 2);
  });
});

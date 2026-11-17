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
  it('resolves real-time defaults: 4 ticks per real second at 0.25 s per tick, watched or not, 0.75 s per tile', () => {
    const c = config({ snapshotEverySeconds: 3600, mind: { jobTimeoutSeconds: 300, visitorQueue: { ttlSeconds: 600, cooldownSeconds: 60 } }, models: { models: {}, jobs: {}, queue: { staleSeconds: 60 } } });
    expect(c.sim.secondsPerTick).toBe(0.25);
    expect([c.ticksPerRealSecond, c.idleTicksPerRealSecond]).toEqual([4, 4]);
    expect(c.sim.moveTicksPerTile).toBe(3); // 0.75 s
    expect(c.sim.durationScale).toBe(4); // pack durations stay in seconds
    expect(c.snapshotEveryTicks).toBe(14_400);
    expect(c.mind).toMatchObject({ jobTimeoutTicks: 1200, visitorQueue: { ttlTicks: 2400, cooldownTicks: 240 } });
    expect(c.models.queue).toMatchObject({ staleTicks: 240 });
    expect(config({ ticksPerRealSecond: 2, sim: { moveSecondsPerTile: 1.5 } }).sim).toMatchObject({ secondsPerTick: 0.5, moveTicksPerTile: 3, durationScale: 2 });
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
    for (let i = 0; i < 2400; i++) b.tick();
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

describe('migrating a world from before the real-time clock', () => {
  it('first real-time start: sets the real-time tick rate (logged), anchors (no downtime), and keeps a small day count', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-clock-')), 'uas.db');
    // A world from the old scaled clock: 2 s per tick, 5 ticks per tile, a few in-world hours old.
    const old = new WorldRuntime(config({ clock: { mode: 'scaled' }, sim: { secondsPerTick: 2, moveTicksPerTile: 5, startSecond: 28800 } }), { dbPath });
    old.start();
    for (let i = 0; i < 300; i++) old.tick();
    // Reproduce the damaged state seen live: an un-anchored jump to the wall clock (day ≈ days since 1970).
    old.submit('clock.jump', { epochMs: Date.now(), tzOffsetMinutes: 330, timezone: 'Asia/Kolkata', reason: 'restart' });
    old.tick();
    expect(old.world.day).toBeGreaterThan(20_000);
    old.shutdown();

    const rt = new WorldRuntime(config(), { dbPath });
    rt.start();
    const out = rt.tick();
    const types = rt.log.read('clockworld').map((e) => e.type);
    expect(types.slice(-2)).toEqual(['sim.config', 'clock.anchor']);
    expect(rt.log.read('clockworld').at(-2)!.payload).toEqual({ secondsPerTick: 0.25, moveTicksPerTile: 3, durationScale: 4 });
    expect(rt.world.state.config.secondsPerTick).toBe(0.25);
    expect(rt.world.state.clock!.anchored).toBe(true);
    expect(rt.world.day).toBe(0); // 300 ticks × 2 s from 08:00 is still day 0
    expect(rt.status().inWorldSecondsPerRealSecond).toBe(1);
    expect(Math.abs(rt.drift())).toBeLessThan(3);
    expect(out.changes.some((d) => d.kind === 'diary' && d.text.includes('switched off'))).toBe(false);

    // The next restart is an ordinary downtime jump, with no further timing change.
    rt.shutdown();
    const again = new WorldRuntime(config(), { dbPath });
    again.start();
    again.tick();
    expect(again.log.read('clockworld').map((e) => e.type).slice(-1)).toEqual(['clock.jump']);
    expect(again.world.day).toBe(0);
  });

  it('refuses a real-time config that would not run at 1×', () => {
    expect(() => config({ ticksPerRealSecond: 5, sim: { secondsPerTick: 1 } })).toThrow(/realtime needs sim.secondsPerTick × ticksPerRealSecond = 1/);
  });
});

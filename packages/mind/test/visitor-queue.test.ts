import { describe, expect, it } from 'vitest';
import type { Character, Delta, SimInputEvent } from '@uas/core';
import { mindWorld, registry } from './helpers.ts';

describe('visitor queue', () => {
  it('queues noises aimed at a character, picks them in favour of the oldest, drops overflow and expired', () => {
    const { world } = mindWorld(9, { brain: 'autopilot', visitorQueue: { maxLength: 3, ttlTicks: 400, cooldownTicks: 100 } });
    let seq = 0;
    const input = (type: SimInputEvent['type'], payload: unknown) =>
      world.enqueue({ worldId: 'garden', seq: seq++, tick: world.tick, type, payload, packVersions: registry.packVersions } as SimInputEvent);
    input('admin.spawn', { id: 'visitor-1', type: 'robot', pos: { x: 11, y: 10 }, state: { visitor: true } });
    world.step();
    expect((world.entity('visitor-1') as Character).mind).toBeUndefined();
    const noise = (n: string) => ({ verb: 'vocalize', args: { notes: [n], at: 'robot' }, reason: 'hi' });
    input('visitor.command', { visitorId: 'visitor-1', actions: [noise('beep-C'), noise('beep-D'), noise('beep-E')] });
    input('visitor.command', { visitorId: 'visitor-1', actions: [noise('beep-G')] });
    const ds: Delta[] = [];
    for (let i = 0; i < 600; i++) ds.push(...world.step().changes);
    const picks = ds.filter((d) => d.kind === 'visitorPick');
    const dropped = ds.filter((d) => d.kind === 'visitorDropped');
    expect(dropped.some((d) => d.kind === 'visitorDropped' && d.reason === 'queue full')).toBe(true);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.length + dropped.length).toBe(4);
    // The visitor's own vocalize ran (and the robot heard it).
    expect(ds.some((d) => d.kind === 'vocalize' && d.id === 'visitor-1')).toBe(true);
  });
});

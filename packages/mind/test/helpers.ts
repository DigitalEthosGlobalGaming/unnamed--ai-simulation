import { buildRegistry, type Delta, type EntityDef, type Json, type Registry } from '@uas/core';
import { World } from '@uas/sim';
import { basicPack, gardenGrid } from '@uas/pack-basic';
import { MindSystem, type MindConfig } from '../src/index.ts';

export const registry = buildRegistry([basicPack()]);

export const GARDEN: EntityDef[] = [
  { id: 'robot', type: 'robot', pos: { x: 10, y: 10 } },
  { id: 'pad', type: 'solarPad', pos: { x: 8, y: 8 } },
  { id: 'dock', type: 'dock', pos: { x: 2, y: 7 } },
  { id: 'ball', type: 'ball', pos: { x: 12, y: 12 } },
  { id: 'fountain', type: 'fountain', pos: { x: 14, y: 6 } },
  { id: 'piano', type: 'piano', pos: { x: 3, y: 3 } },
];

export function mindWorld(seed: number, mind: Partial<MindConfig> = {}, entities = GARDEN, reg: Registry = registry) {
  const minds = new MindSystem();
  const world = World.create({ worldId: 'garden', seed, grid: gardenGrid() }, reg, entities, minds, { mind: mind as Json });
  return { world, minds };
}

export const TICKS_PER_DAY = 14_400;

/** Ticks until the given hour of the in-world day (world starts at 08:00). */
export const hourTick = (day: number, hour: number) => day * TICKS_PER_DAY + (hour - 8) * 600;

export function doneKeys(world: World, ds: readonly Delta[]): string[] {
  return ds.flatMap((d) =>
    d.kind === 'action' && d.status === 'done' && d.action.targetId && world.entity(d.action.targetId)?.kind === 'object'
      ? [`${d.action.verb}:${world.entity(d.action.targetId)!.type}`]
      : [],
  );
}

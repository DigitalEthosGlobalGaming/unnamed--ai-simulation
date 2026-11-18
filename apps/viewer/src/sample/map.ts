import type { Entity, WorldMap, Terrain } from './types.ts';
import { DEFS, gardenObjects } from './garden.ts';

/**
 * Sample garden for the first playable slice: 24 × 16 tiles with a hut,
 * a pond edge and paths. '#' wall, '~' water, ':' path, '.' floor.
 */
const ROWS = [
  '#########...............',
  '#.......#...............',
  '#.......#...............',
  '#.......#...............',
  '#.......:::::::.........',
  '#.......#.....:.........',
  '####.####.....:.........',
  '....:.........:.........',
  '....:.........:....~~~..',
  '....::::::::::::..~~~~~.',
  '...............:.~~~~~~.',
  '...............:.~~~~~~.',
  '...............:..~~~~..',
  '...............:........',
  '........................',
  '........................',
];

const KIND: Record<string, Terrain['kind']> = { '#': 'wall', '~': 'water', ':': 'path', '.': 'floor' };

export function sampleMap(): WorldMap {
  const tiles: Terrain['kind'][] = [];
  for (const row of ROWS) for (const ch of row) tiles.push(KIND[ch] ?? 'floor');
  return { width: ROWS[0]!.length, height: ROWS.length, tiles };
}

export function emptyMap(): WorldMap {
  const w = 24;
  const h = 16;
  return { width: w, height: h, tiles: new Array<Terrain['kind']>(w * h).fill('floor') };
}

export function terrainAt(map: WorldMap, x: number, y: number): Terrain {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return { kind: 'wall', walkable: false, blocksSight: true };
  const kind = map.tiles[y * map.width + x]!;
  return { kind, walkable: kind === 'floor' || kind === 'path', blocksSight: kind === 'wall' };
}

/** The new garden (iteration 2): see garden.ts. */
export function sampleObjects(): Entity[] {
  return gardenObjects();
}

export const OBJECT_LABEL: Record<string, string> = Object.fromEntries(DEFS.map((d) => [d.id, d.name]));

/** Verbs each object offers (affordances, never effects), product verbs included. */
export const OBJECT_VERBS: Record<string, string[]> = Object.fromEntries(
  DEFS.map((d) => [d.id, [...(d.portable ? ['pickup', 'drop'] : []), ...Object.keys(d.verbs ?? {}), ...(d.products ?? []).map((p) => p.verb), 'scan']]),
);

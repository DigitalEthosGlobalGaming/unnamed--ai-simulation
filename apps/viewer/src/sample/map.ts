import type { Entity, WorldMap, Terrain } from './types.ts';

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

export function sampleObjects(): Entity[] {
  return [
    { id: 'obj-dock', kind: 'object', type: 'dock', pos: { x: 2, y: 2 }, tags: ['shelter'], state: { occupied: 0 } },
    { id: 'obj-solar', kind: 'object', type: 'solarPad', pos: { x: 17, y: 3 }, tags: ['light'], state: { lit: true, charging: false } },
    { id: 'obj-fountain', kind: 'object', type: 'fountain', pos: { x: 12, y: 12 }, tags: ['water', 'loud'], state: { flowing: true } },
    { id: 'obj-ball', kind: 'object', type: 'ball', pos: { x: 7, y: 11 }, tags: ['portable'], state: {} },
    { id: 'obj-piano', kind: 'object', type: 'piano', pos: { x: 20, y: 14 }, tags: ['loud'], state: { playing: false } },
  ];
}

export const OBJECT_LABEL: Record<string, string> = {
  dock: 'Dock',
  solarPad: 'Solar pad',
  fountain: 'Fountain',
  ball: 'Ball',
  piano: 'Piano',
};

/** Verbs each object offers (affordances, never effects). */
export const OBJECT_VERBS: Record<string, string[]> = {
  solarPad: ['charge', 'scan'],
  dock: ['dock', 'rest'],
  ball: ['pickup', 'drop', 'push', 'chase'],
  fountain: ['rinse', 'splash', 'scan'],
  piano: ['play', 'press', 'scan'],
};

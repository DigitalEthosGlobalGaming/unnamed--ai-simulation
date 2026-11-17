export interface Pos {
  x: number;
  y: number;
}

export interface Terrain {
  walkable: boolean;
  blocksSight: boolean;
  /** 0 = sound passes freely, 1 = fully absorbed. */
  soundDamping: number;
}

/** Row-major tile grid; each tile is a key into `terrain`. */
export interface Grid {
  width: number;
  height: number;
  terrain: Record<string, Terrain>;
  tiles: string[];
}

export function gridFromRows(rows: string[], terrain: Record<string, Terrain>): Grid {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const tiles: string[] = [];
  for (const [y, row] of rows.entries()) {
    if (row.length !== width) throw new Error(`grid row ${y} has length ${row.length}, expected ${width}`);
    for (const ch of row) {
      if (!terrain[ch]) throw new Error(`grid row ${y}: unknown terrain '${ch}'`);
      tiles.push(ch);
    }
  }
  return { width, height, terrain, tiles };
}

export const inBounds = (g: Grid, p: Pos) => p.x >= 0 && p.y >= 0 && p.x < g.width && p.y < g.height;

export function terrainAt(g: Grid, p: Pos): Terrain | undefined {
  if (!inBounds(g, p)) return undefined;
  return g.terrain[g.tiles[p.y * g.width + p.x]!];
}

export const posKey = (p: Pos) => `${p.x},${p.y}`;
export const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y;
export const manhattan = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Fixed order: N, E, S, W. */
export function neighbors4(p: Pos): Pos[] {
  return [
    { x: p.x, y: p.y - 1 },
    { x: p.x + 1, y: p.y },
    { x: p.x, y: p.y + 1 },
    { x: p.x - 1, y: p.y },
  ];
}

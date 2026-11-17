import type { Delta } from '@uas/core';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inside = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;

/** Keep deltas relevant to a region: positional ones by position, the rest pass. */
export function filterRegion(changes: readonly Delta[], region: Rect | undefined): Delta[] {
  if (!region) return [...changes];
  return changes.filter((d) => {
    switch (d.kind) {
      case 'moved':
        return inside(region, d.from) || inside(region, d.to);
      case 'spawned':
        return inside(region, d.entity.pos);
      case 'vocalize':
        return inside(region, d.pos);
      default:
        return true;
    }
  });
}

export type { Channel } from '@uas/core';

/** Split a tick's changes into the three channels. */
export function splitChannels(changes: readonly Delta[]) {
  return {
    deltas: changes.filter((d) => d.kind !== 'feed' && d.kind !== 'feedStep'),
    feed: changes.flatMap((d) => (d.kind === 'feed' ? [d.entry] : [])),
    feedSteps: changes.flatMap((d) => (d.kind === 'feedStep' ? [d] : [])),
    noises: changes.filter((d) => d.kind === 'vocalize'),
  };
}

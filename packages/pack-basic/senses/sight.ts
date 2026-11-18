import { perceivedType, productPhrase, type Observation, type Sense, type WorldObject } from '@uas/core';
import { direction, lineOfSight } from './geometry.ts';

/** Sight: archetype `sightRange`, halved at night, blocked by `blocksSight` tiles. */
export const sight: Sense = {
  id: 'basic.sight',
  observe(self, world) {
    const full = world.archetype(self.type)?.sightRange ?? 6;
    const range = world.isDaylight ? full : Math.floor(full / 2);
    const out: Observation[] = [
      { sense: 'basic.sight', kind: 'light', summary: world.isDaylight ? 'it is light' : 'it is dark', salience: 0.3, features: { daylight: world.isDaylight ? 1 : 0 } },
    ];
    for (const e of world.entities()) {
      if (e.id === self.id) continue;
      const d = world.distanceTo(e, self.pos);
      if (d > range || !lineOfSight(world.grid, self.pos, e.pos)) continue;
      const held = e.heldBy === self.id ? ', in your grippers' : '';
      // Schema-2 objects are seen as their appearance texts and ready products, never numbers.
      const o = e.kind === 'object' ? (e as WorldObject) : undefined;
      const looks = o?.appearance?.length ? `: ${o.appearance.join('; ')}` : '';
      const ready = (o?.products ?? []).filter((p) => p.ready > 0).map(productPhrase);
      const prods = ready.length ? `, ${ready.join(', ')}` : '';
      out.push({
        sense: 'basic.sight',
        subjectId: e.id,
        kind: 'seen',
        // The mailbox flag is visible; what it means is for the robot to find out.
        summary: `a ${perceivedType(e)}${e.type === 'mailbox' && Number(e.state.waiting) > 0 ? ' with its flag up' : ''}${looks}${prods}${held}, ${d === 0 ? 'right here' : `${d} tiles ${direction(self.pos, e.pos)}`}`,
        affordances: world.verbsFor(e),
        salience: e.kind === 'character' ? 0.4 : 0.2,
        features: { distance: d, dx: e.pos.x - self.pos.x, dy: e.pos.y - self.pos.y },
      });
    }
    return out;
  },
};

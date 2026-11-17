import { manhattan, terrainAt, type Observation, type Sense } from '@uas/core';
import { between, direction, lineOfSight } from './geometry.ts';

/** Hearing: vocalize notes and loud objects; volume falls off with distance and `soundDamping`. */
export const hearing: Sense = {
  id: 'basic.hearing',
  observe(self, world) {
    const range = world.archetype(self.type)?.hearingRange ?? 8;
    const out: Observation[] = [];
    for (const s of world.sounds()) {
      if (s.sourceId === self.id) continue;
      const d = manhattan(self.pos, s.pos);
      if (d > range) continue;
      const damping = between(self.pos, s.pos).reduce((v, p) => v * (1 - (terrainAt(world.grid, p)?.soundDamping ?? 0)), 1);
      const volume = s.loudness * (1 - d / (range + 1)) * damping;
      if (volume < 0.05) continue;
      const src = world.entity(s.sourceId);
      const seen = src && lineOfSight(world.grid, self.pos, s.pos);
      const what = s.notes ? s.notes.join(' ') : `a loud ${seen ? src.type : 'sound'}`;
      out.push({
        sense: 'basic.hearing',
        kind: 'heard',
        ...(seen && { subjectId: s.sourceId }),
        summary: `heard ${what} from ${direction(self.pos, s.pos)}`,
        salience: Math.min(1, 0.4 + volume * 0.5),
        features: { volume, dx: s.pos.x - self.pos.x, dy: s.pos.y - self.pos.y },
      });
    }
    return out;
  },
};

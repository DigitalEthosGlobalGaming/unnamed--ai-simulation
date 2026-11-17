import type { EffectHandler } from '@uas/core';

const num = (v: unknown, def: number) => (typeof v === 'number' ? v : def);

/** Solar pad: only charges in daylight. The robot is not told this. */
export const charge: EffectHandler = ({ world, params }) =>
  world.isDaylight
    ? { ok: true, needDeltas: { energy: num(params.gain, 0.15) }, observation: 'warm light hummed through the pad' }
    : { ok: true, observation: 'the pad stayed dark and cold' };

/** Dock: a slow trickle charge and a chance to cool down. Used by both `dock` and `rest`. */
export const dock: EffectHandler = ({ params }) => ({
  ok: true,
  needDeltas: { energy: num(params.energy, 0.02), cool: num(params.cool, 0.05) },
  observation: 'the dock clicked and hummed quietly',
});

import type { EffectHandler } from '@uas/core';

const num = (v: unknown, def: number) => (typeof v === 'number' ? v : def);

/**
 * Solar pad: since iteration 2 it charges nothing (only sleep recharges); it still hums by day.
 * Removed with all charging in Stage 2.
 */
export const charge: EffectHandler = ({ world }) =>
  world.isDaylight ? { ok: true, observation: 'warm light hummed through the pad' } : { ok: true, observation: 'the pad stayed dark and cold' };

/** Dock: home, rest and a chance to cool down (no charging since iteration 2). Used by both `dock` and `rest`. */
export const dock: EffectHandler = ({ params }) => ({
  ok: true,
  needDeltas: { cool: num(params.cool, 0.05) },
  observation: 'the dock clicked and hummed quietly',
});

import type { EffectHandler } from '@uas/core';

const num = (v: unknown, def: number) => (typeof v === 'number' ? v : def);

/** Dock: home, rest and a chance to cool down (no charging since iteration 2). Used by both `dock` and `rest`. */
export const dock: EffectHandler = ({ params }) => ({
  ok: true,
  needDeltas: { cool: num(params.cool, 0.05) },
  observation: 'the dock clicked and hummed quietly',
});

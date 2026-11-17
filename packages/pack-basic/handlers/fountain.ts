import type { EffectHandler } from '@uas/core';

export const rinse: EffectHandler = ({ target }) =>
  target.state.flowing
    ? { ok: true, needDeltas: { cool: 0.25 }, observation: 'the water was cold' }
    : { ok: false, reason: 'the fountain is dry', observation: 'nothing came out' };

/** Fun, but water in the joints costs a little battery. */
export const splash: EffectHandler = ({ target }) =>
  target.state.flowing
    ? { ok: true, needDeltas: { curiosity: 0.12, cool: 0.05, energy: -0.03 }, observation: 'water sprayed everywhere and your circuits fizzed' }
    : { ok: false, reason: 'the fountain is dry', observation: 'nothing came out' };

import { perceivedType, productPhrase, type EffectHandler, type WorldObject } from '@uas/core';

/** `scan`: describes what is visible about the object, never what its verbs do. */
export const inspect: EffectHandler = ({ target }) => {
  // Airdrops are known only by their tags: no names, descriptions or behaviours.
  if (target.type === 'airdrop') return { ok: true, needDeltas: { curiosity: 0.03 }, observation: `a ${perceivedType(target)}` };
  // What it looks like (appearance texts) and what it offers, never state numbers.
  const o = target as WorldObject;
  const facts = [...(o.appearance ?? []), ...(o.products ?? []).filter((p) => p.ready > 0).map(productPhrase)];
  const tags = target.tags.length ? ` (${target.tags.join(', ')})` : '';
  return {
    ok: true,
    needDeltas: { curiosity: 0.03 },
    observation: `a ${target.type}${tags}${facts.length ? `; ${facts.join(', ')}` : ''}`,
  };
};

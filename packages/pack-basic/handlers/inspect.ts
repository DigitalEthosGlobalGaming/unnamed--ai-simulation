import { perceivedType, type EffectHandler } from '@uas/core';

/** `scan`: describes what is visible about the object, never what its verbs do. */
export const inspect: EffectHandler = ({ target }) => {
  // Airdrops are known only by their tags: no names, descriptions or behaviours.
  if (target.type === 'airdrop') return { ok: true, needDeltas: { curiosity: 0.03 }, observation: `a ${perceivedType(target)}` };
  const facts = Object.entries(target.state)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${String(v)}`);
  const tags = target.tags.length ? ` (${target.tags.join(', ')})` : '';
  return {
    ok: true,
    needDeltas: { curiosity: 0.03 },
    observation: `a ${target.type}${tags}${facts.length ? `; ${facts.join(', ')}` : ''}`,
  };
};

import type { EffectHandler } from '@uas/core';

const KEYS = ['C', 'D', 'E', 'G'] as const;

export const play: EffectHandler = ({ world, target }) => ({
  ok: true,
  needDeltas: { curiosity: 0.1, signal: 0.02 },
  stateChanges: [{ id: target.id, set: { lastPlayedTick: world.tick } }],
  observation: 'a tumble of notes rang out',
});

export const press: EffectHandler = ({ rng, target }) => {
  const key = rng.pick(KEYS);
  return {
    ok: true,
    needDeltas: { curiosity: 0.02 },
    stateChanges: [{ id: target.id, set: { lastKey: key } }],
    observation: `a single ${key} rang out`,
  };
};

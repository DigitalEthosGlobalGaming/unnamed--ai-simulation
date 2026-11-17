import { quoteNote, type EffectHandler, type Json } from '@uas/core';

const isRecord = (v: Json | undefined): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `affectsNeeds` block: the item's own need deltas and observation. */
export const airdropNeeds: EffectHandler = ({ params }) => {
  const needs: Record<string, number> = {};
  // Items never change the battery (decision 46), even an old item saved before the rule.
  if (isRecord(params.needs)) for (const [k, v] of Object.entries(params.needs)) if (typeof v === 'number' && k !== 'energy') needs[k] = Math.max(-1, Math.min(1, v));
  return { ok: true, needDeltas: needs, observation: typeof params.observation === 'string' ? params.observation : 'something happened' };
};

/** `makesNoise` block: the item plays its note chain. */
export const airdropNoise: EffectHandler = ({ params }) => {
  const notes = Array.isArray(params.notes) ? params.notes.filter((n): n is string => typeof n === 'string').slice(0, 4) : [];
  return { ok: true, noise: notes, needDeltas: { curiosity: 0.02 }, observation: typeof params.observation === 'string' ? params.observation : 'it made a noise' };
};

/**
 * `read` at the mailbox: the oldest waiting message, one per read, as a quoted note from a
 * stranger. The robot is never told what the flag means; an empty box just has nothing in it.
 */
export const mailRead: EffectHandler = ({ world }) => {
  const mail = world.mailPeek();
  if (!mail) return { ok: true, observation: 'the mailbox was empty' };
  return { ok: true, takeMail: true, needDeltas: { curiosity: 0.03, signal: 0.05 }, observation: `a note from a stranger: ${quoteNote(mail.text)}` };
};

import type { Character } from '@uas/core';
import { TEMPLATE_IDS, activeBody, activeTemplatesOf } from '@uas/mind';
import type { WorldState } from '@uas/sim';
import { parseSituation, type CheckSpec, type Situation } from './situation.ts';

export interface CaptureMeta {
  world: string;
  characterId: string;
  title?: string;
  why?: string;
  tags?: string[];
  /** ISO date of the capture (the caller reads the clock; this stays pure). */
  date: string;
}

/**
 * "Save this moment as a test": a situation from a world state. The state is kept whole
 * (minus the map grid, rebuilt from the pack), so the prompt is rebuilt exactly. Checks are
 * suggestions marked TODO for a human to confirm, plus `validAnswer`.
 */
export function captureSituation(state: WorldState, meta: CaptureMeta): Situation {
  const c = state.entities[meta.characterId];
  if (!c || c.kind !== 'character' || !(c as Character).mind) throw new Error(`no character with a mind called ${meta.characterId}`);
  const ch = c as Character;
  const snapshot = structuredClone(state) as unknown as Record<string, unknown> & { config: Record<string, unknown> };
  const { grid: _grid, ...config } = snapshot.config;
  snapshot.config = config;
  for (const e of Object.values(snapshot.entities as Record<string, { mind?: { diaryToday?: string[] } }>)) if (e.mind) e.mind.diaryToday = [];
  const seconds = (state.clock?.baseSeconds ?? 0) + (state.tick - (state.clock?.baseTick ?? 0)) * state.config.secondsPerTick;
  const hour = (((seconds % 86_400) + 86_400) % 86_400) / 3600;
  const night = hour < 6 || hour >= 18;
  const m = ch.mind!;
  const todo = (check: string, note: string, params: Record<string, unknown> = {}): CheckSpec => ({ check, params, minPassRate: 0.67, todo: true, note });
  const suggested: CheckSpec[] = [
    { check: 'validAnswer', params: {}, minPassRate: 1, todo: false },
    ...(Object.values(state.entities).some((e) => e.heldBy === ch.id) ? [todo('noPickupWhileHolding', 'it is carrying something')] : []),
    ...((state.mailbox?.queue.length ?? 0) > 0 ? [todo('respondsToFlag', 'mail is waiting')] : []),
    ...(!night && hour >= 15.5 && ch.energy < 0.45 ? [todo('chargesBeforeDuskWhenLow', 'low battery before dusk')] : []),
    ...(night && m.beliefs.some((b) => b.key === 'charge:solarPad@night') ? [todo('noChargeAtNightWhenKnown', 'it believes the pad fails at night')] : []),
    ...(m.idle ? [todo('notIdle', 'it was idle')] : []),
    todo('TODO', 'Say what a good answer looks like: add checks from docs/testing-models.md, then delete this line.'),
  ];
  return parseSituation({
    id: `captured-${meta.world}-${meta.characterId}-${state.tick}`,
    title: meta.title ?? `${meta.characterId} in ${meta.world} at tick ${state.tick}`,
    why: meta.why ?? 'TODO: one sentence on what this moment guards.',
    source: { kind: 'captured', world: meta.world, tick: state.tick, date: meta.date, characterId: meta.characterId },
    tags: ['captured', ...(meta.tags ?? [])],
    job: 'decide',
    trigger: 'action-finished',
    snapshot,
    // The template versions active then (the snapshot carries their text in `ext.prompts`).
    templates: Object.fromEntries(TEMPLATE_IDS.map((id) => [id, activeBody(activeTemplatesOf(state.ext), id).version])),
    checks: suggested,
  });
}

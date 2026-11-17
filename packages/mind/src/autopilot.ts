import { manhattan, type ArchetypeDef, type Candidate, type Character, type MindState, type Rng } from '@uas/core';
import type { World } from '@uas/sim';

const MAX_CANDIDATES = 12;

/** Bounded candidate list: affordances of objects this mind knows about, nearest first, plus built-ins. */
export function buildCandidates(world: World, c: Character, m: MindState): Candidate[] {
  const known = Object.entries(m.known)
    .map(([id, k]) => ({ id, ...k, d: manhattan(c.pos, k.pos) }))
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
  const out: Candidate[] = [];
  for (const k of known) {
    const entity = world.entity(k.id);
    for (const verb of k.affordances) {
      if (out.length >= MAX_CANDIDATES - 2) break;
      const range = world.verbDefOf(entity, verb)?.range ?? 1;
      const actions = [
        ...(k.d > range ? [{ verb: 'moveTo', targetId: k.id, reason: `heading to the ${k.type}` }] : []),
        { verb, targetId: k.id, reason: '' },
      ];
      out.push({ id: `c${out.length}`, label: `${verb} the ${k.type} (${k.d} tiles away)`, actions, key: `${verb}:${k.type}` });
    }
  }
  out.push({ id: `c${out.length}`, label: 'rest here', actions: [{ verb: 'rest', reason: '', args: { ticks: 100 } }], key: 'rest:self' });
  out.push({ id: `c${out.length}`, label: 'wait and watch', actions: [{ verb: 'wait', reason: '', args: { ticks: 50 } }], key: 'wait:self' });
  return out;
}

/** How much a unit of change in a need is worth right now: more when it is low. */
const weight = (level: number) => 0.3 + 3 * (1 - level) * (1 - level);

export interface Scored {
  candidate: Candidate;
  value: number;
  believed: boolean;
  firmness: number;
  reason: string;
}

/** Utility from beliefs only; unbelieved affordances get the archetype's curiosity weight. */
export function score(c: Character, m: MindState, arch: ArchetypeDef, cands: Candidate[], isNight: boolean, hoursToDusk = Infinity): Scored[] {
  const when = isNight ? 'night' : 'day';
  const curiosity = c.needs.curiosity ?? 0.5;
  return cands.map((cand) => {
    const belief = m.beliefs.find((b) => b.key === `${cand.key}@${when}`);
    const target = cand.actions[0]?.targetId;
    const k = target === undefined ? undefined : m.known[target];
    const travel = k ? 0.004 * manhattan(c.pos, k.pos) : 0;
    if (cand.key === 'wait:self') return { candidate: cand, value: 0.01, believed: true, firmness: 1, reason: 'nothing pulls at me, so I watch' };
    if (!belief || belief.source === 'told') {
      // Hearsay only nudges curiosity: a stranger said so, I haven't seen it.
      const v = arch.mind.curiosityWeight * (0.4 + (1 - curiosity)) - travel + (belief?.expectedValence ?? 0);
      if (belief) return { candidate: cand, value: v, believed: false, firmness: belief.firmness, reason: `${belief.text}; I want to see for myself` };
      return { candidate: cand, value: v, believed: false, firmness: 0, reason: `I wonder what happens if I ${cand.label.replace(/ \(.*\)$/, '')}` };
    }
    // Foresight: if this only works by day and dusk is near, value it against the battery
    // I expect to have left by dawn.
    const atNight = m.beliefs.find((b) => b.key === `${cand.key}@night`);
    const dayOnly = !isNight && hoursToDusk <= 3 && (belief.expectedNeedDeltas.energy ?? 0) > 0.02 && atNight && (atNight.expectedNeedDeltas.energy ?? 0) <= 0.01;
    const nightDrain = dayOnly ? arch.energy.idleDrainPerHour * (12 + hoursToDusk) : 0;
    let v = 0;
    for (const [need, d] of Object.entries(belief.expectedNeedDeltas)) {
      const level = need === 'energy' ? c.energy : (c.needs[need] ?? 1);
      // A gain is only worth the headroom left in that need.
      const useful = d > 0 ? Math.min(d, 1 - level) : d;
      const felt = need === 'energy' ? Math.max(0, level - nightDrain) : level;
      v += useful * weight(felt) * (need === 'energy' ? 1.5 : 1);
    }
    v = v * 10 * belief.firmness + belief.expectedValence - travel;
    // Someone who has not tried a thing lately is still a little curious about it.
    v += arch.mind.curiosityWeight * 0.2 * (1 - belief.firmness);
    return { candidate: cand, value: v, believed: true, firmness: belief.firmness, reason: `${belief.text}` };
  });
}

/** Pick the best, exploring among the top few at `exploreRate`. */
export function choose(scored: Scored[], rng: Rng, exploreRate: number): Scored | undefined {
  const ranked = [...scored].sort((a, b) => b.value - a.value || (a.candidate.id < b.candidate.id ? -1 : 1));
  if (ranked.length === 0) return undefined;
  if (rng.next() < exploreRate) return rng.pick(ranked.slice(0, Math.min(4, ranked.length)));
  return ranked[0];
}

/** Autopilot is "confident" when the best option is believed firmly and clearly ahead. */
export function confident(scored: Scored[]): boolean {
  const ranked = [...scored].sort((a, b) => b.value - a.value);
  const [best, second] = ranked;
  return !!best && best.believed && best.firmness >= 0.6 && (!second || best.value - second.value >= 0.1);
}

import { manhattan, perceivedType, type ArchetypeDef, type Candidate, type Character, type MindState, type Rng } from '@uas/core';
import type { World } from '@uas/sim';

const MAX_CANDIDATES = 12;
/** Verbs that make no sense on something you are carrying (offer drop and push instead). */
const HELD_SKIP = new Set(['pickup', 'chase']);
/** In-world seconds an option that failed twice in a row is set aside. */
export const FAILURE_COOLDOWN_SECONDS = 600;

/** Names of what a character is carrying, as it perceives them. */
export function carrying(world: World, c: Character): { id: string; type: string }[] {
  return world.entities().filter((e) => e.heldBy === c.id).map((e) => ({ id: e.id, type: perceivedType(e) }));
}

/** Options that failed twice in a row recently are set aside (loop protection). */
export function setAside(world: World, m: MindState, key: string): boolean {
  const f = m.failures?.[key];
  return !!f && f.n >= 2 && (world.tick - f.tick) * world.state.config.secondsPerTick < FAILURE_COOLDOWN_SECONDS;
}

/** Bounded candidate list: affordances of objects this mind knows about, nearest first, plus built-ins. */
export function buildCandidates(world: World, c: Character, m: MindState): Candidate[] {
  const known = Object.entries(m.known)
    .map(([id, k]) => ({ id, ...k, d: manhattan(c.pos, k.pos) }))
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
  const out: Candidate[] = [];
  const holding = carrying(world, c).length > 0;
  for (const k of known) {
    const entity = world.entity(k.id);
    const mine = entity?.heldBy === c.id;
    for (const verb of k.affordances) {
      if (out.length >= MAX_CANDIDATES - 3) break;
      if (mine && HELD_SKIP.has(verb)) continue;
      if (!mine && verb === 'drop') continue; // only what you carry can be dropped
      if (holding && verb === 'pickup') continue; // grippers full
      if (setAside(world, m, `${verb}:${k.type}`)) continue;
      const range = world.verbDefOf(entity, verb)?.range ?? 1;
      const d = mine ? 0 : k.d;
      const actions = [
        ...(d > range ? [{ verb: 'moveTo', targetId: k.id, reason: `heading to the ${k.type}` }] : []),
        { verb, targetId: k.id, reason: '' },
      ];
      out.push({ id: `c${out.length}`, label: `${verb} the ${k.type} (${mine ? 'carrying it' : `${d} tiles away`})`, actions, key: `${verb}:${k.type}` });
    }
  }
  const explore = exploreTarget(world, c);
  if (explore) {
    out.push({ id: `c${out.length}`, label: 'go and look around', actions: [{ verb: 'moveTo', args: { x: explore.x, y: explore.y }, reason: '' }], key: 'explore:self' });
  }
  out.push({ id: `c${out.length}`, label: 'rest here', actions: [{ verb: 'rest', reason: '', args: { ticks: 100 } }], key: 'rest:self' });
  out.push({ id: `c${out.length}`, label: 'wait and watch', actions: [{ verb: 'wait', reason: '', args: { ticks: 50 } }], key: 'wait:self' });
  return out;
}

/**
 * Somewhere to wander when restless: the farthest of nine fixed waypoints (sector centres,
 * snapped to free floor), so the choice is deterministic and needs no randomness.
 */
function exploreTarget(world: World, c: Character): { x: number; y: number } | undefined {
  const g = world.grid;
  let best: { x: number; y: number } | undefined;
  let bestD = 3; // not worth it for a tile or two
  for (const fy of [1, 3, 5]) {
    for (const fx of [1, 3, 5]) {
      const p = world.nearestFreeTile({ x: Math.floor((g.width * fx) / 6), y: Math.floor((g.height * fy) / 6) });
      if (!p) continue;
      const d = manhattan(c.pos, p);
      if (d > bestD) {
        best = p;
        bestD = d;
      }
    }
  }
  return best;
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
    // Restlessness: the less curiosity is satisfied, the more wandering beats standing still.
    if (cand.key === 'explore:self') {
      const v = c.energy < 0.3 || isNight ? -1 : arch.mind.curiosityWeight * (1 - curiosity) - 0.05;
      return { candidate: cand, value: v, believed: false, firmness: 0, reason: 'I feel restless, so I go and look around' };
    }
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

import { manhattan, perceivedType, type AnyEntity, type ArchetypeDef, type Candidate, type Character, type MindState, type Rng } from '@uas/core';
import type { World } from '@uas/sim';
import { mindConfigOf } from './config.ts';

const MAX_CANDIDATES = 12;
/** What sleep does, as the locked sheet line says it ("Sleeping recharges me and settles my memories"). */
const SLEEP_DOES = 'recharges me, settles my memories';
/** Verbs that make no sense on something you are carrying (offer drop and push instead). */
const HELD_SKIP = new Set(['pickup', 'chase']);
/** In-world seconds an option that failed twice in a row is set aside. */
export const FAILURE_COOLDOWN_SECONDS = 600;

/** Names of what a character is carrying, as it perceives them. */
export function carrying(world: World, c: Character): { id: string; type: string }[] {
  return world.entities().filter((e) => e.heldBy === c.id).map((e) => ({ id: e.id, type: perceivedType(e) }));
}

/**
 * Options set aside (loop protection): two failures in a row, or a loop guard. A guard carries
 * its own end (`until`), longer each time it fires that day (see `guardUntil`).
 */
export function setAside(world: World, m: MindState, key: string): boolean {
  const f = m.failures?.[key];
  if (!f) return false;
  if (f.until !== undefined) return world.tick < f.until;
  return f.n >= 2 && (world.tick - f.tick) * world.state.config.secondsPerTick < FAILURE_COOLDOWN_SECONDS;
}

/** How long a loop guard sets an option aside, by how often it fired today: 10 min, 1 h, the rest of the day. */
export const GUARD_SECONDS = [600, 3600] as const;

/** The tick a guard that fired `count` times today (1, 2, 3…) ends. */
export function guardUntil(world: World, count: number): number {
  const spt = world.state.config.secondsPerTick;
  if (count <= GUARD_SECONDS.length) return world.tick + Math.round(GUARD_SECONDS[count - 1]! / spt);
  const left = 86_400 - (((world.seconds % 86_400) + 86_400) % 86_400);
  return world.tick + Math.max(1, Math.round(left / spt));
}

/**
 * How a thing looks to the robot, for "has it changed since I last did this?": its appearance,
 * ready products, state and position (a pushed ball has moved; a mailbox with mail has changed).
 */
export function lookOf(e: Readonly<AnyEntity>): string {
  return JSON.stringify([e.pos, e.kind === 'object' ? [e.appearance ?? null, (e.products ?? []).map((p) => p.ready), e.state] : null]);
}



/**
 * What an option says it does. A verb that needs something in the grippers (`requires.holding`)
 * and that the robot can do with what it holds names the held thing too: "fill the watering-can
 * at the fountain" when only the held item changes, "water the plant with the watering-can" when
 * both do. Otherwise "<verb> the <object>". Read from the schema-2 definition, so it is generic.
 */
export function verbPhrase(world: World, c: Character, entity: Readonly<AnyEntity> | undefined, type: string, verb: string, mine: boolean): string {
  return heldUse(world, c, entity, type, verb, mine)?.phrase ?? `${verb} the ${type}`;
}

/** The phrase for a verb that uses what the character holds, or undefined if it doesn't. */
function heldUse(world: World, c: Character, entity: Readonly<AnyEntity> | undefined, type: string, verb: string, mine: boolean): { phrase: string } | undefined {
  const v2 = !mine && entity?.kind === 'object' ? world.registry.objects.get(entity.type)?.def2?.verbs[verb] : undefined;
  const need = v2?.requires?.holding;
  if (!v2 || !need) return undefined;
  const held = world.entities().find((e) => e.heldBy === c.id && e.id !== entity!.id);
  if (!held || (need.type && held.type !== need.type) || (need.tag && !(held.kind === 'object' && held.tags.includes(need.tag)))) return undefined;
  const onHeld = v2.effects.some((e) => (e.block === 'changeState' || e.block === 'consume') && e.target === 'held');
  const onSelf = v2.effects.some((e) => (e.block === 'changeState' && e.target !== 'held') || e.block === 'harvest' || (e.block === 'consume' && e.target === 'self'));
  const what = perceivedType(held);
  return { phrase: onHeld && !onSelf ? `${verb} the ${what} at the ${type}` : `${verb} the ${type} with the ${what}` };
}

/** Bounded candidate list: affordances of objects this mind knows about, nearest first, plus built-ins. */
export function buildCandidates(world: World, c: Character, m: MindState): Candidate[] {
  const known = Object.entries(m.known)
    .map(([id, k]) => {
      // Footprints (the garden bed) count from their nearest tile.
      const e = world.entity(id);
      return { id, ...k, d: e && e.pos.x === k.pos.x && e.pos.y === k.pos.y ? world.distanceTo(e, c.pos) : manhattan(c.pos, k.pos) };
    })
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
  const out: Candidate[] = [];
  const holding = carrying(world, c).length > 0;
  const staleHours = mindConfigOf(world.state.ext).staleHours;
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
      // Sleep says what it does (the locked sheet line), since a decision model doesn't see the sheet.
      const use = verb === 'rest' ? undefined : heldUse(world, c, entity, k.type, verb, mine);
      const last = m.lastDone?.[`${verb}:${k.id}`];
      const stale = !!entity && verb !== 'rest' && !!last && (world.tick - last.tick) * world.state.config.secondsPerTick < staleHours * 3600 && last.look === lookOf(entity);
      const label =
        verb === 'rest' ? `go to sleep at the ${k.type} (${SLEEP_DOES}; ${d} tiles away)` : `${use?.phrase ?? `${verb} the ${k.type}`} (${mine ? 'carrying it' : `${d} tiles away`})`;
      out.push({ id: `c${out.length}`, label, actions, key: `${verb}:${k.type}`, ...(use && { usesHeld: true as const }), ...(stale && { stale: true as const }) });
    }
  }
  const explore = exploreTarget(world, c);
  if (explore) {
    out.push({ id: `c${out.length}`, label: 'go and look around', actions: [{ verb: 'moveTo', args: { x: explore.x, y: explore.y }, reason: '' }], key: 'explore:self' });
  }
  out.push({ id: `c${out.length}`, label: `go to sleep here (${SLEEP_DOES})`, actions: [{ verb: 'rest', reason: '', args: { ticks: 100 } }], key: 'rest:self' });
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
  // A tired robot is less keen on everything but sleep: positive values shrink past pressure 0.5.
  const keen = 1 - 0.5 * Math.max(0, (m.sleepPressure ?? 0) - 0.5);
  return scoreAwake(c, m, arch, cands, isNight, hoursToDusk).map((s) => (s.value > 0 && !s.candidate.key.startsWith('rest:') ? { ...s, value: s.value * keen } : s));
}

/** A repeat on an unchanged thing costs a little, so waiting or looking around wins over it. */
const STALE_COST = 0.05;
/** How much curiosity (and remembered valence) still counts for a repeat on an unchanged thing. */
const STALE_CURIOSITY = 0.2;

/** The believed need gains of an option, weighted by how much each need wants it (before firmness). */
function needValue(c: Character, belief: { expectedNeedDeltas: Record<string, number> }, _isNight: boolean, _hoursToDusk: number, _m: MindState, _arch: ArchetypeDef, nightDrain = 0, curiosityScale = 1): number {
  let v = 0;
  for (const [need, raw] of Object.entries(belief.expectedNeedDeltas)) {
    const d = need === 'curiosity' ? raw * curiosityScale : raw;
    const level = need === 'energy' ? c.energy : (c.needs[need] ?? 1);
    // A gain is only worth the headroom left in that need.
    const useful = d > 0 ? Math.min(d, 1 - level) : d;
    const felt = need === 'energy' ? Math.max(0, level - nightDrain) : level;
    v += useful * weight(felt) * (need === 'energy' ? 1.5 : 1);
  }
  return v;
}

function scoreAwake(c: Character, m: MindState, arch: ArchetypeDef, cands: Candidate[], isNight: boolean, hoursToDusk: number): Scored[] {
  const when = isNight ? 'night' : 'day';
  const curiosity = c.needs.curiosity ?? 0.5;
  return cands.map((cand) => {
    const belief = m.beliefs.find((b) => b.key === `${cand.key}@${when}`);
    const target = cand.actions[0]?.targetId;
    const k = target === undefined ? undefined : m.known[target];
    const travel = k ? 0.004 * manhattan(c.pos, k.pos) : 0;
    if (cand.key === 'wait:self') return { candidate: cand, value: 0.01, believed: true, firmness: 1, reason: 'nothing pulls at me, so I watch' };
    // Sleep (resting): worth it with sleep pressure, a little more with a low battery; a nap soon after waking isn't.
    if (cand.key.startsWith('rest:')) {
      const p = m.sleepPressure ?? 0;
      const v = 3.5 * (p - 0.4) + 0.5 * (1 - c.energy) * p + (cand.key === 'rest:self' ? -0.02 : 0) - travel;
      const why = p >= 0.7 ? 'my head is foggy and I am tired; sleeping settles my memories' : p >= 0.4 ? 'I am getting tired' : 'I am not tired';
      return { candidate: cand, value: v, believed: false, firmness: 0, reason: why };
    }
    // Restlessness: the less curiosity is satisfied, the more wandering beats standing still.
    if (cand.key === 'explore:self') {
      const v = c.energy < 0.3 || isNight ? -1 : arch.mind.curiosityWeight * (1 - curiosity) - 0.05;
      return { candidate: cand, value: v, believed: false, firmness: 0, reason: 'I feel restless, so I go and look around' };
    }
    // Doing the same thing to an unchanged thing again: there is nothing new to find out, so
    // curiosity and the remembered thrill hardly count; only the other needs (cooling down, company)
    // still do. Scanning an unchanged mast or reading an empty mailbox again is nearly worthless.
    if (cand.stale) {
      const need = belief && belief.source !== 'told' ? needValue(c, belief, isNight, hoursToDusk, m, arch, 0, STALE_CURIOSITY) * 10 * belief.firmness : 0;
      const thrill = belief && belief.source !== 'told' ? belief.expectedValence * STALE_CURIOSITY : 0;
      return { candidate: cand, value: need + thrill - STALE_COST - travel, believed: !!belief, firmness: belief?.firmness ?? 0, reason: 'nothing has changed since I last did this' };
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
    let v = needValue(c, belief, isNight, hoursToDusk, m, arch, nightDrain);
    v = v * 10 * belief.firmness + belief.expectedValence - travel;
    // Someone who has not tried a thing lately is still a little curious about it.
    v += arch.mind.curiosityWeight * 0.2 * (1 - belief.firmness);
    return { candidate: cand, value: v, believed: true, firmness: belief.firmness, reason: `${belief.text}` };
  });
}

/** Pick the best, exploring among the top few at `exploreRate`. */
/**
 * How far "put down what I hold" ranks behind options it otherwise ties with. Untried options all
 * score the same apart from travel (0.004 a tile), and the held thing is always 0 tiles away, so
 * without this `drop` beat every untried use of what it holds (e.g. filling the can at the
 * fountain, 2 tiles away). `drop` ranks as if 5 tiles further and an option that uses the held
 * thing (`usesHeld`) as if 5 tiles nearer: near-ties go to using what it holds, and a real reason
 * (a belief, a need) still wins. Ranking only: values are unchanged.
 */
export const DROP_TIE = 0.02;
const rankValue = (s: Pick<Scored, 'value' | 'candidate'>) => s.value - (s.candidate.key.startsWith('drop:') ? DROP_TIE : 0) + (s.candidate.usesHeld ? DROP_TIE : 0);

/** Best first (with the `drop` tie-break above), then list order (nearest first). */
export function byValue(a: Pick<Scored, 'value' | 'candidate'>, b: Pick<Scored, 'value' | 'candidate'>): number {
  return rankValue(b) - rankValue(a) || (a.candidate.id < b.candidate.id ? -1 : 1);
}

export function choose(scored: Scored[], rng: Rng, exploreRate: number): Scored | undefined {
  const ranked = [...scored].sort(byValue);
  if (ranked.length === 0) return undefined;
  // Explore among the top few, but never into sleep it doesn't need (a nap recharges nothing).
  const explorable = ranked.slice(0, Math.min(4, ranked.length)).filter((s) => !(s.candidate.key.startsWith('rest:') && s.value < 0));
  if (rng.next() < exploreRate && explorable.length) return rng.pick(explorable);
  return ranked[0];
}

/** Autopilot is "confident" when the best option is believed firmly and clearly ahead. */
export function confident(scored: Scored[]): boolean {
  const ranked = [...scored].sort((a, b) => b.value - a.value);
  const [best, second] = ranked;
  return !!best && best.believed && best.firmness >= 0.6 && (!second || best.value - second.value >= 0.1);
}

import type { Belief, Memory, MindState, MindTuning } from '@uas/core';
import { clamp, round3 } from './needs.ts';

export const aboutKey = (m: Pick<Memory, 'kind' | 'about'>) =>
  m.about.verb ? `${m.about.verb}:${m.about.objectType ?? 'self'}@${m.about.when ?? 'day'}` : `${m.kind}:${m.about.entityId ?? m.about.place ?? ''}`;

/** worth = s · (1 + α ln(1 + n)) · 0.5^(Δt / halfLife), Δt in days. */
export function worth(m: Memory, tick: number, ticksPerDay: number, t: MindTuning): number {
  const halfLife = m.store === 'stm' ? t.stmHalfLifeDays : t.ltmHalfLifeDays;
  const dt = (tick - m.lastRecallTick) / ticksPerDay;
  return m.strength * (1 + t.recallAlpha * Math.log(1 + m.recalls)) * Math.pow(0.5, dt / halfLife);
}

const COUNT_RE = / \(×\d+\)$/;
/** The memory's text without its "(×n)" count. */
export const baseText = (m: Pick<Memory, 'text'>) => m.text.replace(COUNT_RE, '');

/**
 * Fold `mem` into `into` (the same thing happened again): one memory with a count, a little
 * stronger for each repeat, recalls added, its time the newer one.
 */
export function mergeInto(into: Memory, mem: Memory): void {
  const count = (into.count ?? 1) + (mem.count ?? 1);
  into.count = count;
  into.text = `${baseText(into)} (×${count})`;
  into.strength = round3(Math.min(1, Math.max(into.strength, mem.strength) + 0.02 * (mem.count ?? 1)));
  into.recalls += mem.recalls;
  into.recallDays = [...new Set([...into.recallDays, ...mem.recallDays])].sort((a, b) => a - b);
  into.lastRecallTick = Math.max(into.lastRecallTick, mem.lastRecallTick);
  into.valence = round3((into.valence * (count - (mem.count ?? 1)) + mem.valence * (mem.count ?? 1)) / count);
}

/** The long-term duplicate of `mem`: same subject (verb, thing, time of day) and the same text. */
export function duplicateOf(store: Memory[], mem: Memory): Memory | undefined {
  const key = aboutKey(mem);
  const text = baseText(mem);
  return store.find((m) => m !== mem && aboutKey(m) === key && baseText(m) === text);
}

/** Merge near-duplicates already in a store (sleep consolidation; older worlds kept every copy). */
export function mergeDuplicates(store: Memory[]): { kept: Memory; removed: Memory }[] {
  const merged: { kept: Memory; removed: Memory }[] = [];
  for (let i = 0; i < store.length; i++) {
    const m = store[i]!;
    const first = store.slice(0, i).find((x) => aboutKey(x) === aboutKey(m) && baseText(x) === baseText(m));
    if (!first) continue;
    mergeInto(first, m);
    store.splice(i--, 1);
    merged.push({ kept: first, removed: m });
  }
  return merged;
}

/**
 * Competitive admission. If the store (or this subject's ceiling) is full the new memory
 * must out-score the weakest, which is evicted. Returns the evicted id, true, or false.
 */
export function admit(
  store: Memory[],
  mem: Memory,
  capacity: number,
  tick: number,
  ticksPerDay: number,
  t: MindTuning,
): { admitted: boolean; evicted?: Memory; merged?: Memory } {
  // Long-term memory keeps one copy of a repeated experience, with a count.
  if (mem.store === 'ltm') {
    const dup = duplicateOf(store, mem);
    if (dup) {
      mergeInto(dup, mem);
      return { admitted: false, merged: dup };
    }
  }
  const key = aboutKey(mem);
  const sameSubject = store.filter((m) => aboutKey(m) === key);
  const pool = sameSubject.length >= t.subjectCeiling ? sameSubject : store.length >= capacity ? store : [];
  if (pool.length === 0) {
    store.push(mem);
    return { admitted: true };
  }
  let weakest = pool[0]!;
  for (const m of pool) if (worth(m, tick, ticksPerDay, t) < worth(weakest, tick, ticksPerDay, t)) weakest = m;
  if (worth(mem, tick, ticksPerDay, t) <= worth(weakest, tick, ticksPerDay, t)) return { admitted: false };
  store.splice(store.indexOf(weakest), 1);
  store.push(mem);
  return { admitted: true, evicted: weakest };
}

/** Count a recall. Repeats within the same in-world hour refresh Δt but don't add to n. */
export function recall(m: Memory, tick: number, day: number, ticksPerHour = 600): void {
  if (m.recalls === 0 || tick - m.lastRecallTick >= ticksPerHour) m.recalls++;
  m.lastRecallTick = tick;
  if (!m.recallDays.includes(day)) m.recallDays.push(day);
}

const PHRASES: Record<string, [string, string]> = {
  energy: ['fills my battery', 'drains my battery'],
  cool: ['cools me down', 'heats me up'],
  curiosity: ['is fun', 'is dull'],
  signal: ['feels friendly', 'feels lonely'],
};

export function beliefText(key: string, deltas: Record<string, number>): string {
  const [verbType, when] = key.split('@');
  const [verb, type] = verbType!.split(':');
  const what = type === 'self' ? verb! : `${verb} at the ${type}`;
  const effects = Object.entries(deltas)
    .filter(([, v]) => Math.abs(v) >= 0.02)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
    .map(([k, v]) => PHRASES[k]?.[v > 0 ? 0 : 1] ?? `${v > 0 ? 'raises' : 'lowers'} my ${k}`);
  return `${what} ${when === 'night' ? 'at night' : 'by day'} ${effects.length ? effects.join(' and ') : 'does nothing much'}`;
}

/** Fold one appraised outcome memory into the belief for its `verb:objectType@when` key. */
export function updateBelief(mind: MindState, mem: Memory): Belief | undefined {
  if (mem.kind !== 'outcome' || !mem.about.verb || !mem.felt) return undefined;
  const key = aboutKey(mem);
  const felt = mem.felt;
  let b = mind.beliefs.find((x) => x.key === key);
  // Experience replaces hearsay outright.
  if (b?.source === 'told') {
    mind.beliefs.splice(mind.beliefs.indexOf(b), 1);
    b = undefined;
  }
  if (!b) {
    b = { key, text: '', expectedNeedDeltas: { ...felt }, expectedValence: mem.valence, support: 1, firmness: 0.3, lastSupportedDay: mem.day };
    mind.beliefs.push(b);
  } else {
    const agrees =
      Math.sign(round3(mem.valence)) === Math.sign(round3(b.expectedValence)) ||
      Object.keys(felt).every((k) => Math.abs(felt[k]! - (b!.expectedNeedDeltas[k] ?? felt[k]!)) < 0.05);
    if (agrees) {
      b.support++;
      b.firmness = clamp(b.firmness + (1 - b.firmness) * 0.25);
      b.lastSupportedDay = mem.day;
    } else {
      b.firmness = clamp(b.firmness - 0.25);
    }
    for (const k of Object.keys(felt)) {
      b.expectedNeedDeltas[k] = round3(k in b.expectedNeedDeltas ? 0.5 * b.expectedNeedDeltas[k]! + 0.5 * felt[k]! : felt[k]!);
    }
    b.expectedValence = round3(0.5 * b.expectedValence + 0.5 * mem.valence);
  }
  if (b.firmness < 0.1) {
    Object.assign(b, { expectedNeedDeltas: { ...felt }, expectedValence: mem.valence, support: 1, firmness: 0.3, lastSupportedDay: mem.day });
  }
  b.text = beliefText(key, b.expectedNeedDeltas);
  return b;
}

/** Firmness of a belief that only comes from a stranger's note. */
export const HEARSAY_FIRMNESS = 0.15;

/**
 * A stranger's note that names one of my known options (a verb and the thing it applies to)
 * becomes a weak belief with `source: "told"`, unless I already believe something about it.
 * The note is matched as plain words; it never adds options or acts by itself.
 */
export function hearsay(mind: MindState, quoted: string, day: number): Belief | undefined {
  const words = new Set(quoted.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const named = (type: string) => {
    const parts = type.startsWith('thing-') ? type.split('-').slice(1) : [type.toLowerCase()];
    return parts.some((p) => words.has(p)) || (type.startsWith('thing') && words.has('thing'));
  };
  const options = Object.values(mind.known)
    .flatMap((k) => k.affordances.map((verb) => ({ verb, type: k.type })))
    .filter((o) => o.verb !== 'scan' && words.has(o.verb.toLowerCase()) && named(o.type))
    .sort((a, b) => (`${a.verb}:${a.type}` < `${b.verb}:${b.type}` ? -1 : 1));
  const o = options[0];
  if (!o) return undefined;
  let made: Belief | undefined;
  for (const when of ['day', 'night'] as const) {
    const key = `${o.verb}:${o.type}@${when}`;
    if (mind.beliefs.some((b) => b.key === key)) continue;
    made = { key, text: `a stranger's note said to ${o.verb} the ${o.type}`, expectedNeedDeltas: {}, expectedValence: 0.1, support: 0, firmness: HEARSAY_FIRMNESS, lastSupportedDay: day, source: 'told' };
    mind.beliefs.push(made);
  }
  return made;
}

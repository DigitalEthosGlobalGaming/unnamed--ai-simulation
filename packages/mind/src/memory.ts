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
): { admitted: boolean; evicted?: Memory } {
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

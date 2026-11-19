import type { ArchetypeDef } from '@uas/core';

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** How a level feels, for prompts and interoception. */
export function feltWord(level: number): string {
  if (level < 0.1) return 'very low';
  if (level < 0.25) return 'low';
  if (level < 0.45) return 'quite low';
  if (level < 0.75) return 'okay';
  return 'good';
}

/** Threshold band for need-threshold triggers. */
export function band(level: number, low = 0.25, critical = 0.1): 'ok' | 'low' | 'critical' {
  return level < critical ? 'critical' : level < low ? 'low' : 'ok';
}

export interface DecayContext {
  hours: number;
  /** Multiplier on need decay (not on battery drain). Default 1. */
  decayMultiplier?: number;
  active: boolean;
  resting: boolean;
  nearby: boolean;
}

/** Decay and recover needs for one tick. The battery is untouched: only thinking drains it (decision 42). */
export function updateNeeds(needs: Record<string, number>, energy: number, arch: ArchetypeDef, ctx: DecayContext): number {
  for (const [name, def] of Object.entries(arch.needs)) {
    let v = needs[name] ?? 1;
    v -= def.decayPerHour * ctx.hours * (ctx.decayMultiplier ?? 1) * (ctx.active ? (def.activeDecayMultiplier ?? 1) : 1);
    if (ctx.resting) v += (def.restRecoveryPerHour ?? 0) * ctx.hours;
    if (ctx.nearby) v += (def.nearbyRecoveryPerHour ?? 0) * ctx.hours;
    needs[name] = clamp(v);
  }
  return energy;
}

/** Valence/arousal word grid. */
export function moodWord(valence: number, arousal: number): string {
  const row = valence < -0.33 ? 0 : valence < 0.33 ? 1 : 2;
  const col = arousal < 0.33 ? 0 : arousal < 0.66 ? 1 : 2;
  return [
    ['gloomy', 'unhappy', 'agitated'],
    ['sleepy', 'okay', 'restless'],
    ['content', 'happy', 'excited'],
  ][row]![col]!;
}

export function computeMood(levels: number[], bias: number, isNight: boolean, asleep = false) {
  const avg = levels.reduce((a, b) => a + b, 0) / levels.length;
  const min = Math.min(...levels);
  const valence = clamp((avg - 0.5) * 1.6 + bias, -1, 1);
  const awake = clamp(0.3 + 0.7 * (1 - min) * (1 - min) + Math.abs(bias) * 0.5 + (isNight ? -0.2 : 0.1));
  // Asleep it is calm: arousal is low whatever the day left behind.
  const arousal = asleep ? Math.min(awake, 0.2) : awake;
  return { valence: round3(valence), arousal: round3(arousal), word: moodWord(valence, arousal) };
}

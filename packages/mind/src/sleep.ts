import type { Habit, MindState, SheetEdit, SheetLine, ThinkingDepth } from '@uas/core';
import { clamp, round3 } from './needs.ts';
import type { MindConfig } from './config.ts';

/**
 * Iteration 2: the battery is the thinking budget, and sleep is the only recharge.
 * Provisional numbers (an open question in the spec), kept together so they're easy to tune.
 */
export const SLEEP = {
  /** In-world hours awake for the time part of sleep pressure to reach 1. */
  awakeHoursFull: 16,
  /** Share of sleep pressure that comes from fog (short-term-memory fullness). */
  fogWeight: 0.4,
  /** Fog is 1 after this many STM-sizes of new memories since the last sleep. */
  fogMemories: 4,
  /** Once asleep, it sleeps at least this long (in-world hours). */
  minSleepHours: 1,
  /** Battery per in-world hour asleep at pressure 1 (scaled by the current pressure). */
  rechargePerHour: 0.3,
  /** Sleep repays time awake this many times faster than it built up. */
  repayRate: 2,
  /** Wake when pressure falls below this (rested) or the battery is above `fullAbove`. */
  restedBelow: 0.05,
  fullAbove: 0.98,
  /** A full battery wakes it only once pressure is below this. */
  fullWakeBelow: 0.3,
  /** After the minimum, a trigger at least this salient wakes it. */
  strongWake: 0.9,
  /** At or above this pressure sleeping is an obvious choice (autopilot, no model): a safety net. */
  forceAt: 0.8,
  /** Awake and at least this pressure: the `drowsy` phase (display only; no forced bedtime). */
  drowsyAt: 0.7,
  /** Short-term memories kept after consolidation (none: the fog clears). */
  keepStm: 0,
  /** Maximum lines on the character sheet. */
  maxSheetLines: 8,
  /** Habits: the same good outcome on this many distinct days within `habitWindowDays`. */
  habitDays: 3,
  habitWindowDays: 7,
  maxHabits: 5,
} as const;

/**
 * Short-term-memory fullness as felt, 0..1: memories formed since the last sleep against
 * `fogMemories` × the STM size (the STM itself only keeps the strongest few, so it is always
 * nearly full; what fogs the head is how much is waiting to be settled).
 */
export const fogOf = (m: MindState, stmSize: number) => clamp((m.unsettled ?? m.stm.length) / Math.max(1, SLEEP.fogMemories * stmSize));

export function pressureOf(hoursAwake: number, fog: number): number {
  return round3(clamp((1 - SLEEP.fogWeight) * Math.min(1, Math.max(0, hoursAwake) / SLEEP.awakeHoursFull) + SLEEP.fogWeight * fog));
}

/** How tired it feels from sleep pressure (time awake and fog), as a word. */
export function tiredWord(pressure: number): string {
  if (pressure < 0.3) return 'not tired';
  if (pressure < 0.5) return 'a little tired';
  if (pressure < 0.7) return 'tired';
  if (pressure < 0.85) return 'very tired';
  return 'exhausted';
}

/** How fog feels (the robot perceives words, never numbers). */
export function fogWord(fog: number): string {
  if (fog < 0.5) return 'clear';
  if (fog < 0.75) return 'a little foggy';
  if (fog < 0.95) return 'foggy';
  return 'very foggy';
}

/** The deepest thinking the battery allows: plan model, decision model, habits, or autopilot only. */
export function allowedDepth(energy: number, cfg: MindConfig, latched: boolean): ThinkingDepth | 'none' {
  if (latched || energy < cfg.batteryHabitAbove) return 'none';
  if (energy >= cfg.batteryPlanAbove) return 'think';
  if (energy >= cfg.batteryGutAbove) return 'gut';
  return 'habit';
}

const RANK: Record<ThinkingDepth, number> = { habit: 0, gut: 1, think: 2 };
export const shallower = (a: ThinkingDepth, b: ThinkingDepth): ThinkingDepth => (RANK[a] <= RANK[b] ? a : b);

/** Patterns that went well on several distinct days recently become named habits. */
export function detectHabits(outcomeDays: Record<string, number[]>, day: number, previous: Habit[] = []): Habit[] {
  const out: Habit[] = [];
  for (const [key, days] of Object.entries(outcomeDays)) {
    const recent = days.filter((d) => d > day - SLEEP.habitWindowDays);
    if (recent.length < SLEEP.habitDays) continue;
    const [verbType, when] = key.split('@');
    const [verb, type] = verbType!.split(':');
    const old = previous.find((h) => h.key === key);
    out.push({ key, name: `${when === 'night' ? 'at night' : 'by day'} I ${verb} the ${type}`, days: recent, since: old?.since ?? day });
  }
  return out.sort((a, b) => b.days.length - a.days.length || (a.key < b.key ? -1 : 1)).slice(0, SLEEP.maxHabits);
}

/** Apply one sheet step. Locked lines never change; returns the edit as applied (op `none` if refused). */
export function applySheetEdit(
  sheet: SheetLine[],
  step: { op: 'add' | 'reword' | 'remove' | 'none'; line?: number; text?: string },
  day: number,
  tick: number,
  by: SheetEdit['by'],
  why?: string,
): { sheet: SheetLine[]; edit: SheetEdit } {
  const none = (reason: string): { sheet: SheetLine[]; edit: SheetEdit } => ({ sheet, edit: { day, tick, op: 'none', by, why: why ? `${why} (${reason})` : reason } });
  const text = step.text?.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (step.op === 'none') return none('no change');
  if (step.op === 'add') {
    if (!text) return none('nothing to add');
    if (sheet.some((l) => l.text.toLowerCase() === text.toLowerCase())) return none('already on the sheet');
    if (sheet.length >= SLEEP.maxSheetLines) return none('the sheet is full');
    return { sheet: [...sheet, { text, locked: false, source: 'self', seenDays: [day] }], edit: { day, tick, op: 'add', after: text, by, ...(why && { why }) } };
  }
  const i = (step.line ?? 0) - 1;
  const target = sheet[i];
  if (!target) return none('no such line');
  if (target.locked) return none('that line is locked');
  if (step.op === 'remove') return { sheet: sheet.filter((_, k) => k !== i), edit: { day, tick, op: 'remove', before: target.text, by, ...(why && { why }) } };
  if (!text) return none('nothing to reword it to');
  return {
    sheet: sheet.map((l, k) => (k === i ? { ...l, text, source: 'self' as const, seenDays: [day] } : l)),
    edit: { day, tick, op: 'reword', before: target.text, after: text, by, ...(why && { why }) },
  };
}

/** Archetype locked lines missing from a mind (older worlds) are added back, first. */
export function ensureLockedCore(sheet: SheetLine[], authored: { text: string; locked: boolean }[]): SheetLine[] {
  const missing = authored.filter((a) => a.locked && !sheet.some((l) => l.text === a.text)).map((a) => ({ text: a.text, locked: true, source: 'authored' as const }));
  return missing.length ? [...sheet.filter((l) => l.locked), ...missing, ...sheet.filter((l) => !l.locked)] : sheet;
}

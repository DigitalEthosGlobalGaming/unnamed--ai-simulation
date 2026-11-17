import type { WorldClock } from '../types.ts';

const nf = new Intl.NumberFormat('en-AU');

export const fmtTick = (tick: number) => nf.format(tick);

type Clock = Pick<WorldClock, 'secondsPerTick' | 'dayLengthSeconds' | 'startSecond'>;

/**
 * In-world time at a tick, from the world's own clock: seconds = startSecond + tick × secondsPerTick.
 * `day` is the server's day index plus one (sheet 1 is the first day). Daylight is 06:00–18:00.
 */
export function clockOf(tick: number, clock: Clock) {
  const seconds = clock.startSecond + tick * clock.secondsPerTick;
  const day = Math.floor(seconds / clock.dayLengthSeconds) + 1;
  const frac = (seconds % clock.dayLengthSeconds) / clock.dayLengthSeconds;
  const mins = Math.floor(frac * 24 * 60);
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  const hour = frac * 24;
  return { day, time: `${hh}:${mm}`, daylight: hour >= 6 && hour < 18 };
}

export const ticksPerDay = (clock: Clock) => clock.dayLengthSeconds / clock.secondsPerTick;

/** First tick of sheet `day` (1-based); may be negative for the first day. */
export const dayStartTick = (day: number, clock: Clock) => ((day - 1) * clock.dayLengthSeconds - clock.startSecond) / clock.secondsPerTick;

/** AUD to three significant figures (sub-cent model calls stay legible); whole cents from A$1. */
export function fmtAud(aud: number | null): string {
  if (aud === null) return '—';
  if (aud === 0) return 'A$0';
  if (aud >= 1) return `A$${aud.toFixed(2)}`;
  return `A$${Number(aud.toPrecision(3))}`;
}

/** A 0..1 fraction as a percentage; tiny non-zero values read "<0.01%" rather than "0.00%". */
export function fmtPct(v: number): string {
  const p = v * 100;
  if (p === 0) return '0%';
  if (p > 0 && p < 0.01) return '<0.01%';
  return `${p < 1 ? p.toFixed(2) : p.toFixed(1)}%`;
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;

export const TIER_LABEL: Record<string, string> = {
  'carry-on': 'Carry on',
  autopilot: 'Autopilot',
  local: 'Local',
  decision: 'Decision',
  llm: 'LLM',
  fallback: 'Fallback',
};

export const TRIGGER_LABEL: Record<string, string> = {
  sensed: 'sensed something',
  'heard-noise': 'heard a noise',
  'action-finished': 'action finished',
  'action-rejected': 'action rejected',
  'need-threshold': 'need crossed a threshold',
  'idle-timeout': 'idle',
  'woke-up': 'woke up',
  'admin-poke': 'poked by admin',
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

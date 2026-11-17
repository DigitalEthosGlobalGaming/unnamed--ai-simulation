import type { WorldClock } from '../types.ts';

const nf = new Intl.NumberFormat('en-AU');

export const fmtTick = (tick: number) => nf.format(tick);

type Clock = Pick<WorldClock, 'secondsPerTick' | 'dayLengthSeconds' | 'baseSeconds' | 'baseTick'> & { realtime?: boolean };

const secondsAt = (tick: number, c: Clock) => c.baseSeconds + (tick - c.baseTick) * c.secondsPerTick;
/** The world's first day (absolute day index at tick 0); sheets count from it. */
const firstDay = (c: Clock) => Math.floor(secondsAt(0, c) / c.dayLengthSeconds);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * In-world time at a tick: seconds = baseSeconds + (tick − baseTick) × secondsPerTick, re-based on
 * every `clock` delta. `day` counts sheets from the world's first day (sheet 1). In a real-time
 * world the seconds are local wall-clock time since the epoch, read with UTC getters, and `date`
 * is the local date. Daylight is 06:00–18:00.
 */
export function clockOf(tick: number, clock: Clock) {
  const seconds = secondsAt(tick, clock);
  const dayLen = clock.dayLengthSeconds;
  const day = Math.floor(seconds / dayLen) - firstDay(clock) + 1;
  const frac = (((seconds % dayLen) + dayLen) % dayLen) / dayLen;
  const mins = Math.floor(frac * 24 * 60);
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  const hour = frac * 24;
  let date = '';
  if (clock.realtime) {
    const d = new Date(seconds * 1000);
    date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }
  return { day, time: `${hh}:${mm}`, date, daylight: hour >= 6 && hour < 18 };
}

export const ticksPerDay = (clock: Clock) => clock.dayLengthSeconds / clock.secondsPerTick;

/** First tick of sheet `day` (1-based); may be negative for the first day. */
export const dayStartTick = (day: number, clock: Clock) =>
  clock.baseTick + ((firstDay(clock) + day - 1) * clock.dayLengthSeconds - clock.baseSeconds) / clock.secondsPerTick;

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

/** A span of in-world seconds as "3 h 20 min", "45 min" or "2 d 4 h". */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d${h ? ` ${h} h` : ''}`;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  if (m) return `${m} min`;
  return `${s} s`;
}

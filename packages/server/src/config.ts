import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { substituteEnv } from '@uas/models';

const Pos = z.union([z.tuple([z.int(), z.int()]).transform(([x, y]) => ({ x, y })), z.strictObject({ x: z.int(), y: z.int() })]);

/** The server's own IANA timezone, e.g. `Australia/Sydney` or `Europe/Berlin`. */
export const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const RawWorldFileSchema = z.strictObject({
  id: z.string().regex(/^[\w-]+$/),
  name: z.string().default(''),
  seed: z.int(),
  packs: z.array(z.string()).default(['basic']),
  /** `pack:map`, e.g. `basic:garden`. */
  map: z.string().default('basic:garden'),
  /**
   * `realtime` (default): one in-world second per real second, and the world's time of day is the
   * real local time in `timezone`. `scaled`: the world runs at `secondsPerTick × ticksPerRealSecond`
   * in-world seconds per real second from `sim.startSecond` (fast test worlds).
   */
  clock: z
    .strictObject({
      mode: z.enum(['realtime', 'scaled']).default('realtime'),
      /** IANA name; default: the server's system timezone. */
      timezone: z.string().nullish(),
      /** Re-align when the world drifts from the wall clock by more than this (real-time mode). */
      maxDriftSeconds: z.number().positive().default(30),
    })
    .prefault({}),
  /** Sim ticks per real second at timeScale 1 while a viewer is subscribed. Real-time default: 1 / secondsPerTick. */
  ticksPerRealSecond: z.number().positive().optional(),
  /** Sim ticks per real second when nobody is watching. Real-time default: the same as watched. */
  idleTicksPerRealSecond: z.number().positive().optional(),
  timeScale: z.number().min(0).default(1),
  /** Snapshot interval: in-world seconds (preferred) or ticks. */
  snapshotEverySeconds: z.number().positive().optional(),
  snapshotEveryTicks: z.int().positive().optional(),
  /** Spectators may read without a key. */
  publicRead: z.boolean().default(true),
  visitorArchetype: z.string().default('robot'),
  sim: z
    .strictObject({
      secondsPerTick: z.number().positive(),
      dayLengthSeconds: z.number().positive(),
      startSecond: z.number().min(0),
      moveTicksPerTile: z.int().positive(),
      /** Walking speed in in-world seconds per tile (preferred over moveTicksPerTile). */
      moveSecondsPerTile: z.number().positive(),
      /** Derived (accepted so a resolved config can be parsed again, e.g. for forks). */
      durationScale: z.number().positive(),
    })
    .partial()
    .default({}),
  /** Passed to the mind runtime (see `MindConfig`); `*Seconds` keys are converted to ticks. */
  mind: z.record(z.string(), z.unknown()).default({}),
  entities: z.array(z.strictObject({ id: z.string().optional(), type: z.string(), pos: Pos, state: z.record(z.string(), z.unknown()).optional() })).default([]),
  /** Model routing (see `ModelsConfig`); validated by @uas/models. `queue.staleSeconds` is converted to ticks. */
  models: z.record(z.string(), z.unknown()).default({ models: {}, jobs: {} }),
});

/** A world config with every timing resolved to ticks for the chosen clock mode. */
export type WorldFile = Omit<z.infer<typeof RawWorldFileSchema>, 'ticksPerRealSecond' | 'idleTicksPerRealSecond' | 'snapshotEveryTicks' | 'clock'> & {
  clock: { mode: 'realtime' | 'scaled'; timezone: string; maxDriftSeconds: number };
  ticksPerRealSecond: number;
  idleTicksPerRealSecond: number;
  snapshotEveryTicks: number;
  sim: { secondsPerTick: number; durationScale: number } & z.infer<typeof RawWorldFileSchema>['sim'];
};
export const WorldFileSchema = RawWorldFileSchema;

/**
 * Resolve timing defaults. Real time: 1 in-world second per tick, 1 tick per real second,
 * 2 ticks per tile. Scaled: the old fast world (2 s per tick, 5 ticks per real second watched,
 * 0.75 idle, i.e. 10× and 1.5×). Values given in seconds become ticks.
 */
function resolve(raw: z.infer<typeof RawWorldFileSchema>): WorldFile {
  const realtime = raw.clock.mode === 'realtime';
  // Real time: 4 ticks per real second at 0.25 in-world seconds per tick by default (smooth,
  // still light: models are called per decision, not per tick). Either value implies the other.
  const spt = raw.sim.secondsPerTick ?? (realtime ? 1 / (raw.ticksPerRealSecond ?? 4) : 2);
  const tps = raw.ticksPerRealSecond ?? (realtime ? 1 / spt : 5);
  if (realtime) {
    // Real time means one in-world second per real second, watched or not.
    for (const [name, rate] of [['ticksPerRealSecond', tps], ['idleTicksPerRealSecond', raw.idleTicksPerRealSecond ?? tps]] as const) {
      if (Math.abs(spt * rate - 1) > 1e-9) {
        throw new Error(`world ${raw.id}: clock.mode realtime needs sim.secondsPerTick × ${name} = 1 (got ${spt} × ${rate}); use clock.mode: scaled for a faster world`);
      }
    }
  }
  const ticks = (seconds: number) => Math.max(1, Math.round(seconds / spt));
  const mind = { ...raw.mind } as Record<string, unknown>;
  if (typeof mind.jobTimeoutSeconds === 'number') mind.jobTimeoutTicks = ticks(mind.jobTimeoutSeconds);
  delete mind.jobTimeoutSeconds;
  const vq = mind.visitorQueue as Record<string, unknown> | undefined;
  if (vq) {
    const q = { ...vq };
    if (typeof q.ttlSeconds === 'number') q.ttlTicks = ticks(q.ttlSeconds);
    if (typeof q.cooldownSeconds === 'number') q.cooldownTicks = ticks(q.cooldownSeconds);
    delete q.ttlSeconds;
    delete q.cooldownSeconds;
    mind.visitorQueue = q;
  }
  const models = { ...raw.models } as Record<string, unknown>;
  const queue = models.queue as Record<string, unknown> | undefined;
  if (queue && typeof queue.staleSeconds === 'number') {
    const { staleSeconds, ...rest } = queue;
    models.queue = { ...rest, staleTicks: ticks(staleSeconds as number) };
  }
  return {
    ...raw,
    clock: { mode: raw.clock.mode, timezone: raw.clock.timezone ?? systemTimezone(), maxDriftSeconds: raw.clock.maxDriftSeconds },
    ticksPerRealSecond: tps,
    idleTicksPerRealSecond: raw.idleTicksPerRealSecond ?? (realtime ? tps : 0.75),
    snapshotEveryTicks: raw.snapshotEveryTicks ?? (raw.snapshotEverySeconds ? ticks(raw.snapshotEverySeconds) : 1000),
    sim: {
      ...raw.sim,
      secondsPerTick: spt,
      ...(raw.sim.moveTicksPerTile === undefined && (raw.sim.moveSecondsPerTile !== undefined || realtime) && { moveTicksPerTile: ticks(raw.sim.moveSecondsPerTile ?? 0.75) }),
      // Pack durations are written for 1 s per tick; real-time worlds keep them in seconds.
      durationScale: realtime ? 1 / spt : 1,
    },
    mind,
    models,
  };
}

export function parseWorldFile(value: unknown, where = 'world config'): WorldFile {
  const r = RawWorldFileSchema.safeParse(value);
  if (!r.success) throw new Error(`${where}: ${z.prettifyError(r.error)}`);
  return resolve(r.data);
}

export function loadWorldYaml(text: string, env: Record<string, string | undefined>, where?: string): WorldFile {
  return parseWorldFile(parseYaml(substituteEnv(text, env)), where);
}

export function loadWorldsDir(dir: string, env: Record<string, string | undefined>): WorldFile[] {
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => loadWorldYaml(readFileSync(join(dir, f), 'utf8'), env, f));
}

/** Minutes east of UTC for `timezone` at `epochMs` (DST-aware), via Intl. */
export function tzOffsetMinutes(timezone: string, epochMs: number): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(epochMs))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part ?? '');
  if (!m) return 0; // "GMT" = UTC
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

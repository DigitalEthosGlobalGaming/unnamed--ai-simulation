import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { substituteEnv } from '@uas/models';

const Pos = z.union([z.tuple([z.int(), z.int()]).transform(([x, y]) => ({ x, y })), z.strictObject({ x: z.int(), y: z.int() })]);

export const WorldFileSchema = z.strictObject({
  id: z.string().regex(/^[\w-]+$/),
  name: z.string().default(''),
  seed: z.int(),
  packs: z.array(z.string()).default(['basic']),
  /** `pack:map`, e.g. `basic:garden`. */
  map: z.string().default('basic:garden'),
  /** Real-time pacing while a viewer is subscribed: sim ticks per real second at timeScale 1 (PATCH /clock changes timeScale). */
  ticksPerRealSecond: z.number().positive().default(5),
  /** Pacing when nobody is watching (fewer ticks, so fewer model calls). */
  idleTicksPerRealSecond: z.number().positive().default(0.75),
  timeScale: z.number().min(0).default(1),
  snapshotEveryTicks: z.int().positive().default(1000),
  /** Spectators may read without a key. */
  publicRead: z.boolean().default(true),
  visitorArchetype: z.string().default('robot'),
  sim: z
    .strictObject({
      secondsPerTick: z.number().positive(),
      dayLengthSeconds: z.number().positive(),
      startSecond: z.number().min(0),
      moveTicksPerTile: z.int().positive(),
    })
    .partial()
    .default({}),
  /** Passed to the mind runtime (see `MindConfig`). */
  mind: z.record(z.string(), z.unknown()).default({}),
  entities: z.array(z.strictObject({ id: z.string().optional(), type: z.string(), pos: Pos, state: z.record(z.string(), z.unknown()).optional() })).default([]),
  /** Model routing (see `ModelsConfig`); validated by @uas/models. */
  models: z.record(z.string(), z.unknown()).default({ models: {}, jobs: {} }),
});

export type WorldFile = z.infer<typeof WorldFileSchema>;

export function parseWorldFile(value: unknown, where = 'world config'): WorldFile {
  const r = WorldFileSchema.safeParse(value);
  if (!r.success) throw new Error(`${where}: ${z.prettifyError(r.error)}`);
  return r.data;
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

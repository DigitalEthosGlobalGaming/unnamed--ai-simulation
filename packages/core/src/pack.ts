import { z } from 'zod';
import { hashJson } from './json.ts';
import type { EffectHandler } from './effects.ts';
import type { Sense } from './mind-types.ts';
import { BLOCKS_HANDLER, DROP_HANDLER, PICKUP_HANDLER, compileObjectDef, validateObjectDef2, type ObjectExtras } from './objects.ts';

const json: z.ZodType<import('./json.ts').Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json)]),
);

export const VerbDefSchema = z.strictObject({
  /** Manhattan distance; 0 = same tile. */
  range: z.int().min(0),
  durationTicks: z.int().min(1),
  /** `pack.handler` name. */
  handler: z.string().regex(/^[\w-]+\.[\w-]+$/),
  params: z.record(z.string(), json).optional(),
  /** Overrides the archetype's boredomStep for this verb. */
  boredomStep: z.number().min(0).optional(),
});

export const ObjectDefSchema = z.strictObject({
  type: z.string().min(1),
  tags: z.array(z.string()).default([]),
  portable: z.boolean().default(false),
  /** Blocks movement onto its tile. */
  solid: z.boolean().default(false),
  verbs: z.record(z.string(), VerbDefSchema),
  state: z.record(z.string(), json).default({}),
});

const NeedDefSchema = z.strictObject({
  decayPerHour: z.number().min(0),
  activeDecayMultiplier: z.number().min(0).optional(),
  low: z.number().min(0).max(1).optional(),
  critical: z.number().min(0).max(1).optional(),
  /** Recovery while resting or asleep. */
  restRecoveryPerHour: z.number().min(0).optional(),
  /** Recovery while another character is in sight. */
  nearbyRecoveryPerHour: z.number().min(0).optional(),
});

/** Mind tuning; every field has a default so archetypes only override what they need. */
export const MindTuningSchema = z.strictObject({
  wakeThreshold: z.number().min(0).max(1).default(0.5),
  idleTimeoutTicks: z.int().positive().default(300),
  boredomStep: z.number().min(0).default(0.15),
  boredomHalfLifeHours: z.number().positive().default(2),
  boredomThreshold: z.number().min(0).default(0.6),
  boredomValencePenalty: z.number().min(0).default(0.2),
  curiosityWeight: z.number().min(0).default(0.3),
  exploreRate: z.number().min(0).max(1).default(0.1),
  stmSize: z.int().positive().default(12),
  ltmSize: z.int().positive().default(60),
  stmHalfLifeDays: z.number().positive().default(1),
  ltmHalfLifeDays: z.number().positive().default(90),
  recallAlpha: z.number().min(0).default(0.5),
  subjectCeiling: z.int().positive().default(4),
  sheetFadeNights: z.int().positive().default(3),
  sheetMinDays: z.int().positive().default(2),
});
export type MindTuning = z.infer<typeof MindTuningSchema>;

const SynthSchema = z.strictObject({
  wave: z.enum(['sine', 'triangle', 'square', 'sawtooth']),
  ms: z.int().positive(),
  sweep: z.number().optional(),
  vibratoHz: z.number().optional(),
  octave: z.int().optional(),
  rough: z.number().min(0).max(1).optional(),
});

const NoiseDefSchema = z.union([
  z.strictObject({ synth: SynthSchema }),
  z.strictObject({ sound: z.string().min(1) }),
]);

export const NoisesSchema = z.strictObject({
  pitches: z.record(z.string().regex(/^[A-G]$/), z.number().positive()),
  set: z.record(z.string().regex(/^[a-z]+$/), NoiseDefSchema),
  maxChain: z.int().min(1),
});

export const ArchetypeDefSchema = z.strictObject({
  type: z.string().min(1),
  tags: z.array(z.string()).default([]),
  needs: z.record(z.string(), NeedDefSchema),
  energy: z.strictObject({ label: z.string(), /** Ignored since iteration 2: only thinking drains the battery. */ idleDrainPerHour: z.number().min(0).default(0) }),
  noises: NoisesSchema.optional(),
  sightRange: z.int().positive().default(6),
  hearingRange: z.int().positive().default(8),
  /** Sense ids this archetype runs; default: every registered sense. */
  senses: z.array(z.string()).optional(),
  mind: MindTuningSchema.prefault({}),
  /** Authored character-sheet lines. */
  sheet: z.array(z.strictObject({ text: z.string().min(1), locked: z.boolean().default(false) })).default([]),
});

export const PackManifestSchema = z.strictObject({
  name: z.string().regex(/^[\w-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/, 'semver'),
  licence: z.string().min(1),
  dependencies: z.record(z.string(), z.string()).default({}),
});

export type VerbDef = z.infer<typeof VerbDefSchema>;
/** An object type in the engine's form; schema-2 objects carry their extras (state spec, rules, products, appearance). */
export type ObjectDef = z.infer<typeof ObjectDefSchema> & ObjectExtras;
export type ArchetypeDef = z.infer<typeof ArchetypeDefSchema>;
export type Noises = z.infer<typeof NoisesSchema>;
export type PackManifest = z.infer<typeof PackManifestSchema>;

export interface Pack {
  manifest: PackManifest;
  objects: ObjectDef[];
  archetypes: ArchetypeDef[];
  /** Keyed by local name; registered as `${manifest.name}.${name}`. */
  handlers: Record<string, EffectHandler>;
  senses: Sense[];
  /** Hash of the validated JSON and handler names. */
  contentHash: string;
}

export interface RawPack {
  manifest: unknown;
  objects: unknown[];
  archetypes: unknown[];
  handlers: Record<string, EffectHandler>;
  senses?: Sense[];
}

/** Validate a pack's JSON with Zod and compute its content hash. Throws with a readable message. */
export function loadPack(raw: RawPack): Pack {
  const parse = <T>(schema: z.ZodType<T>, value: unknown, where: string): T => {
    const r = schema.safeParse(value);
    if (!r.success) throw new Error(`pack ${where}: ${z.prettifyError(r.error)}`);
    return r.data;
  };
  const manifest = parse(PackManifestSchema, raw.manifest, 'pack.json');
  // Schema-2 objects (docs/architecture/objects.md) are validated and compiled; older ones parse as before.
  const objects: ObjectDef[] = raw.objects.map((o, i) => {
    if ((o as { schema?: unknown }).schema === 2) {
      const r = validateObjectDef2(o, { pack: true });
      if (!r.ok) throw new Error(`pack ${manifest.name} objects[${i}]: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      return compileObjectDef(r.def);
    }
    return parse(ObjectDefSchema, o, `${manifest.name} objects[${i}]`);
  });
  const archetypes = raw.archetypes.map((a, i) => parse(ArchetypeDefSchema, a, `${manifest.name} archetypes[${i}]`));
  // Handler source is not hashed: transpilers rewrite it differently, which would make the same
  // pack hash differently per runtime. Changing handler behaviour requires a version bump.
  const contentHash = hashJson({ manifest, objects, archetypes, handlers: Object.keys(raw.handlers).sort(), senses: (raw.senses ?? []).map((x) => x.id).sort() });
  return { manifest, objects, archetypes, handlers: raw.handlers, senses: raw.senses ?? [], contentHash };
}

export interface Registry {
  objects: ReadonlyMap<string, ObjectDef>;
  archetypes: ReadonlyMap<string, ArchetypeDef>;
  handlers: ReadonlyMap<string, EffectHandler>;
  senses: ReadonlyMap<string, Sense>;
  /** Stamped on every input event, e.g. `basic@0.1.0#ab12…`. */
  packVersions: string;
}

export function buildRegistry(packs: Pack[]): Registry {
  const objects = new Map<string, ObjectDef>();
  const archetypes = new Map<string, ArchetypeDef>();
  const handlers = new Map<string, EffectHandler>();
  const senses = new Map<string, Sense>();
  const names = new Set(packs.map((p) => p.manifest.name));
  for (const pack of packs) {
    for (const dep of Object.keys(pack.manifest.dependencies)) {
      if (!names.has(dep)) throw new Error(`pack ${pack.manifest.name} needs missing pack ${dep}`);
    }
    for (const [name, fn] of Object.entries(pack.handlers)) handlers.set(`${pack.manifest.name}.${name}`, fn);
    for (const def of [...pack.objects, ...pack.archetypes]) {
      if (objects.has(def.type) || archetypes.has(def.type)) throw new Error(`duplicate entity type ${def.type}`);
    }
    for (const sense of pack.senses) senses.set(sense.id, sense);
    for (const o of pack.objects) objects.set(o.type, o);
    for (const a of pack.archetypes) archetypes.set(a.type, a);
  }
  const builtIn = new Set([BLOCKS_HANDLER, PICKUP_HANDLER, DROP_HANDLER]);
  for (const o of objects.values()) {
    for (const [verb, v] of Object.entries(o.verbs)) {
      if (!handlers.has(v.handler) && !builtIn.has(v.handler)) throw new Error(`${o.type}.${verb}: unknown handler ${v.handler}`);
      const effects = (v.params?.effects ?? []) as { block?: string; name?: string; type?: string }[];
      for (const b of effects) {
        if (b.block === 'handler' && !handlers.has(String(b.name))) throw new Error(`${o.type}.${verb}: unknown handler ${b.name}`);
      }
    }
  }
  for (const o of objects.values()) {
    for (const [verb, v] of Object.entries(o.verbs)) {
      for (const b of (v.params?.effects ?? []) as { block?: string; type?: string }[]) {
        if (b.block === 'createObject' && !objects.has(String(b.type))) throw new Error(`${o.type}.${verb}: creates unknown type ${b.type}`);
      }
    }
    for (const p of o.products ?? []) if (!objects.has(p.item)) throw new Error(`${o.type}: product ${p.slot} is unknown type ${p.item}`);
  }
  const packVersions = [...packs]
    .map((p) => `${p.manifest.name}@${p.manifest.version}#${p.contentHash}`)
    .sort()
    .join(',');
  for (const a of archetypes.values()) {
    for (const id of a.senses ?? []) if (!senses.has(id)) throw new Error(`${a.type}: unknown sense ${id}`);
  }
  return { objects, archetypes, handlers, senses, packVersions };
}

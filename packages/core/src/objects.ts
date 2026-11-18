import { z } from 'zod';
import type { Json } from './json.ts';
import { parseIcon } from './icon.ts';

/**
 * Object schema 2 (decision 49, docs/architecture/objects.md): one schema for pack objects and
 * catalogue items. Behaviour is data: numeric state, verbs with requirements and ordered effect
 * blocks, rules over in-world time, product slots and described appearance. Conditions are plain
 * comparisons; nothing is parsed or evaluated as code.
 */

const Name = z.string().regex(/^[a-z][a-zA-Z0-9]{0,23}$/, 'a short name, e.g. "water"');
const Id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case, e.g. "watering-can"').max(48);

const Compare = z
  .strictObject({ lt: z.number().optional(), lte: z.number().optional(), gt: z.number().optional(), gte: z.number().optional(), eq: z.number().optional() })
  .refine((c) => Object.keys(c).length > 0, 'at least one of lt, lte, gt, gte, eq');
export const ConditionSchema = z.record(Name, Compare);
export type Condition = z.infer<typeof ConditionSchema>;

const Holding = z.strictObject({ type: Id.optional(), tag: z.string().optional(), state: ConditionSchema.optional() });
const Requires = z.strictObject({
  self: ConditionSchema.optional(),
  holding: Holding.optional(),
  near: z.strictObject({ tag: z.string().optional(), type: Id.optional(), range: z.int().min(0).max(12) }).optional(),
  tile: z.strictObject({ tag: z.string() }).optional(),
});

const Target = z.enum(['self', 'held', 'actor']);
const NOTE = /^[a-z]+-[A-G]$/;
export const EffectBlockSchema = z.discriminatedUnion('block', [
  z.strictObject({
    block: z.literal('changeState'),
    target: Target.default('self'),
    values: z.record(Name, z.number()).optional(),
    set: z.record(Name, z.number()).optional(),
  }),
  z.strictObject({ block: z.literal('affectNeeds'), needs: z.record(z.string(), z.number().min(-1).max(1)), observation: z.string().min(1).max(160) }),
  z.strictObject({ block: z.literal('observe'), text: z.string().min(1).max(160) }),
  z.strictObject({ block: z.literal('makeNoise'), notes: z.array(z.string().regex(NOTE, 'a note like "beep-C"')).min(1).max(4), observation: z.string().max(160).optional() }),
  z.strictObject({ block: z.literal('consume'), target: z.enum(['self', 'held']).default('self'), uses: z.int().min(1).default(1) }),
  z.strictObject({ block: z.literal('createObject'), type: Id, at: z.enum(['here', 'target', 'freeTileIn']), consumeHeld: z.boolean().default(false) }),
  z.strictObject({ block: z.literal('harvest'), slot: Name }),
  z.strictObject({ block: z.literal('handler'), name: z.string().regex(/^[\w-]+\.[\w-]+$/), params: z.record(z.string(), z.unknown()).optional() }),
]);
export type EffectBlock = z.infer<typeof EffectBlockSchema>;

export const Verb2Schema = z.strictObject({
  range: z.int().min(0).max(12).default(1),
  durationSeconds: z.number().positive().max(3600).default(5),
  requires: Requires.optional(),
  effects: z.array(EffectBlockSchema).min(1).max(8),
  fail: z.string().max(160).optional(),
  boredomStep: z.number().min(0).optional(),
});
export type Verb2 = z.infer<typeof Verb2Schema>;

const Every = z.enum(['30m', '1h', '1d']);
export const RuleSchema = z.strictObject({
  every: Every,
  when: ConditionSchema.optional(),
  change: z.record(Name, z.number()).optional(),
  /** Each character within `range` gets these need deltas per period, scaled by time in range. */
  nearby: z.strictObject({ range: z.int().min(0).max(12), needs: z.record(z.string(), z.number().min(-1).max(1)) }).optional(),
  /** Remove the object (e.g. a wilted flower) when `when` holds. */
  remove: z.literal(true).optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const ProductSchema = z.strictObject({
  slot: Name,
  item: Id,
  when: ConditionSchema.optional(),
  everyHours: z.number().positive().max(24 * 30),
  max: z.int().min(1).max(20),
  verb: Name,
  reset: z.record(Name, z.number()).optional(),
});
export type Product = z.infer<typeof ProductSchema>;

const Band = z.strictObject({ lt: z.number().optional(), lte: z.number().optional(), gt: z.number().optional(), gte: z.number().optional(), text: z.string().min(1).max(120) });
const StateSpec = z.strictObject({ initial: z.number(), min: z.number().default(0), max: z.number().default(1) });

export const DURATION2_RE = /^(\d+)(s|m|h|d)$/;
export const ObjectDef2Schema = z.strictObject({
  schema: z.literal(2),
  id: Id,
  name: z.string().min(1).max(48),
  description: z.string().max(280).default(''),
  icon: z.string().default(''),
  tags: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,23}$/, 'a short lowercase tag')).max(8).default([]),
  solid: z.boolean().default(false),
  portable: z.boolean().default(false),
  footprint: z.strictObject({ w: z.int().min(1).max(6), h: z.int().min(1).max(6) }).optional(),
  expiresAfter: z.string().regex(DURATION2_RE, 'a duration like "30m", "24h" or "7d"').nullish(),
  state: z.record(Name, StateSpec).default({}),
  verbs: z.record(Name, Verb2Schema).default({}),
  rules: z.array(RuleSchema).max(8).default([]),
  products: z.array(ProductSchema).max(4).default([]),
  appearance: z.record(Name, z.array(Band).min(1).max(8)).default({}),
});
export type ObjectDef2 = z.infer<typeof ObjectDef2Schema>;

export interface PathError {
  path: string;
  message: string;
}
export type ObjectDef2Result = { ok: true; def: ObjectDef2 } | { ok: false; errors: PathError[] };

const pathOf = (p: readonly PropertyKey[]) => p.reduce<string>((acc, k) => (typeof k === 'number' ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)), '');

/** Verbs the engine provides (portable pickup/drop) or reserves for itself. */
export const RESERVED_VERBS = ['pickup', 'drop', 'scan', 'sleep', 'read'];

/**
 * Validate a schema-2 definition with path errors. Catalogue items (`pack: false`) may not use
 * `handler` blocks or reserved verbs; nobody may touch `energy` (decision 46).
 */
export function validateObjectDef2(raw: unknown, opts: { pack?: boolean; needKeys?: readonly string[]; noiseNames?: readonly string[]; knownTypes?: readonly string[] } = {}): ObjectDef2Result {
  const r = ObjectDef2Schema.safeParse(raw);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => ({ path: pathOf(i.path), message: i.message })) };
  const def = r.data;
  const errors: PathError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  if (def.icon) {
    const icon = parseIcon(def.icon);
    if (!icon.ok) for (const e of icon.errors) err(`icon${e.path ? `.${e.path}` : ''}`, e.message);
  } else if (!opts.pack) err('icon', 'required');
  const names = new Set(Object.keys(def.state));
  for (const [k, s] of Object.entries(def.state)) {
    if (s.min > s.max) err(`state.${k}`, 'min is above max');
    if (s.initial < s.min || s.initial > s.max) err(`state.${k}.initial`, 'outside min..max');
  }
  if (names.size > 8) err('state', 'at most 8 state values');
  const checkCond = (c: Condition | undefined, path: string, known = names) => {
    for (const k of Object.keys(c ?? {})) if (!known.has(k)) err(`${path}.${k}`, 'not a state value of this object');
  };
  const checkNeeds = (needs: Record<string, number>, path: string) => {
    for (const k of Object.keys(needs)) {
      if (k === 'energy') err(`${path}.energy`, 'nothing can change the battery');
      else if (opts.needKeys && !opts.needKeys.includes(k)) err(`${path}.${k}`, `unknown need (known: ${opts.needKeys.join(', ')})`);
    }
  };
  const verbNames = Object.keys(def.verbs);
  if (verbNames.length > 8) err('verbs', 'at most 8 verbs');
  for (const [v, verb] of Object.entries(def.verbs)) {
    const p = `verbs.${v}`;
    if (RESERVED_VERBS.includes(v) && !opts.pack) err(p, `"${v}" is reserved`);
    checkCond(verb.requires?.self, `${p}.requires.self`);
    verb.effects.forEach((b, i) => {
      const bp = `${p}.effects[${i}]`;
      if (b.block === 'changeState') {
        if (b.target === 'actor') err(`${bp}.target`, 'characters change only through affectNeeds');
        if (!b.values && !b.set) err(bp, 'give values (deltas) or set (absolute)');
        if (b.target === 'self') for (const k of [...Object.keys(b.values ?? {}), ...Object.keys(b.set ?? {})]) if (!names.has(k)) err(`${bp}.${b.values && k in b.values ? 'values' : 'set'}.${k}`, 'not a state value of this object');
      }
      if (b.block === 'affectNeeds') checkNeeds(b.needs, `${bp}.needs`);
      if (b.block === 'makeNoise' && opts.noiseNames) b.notes.forEach((n, j) => !opts.noiseNames!.includes(n.split('-')[0]!) && err(`${bp}.notes[${j}]`, `unknown noise (known: ${opts.noiseNames!.join(', ')})`));
      if (b.block === 'handler' && !opts.pack) err(`${bp}.block`, 'handler blocks are for pack objects only');
      if (b.block === 'createObject' && opts.knownTypes && !opts.knownTypes.includes(b.type)) err(`${bp}.type`, 'unknown object type');
      if (b.block === 'harvest' && !def.products.some((x) => x.slot === b.slot)) err(`${bp}.slot`, 'no such product slot');
    });
  }
  def.rules.forEach((rule, i) => {
    checkCond(rule.when, `rules[${i}].when`);
    for (const k of Object.keys(rule.change ?? {})) if (!names.has(k)) err(`rules[${i}].change.${k}`, 'not a state value of this object');
    if (rule.nearby) checkNeeds(rule.nearby.needs, `rules[${i}].nearby.needs`);
    if (!rule.change && !rule.nearby && !rule.remove) err(`rules[${i}]`, 'a rule needs change, nearby or remove');
  });
  def.products.forEach((p, i) => {
    checkCond(p.when, `products[${i}].when`);
    for (const k of Object.keys(p.reset ?? {})) if (!names.has(k)) err(`products[${i}].reset.${k}`, 'not a state value of this object');
    if (def.verbs[p.verb]) err(`products[${i}].verb`, 'already a verb of this object');
    if (opts.knownTypes && !opts.knownTypes.includes(p.item) && p.item !== def.id) err(`products[${i}].item`, 'unknown object type');
  });
  for (const [k, bands] of Object.entries(def.appearance)) {
    if (!names.has(k)) err(`appearance.${k}`, 'not a state value of this object');
    bands.forEach((b, i) => {
      const bounded = b.lt !== undefined || b.lte !== undefined || b.gt !== undefined || b.gte !== undefined;
      if (!bounded && i !== bands.length - 1) err(`appearance.${k}[${i}]`, 'a band without a bound is the fallback and must be last');
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, def };
}

// ------------------------------------------------------------------ evaluation (pure)

const num = (v: Json | undefined) => (typeof v === 'number' ? v : 0);

export function checkCompare(c: z.infer<typeof Compare> | z.infer<typeof Band>, v: number): boolean {
  if (c.lt !== undefined && !(v < c.lt)) return false;
  if (c.lte !== undefined && !(v <= c.lte)) return false;
  if (c.gt !== undefined && !(v > c.gt)) return false;
  if (c.gte !== undefined && !(v >= c.gte)) return false;
  if ('eq' in c && c.eq !== undefined && v !== c.eq) return false;
  return true;
}

/** Every named value meets its comparison (missing values count as 0). */
export function checkCondition(cond: Condition | undefined, state: Record<string, Json>): boolean {
  return Object.entries(cond ?? {}).every(([k, c]) => checkCompare(c, num(state[k])));
}

/** The current appearance texts, in definition order: per value, the first band that matches. */
export function appearanceOf(def: Pick<ObjectDef2, 'appearance'>, state: Record<string, Json>): string[] {
  const out: string[] = [];
  for (const [k, bands] of Object.entries(def.appearance)) {
    const b = bands.find((x) => checkCompare(x, num(state[k])));
    if (b) out.push(b.text);
  }
  return out;
}

/** Clamp a value to a state spec. */
export const clampState = (spec: { min: number; max: number } | undefined, v: number) => (spec ? Math.min(spec.max, Math.max(spec.min, v)) : v);

/** In-world seconds of a rule period. */
export const PERIOD_SECONDS: Record<z.infer<typeof Every>, number> = { '30m': 1800, '1h': 3600, '1d': 86_400 };

/** The products' "you could …" phrase for perception, e.g. "has a flower you could pick". */
export function productPhrase(p: { item: string; ready: number; verb: string }): string {
  const item = p.item.replace(/-/g, ' ');
  return p.ready > 1 ? `has some ${item}s you could ${p.verb}` : `has a ${item} you could ${p.verb}`;
}

// ------------------------------------------------------------------ schema-1 migration

/**
 * Read-time, lossless and idempotent: a schema-1 catalogue item as schema 2. `affectsNeeds` and
 * `makesNoise` become verbs; `consumable` becomes a `uses` state value consumed by every verb;
 * `portable` stays portable; `inert` has no verbs.
 */
export function migrateToSchema2(item: Record<string, unknown>): Record<string, unknown> {
  if (item.schema === 2) return item;
  if (item.schema !== 1) return item;
  const blocks = (Array.isArray(item.behaviours) ? item.behaviours : []) as Record<string, unknown>[];
  const consumable = blocks.find((b) => b.block === 'consumable') as { uses?: number } | undefined;
  const portable = item.portable === true || blocks.some((b) => b.block === 'portable');
  const verbs: Record<string, unknown> = {};
  const consume = consumable ? [{ block: 'consume', target: 'self', uses: 1 }] : [];
  for (const b of blocks) {
    if (b.block === 'affectsNeeds') {
      const needs = Object.fromEntries(Object.entries((b.needs ?? {}) as Record<string, number>).filter(([k]) => k !== 'energy'));
      verbs[String(b.verb)] = {
        range: b.range ?? 1,
        durationSeconds: b.durationSeconds ?? 10,
        effects: [{ block: 'affectNeeds', needs, observation: b.observation ?? 'something happened' }, ...consume],
      };
    }
    if (b.block === 'makesNoise') {
      verbs[String(b.verb)] = {
        range: b.range ?? 1,
        durationSeconds: Math.max(1, 2 * (Array.isArray(b.notes) ? b.notes.length : 1)),
        effects: [{ block: 'makeNoise', notes: b.notes, ...(typeof b.observation === 'string' && { observation: b.observation }) }, ...consume],
      };
    }
  }
  return {
    schema: 2,
    id: item.id,
    name: item.name,
    description: item.description ?? '',
    icon: item.icon ?? '',
    tags: item.tags ?? [],
    portable,
    ...(item.expiresAfter !== undefined && { expiresAfter: item.expiresAfter }),
    state: consumable ? { uses: { initial: consumable.uses ?? 1, min: 0, max: consumable.uses ?? 1 } } : {},
    verbs,
  };
}

// ------------------------------------------------------------------ compiling to the engine's form

/** What the engine keeps per object type beyond verbs (schema-2 objects only). */
export interface ObjectExtras {
  name?: string;
  description?: string;
  icon?: string;
  footprint?: { w: number; h: number };
  stateSpec?: Record<string, { min: number; max: number }>;
  rules?: Rule[];
  products?: Product[];
  appearance?: ObjectDef2['appearance'];
  /** The schema-2 definition it was compiled from. */
  def2?: ObjectDef2;
}

/** Built-in handlers the engine provides for schema-2 verbs. */
export const BLOCKS_HANDLER = 'core.blocks';
export const PICKUP_HANDLER = 'core.pickup';
export const DROP_HANDLER = 'core.drop';

/**
 * A schema-2 definition in the engine's form: every verb runs `core.blocks` with its requirements
 * and effects as params; portable objects get `pickup`/`drop`; each product slot gets its verb.
 * Durations are in reference seconds (1 per tick), like pack `durationTicks`.
 */
export function compileObjectDef(def: ObjectDef2) {
  const verbs: Record<string, { range: number; durationTicks: number; handler: string; params?: Record<string, Json>; boredomStep?: number }> = {};
  for (const [name, v] of Object.entries(def.verbs)) {
    verbs[name] = {
      range: v.range,
      durationTicks: Math.max(1, Math.round(v.durationSeconds)),
      handler: BLOCKS_HANDLER,
      params: { effects: v.effects as unknown as Json, ...(v.requires && { requires: v.requires as unknown as Json }), ...(v.fail && { fail: v.fail }) },
      ...(v.boredomStep !== undefined && { boredomStep: v.boredomStep }),
    };
  }
  if (def.portable) {
    verbs.pickup ??= { range: 1, durationTicks: 3, handler: PICKUP_HANDLER };
    verbs.drop ??= { range: 0, durationTicks: 2, handler: DROP_HANDLER };
  }
  for (const p of def.products) {
    verbs[p.verb] = {
      range: 1,
      durationTicks: 3,
      handler: BLOCKS_HANDLER,
      params: { effects: [{ block: 'harvest', slot: p.slot }] as unknown as Json, ...(p.reset && { reset: p.reset as unknown as Json }) },
    };
  }
  const extras: ObjectExtras = {
    name: def.name,
    description: def.description,
    icon: def.icon,
    ...(def.footprint && { footprint: def.footprint }),
    stateSpec: Object.fromEntries(Object.entries(def.state).map(([k, s]) => [k, { min: s.min, max: s.max }])),
    rules: def.rules,
    products: def.products,
    appearance: def.appearance,
    def2: def,
  };
  return {
    type: def.id,
    tags: def.tags,
    portable: def.portable,
    solid: def.solid,
    verbs,
    state: Object.fromEntries(Object.entries(def.state).map(([k, s]) => [k, s.initial])) as Record<string, Json>,
    ...extras,
  };
}

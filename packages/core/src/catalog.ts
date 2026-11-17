import { z } from 'zod';
import type { Json } from './json.ts';
import { parseIcon } from './icon.ts';

/**
 * Catalogue items (schema 1): what visitors can airdrop. Behaviour comes only from code-defined
 * blocks; admins can't script. Shared by the server (validation) and the viewer (editor, render).
 */

const NOTE = /^[a-z]+-[A-G]$/;

const AffectsNeeds = z.strictObject({
  block: z.literal('affectsNeeds'),
  verb: z.string().regex(/^[a-z][a-zA-Z]{0,23}$/, 'a short lowercase verb, e.g. "eat"'),
  range: z.int().min(0).max(8).default(1),
  durationSeconds: z.number().positive().max(3600).default(10),
  needs: z.record(z.string(), z.number().min(-1).max(1)),
  observation: z.string().min(1).max(120),
});
const Portable = z.strictObject({ block: z.literal('portable') });
const Consumable = z.strictObject({ block: z.literal('consumable'), uses: z.int().min(1).max(1000) });
const MakesNoise = z.strictObject({
  block: z.literal('makesNoise'),
  verb: z.string().regex(/^[a-z][a-zA-Z]{0,23}$/, 'a short lowercase verb, e.g. "squeeze"'),
  range: z.int().min(0).max(8).default(1),
  notes: z.array(z.string().regex(NOTE, 'a note like "beep-C"')).min(1).max(4),
  observation: z.string().min(1).max(120).optional(),
});
const Inert = z.strictObject({ block: z.literal('inert') });
const Block = z.discriminatedUnion('block', [AffectsNeeds, Portable, Consumable, MakesNoise, Inert]);

export const DURATION_RE = /^(\d+)(s|m|h|d)$/;

export const CatalogItemSchema = z.strictObject({
  schema: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case, e.g. "battery-snack"').max(48),
  name: z.string().min(1).max(48),
  description: z.string().max(280).default(''),
  icon: z.string(),
  tags: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,23}$/, 'a short lowercase tag')).max(8).default([]),
  portable: z.boolean().default(false),
  expiresAfter: z.string().regex(DURATION_RE, 'a duration like "30m", "24h" or "7d"').optional(),
  behaviours: z.array(Block).max(8).default([]),
});

export type CatalogItem = z.infer<typeof CatalogItemSchema>;
export type CatalogBlock = z.infer<typeof Block>;
export interface CatalogError {
  path: string;
  message: string;
}
export type CatalogResult = { ok: true; item: CatalogItem } | { ok: false; errors: CatalogError[] };

const pathOf = (p: readonly PropertyKey[]) =>
  p.reduce<string>((acc, k) => (typeof k === 'number' ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)), '');

/**
 * Validate an item: schema, icon language, need keys (from the world's archetypes; never
 * `energy`) and block consistency. Errors carry paths like `behaviours[0].needs.hunger`.
 */
export function validateCatalogItem(raw: unknown, opts: { needKeys?: readonly string[]; noiseNames?: readonly string[] } = {}): CatalogResult {
  const r = CatalogItemSchema.safeParse(raw);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => ({ path: pathOf(i.path), message: i.message })) };
  const item = r.data;
  const errors: CatalogError[] = [];
  const icon = parseIcon(item.icon);
  if (!icon.ok) for (const e of icon.errors) errors.push({ path: `icon${e.path ? `.${e.path}` : ''}`, message: e.message });
  const verbs = new Map<string, number>();
  item.behaviours.forEach((b, i) => {
    if (b.block === 'affectsNeeds') {
      if (Object.keys(b.needs).length === 0) errors.push({ path: `behaviours[${i}].needs`, message: 'name at least one need' });
      // Decision 46: items can never change the battery (only sleep recharges; only admins top up).
      if ('energy' in b.needs) errors.push({ path: `behaviours[${i}].needs.energy`, message: 'items can never change the battery' });
      if (opts.needKeys) for (const k of Object.keys(b.needs)) if (k !== 'energy' && !opts.needKeys.includes(k)) errors.push({ path: `behaviours[${i}].needs.${k}`, message: `unknown need (known: ${opts.needKeys.join(', ')})` });
    }
    if (b.block === 'makesNoise' && opts.noiseNames) {
      b.notes.forEach((n, j) => {
        if (!opts.noiseNames!.includes(n.split('-')[0]!)) errors.push({ path: `behaviours[${i}].notes[${j}]`, message: `unknown noise (known: ${opts.noiseNames!.join(', ')})` });
      });
    }
    if (b.block === 'affectsNeeds' || b.block === 'makesNoise') {
      if (verbs.has(b.verb) || ['pickup', 'drop', 'scan'].includes(b.verb)) errors.push({ path: `behaviours[${i}].verb`, message: `"${b.verb}" is already used` });
      verbs.set(b.verb, i);
    }
  });
  const kinds = item.behaviours.map((b) => b.block);
  if (kinds.filter((k) => k === 'consumable').length > 1) errors.push({ path: 'behaviours', message: 'at most one consumable block' });
  if (kinds.includes('inert') && kinds.some((k) => k === 'affectsNeeds' || k === 'makesNoise')) errors.push({ path: 'behaviours', message: 'inert items have no verbs' });
  return errors.length ? { ok: false, errors } : { ok: true, item };
}

export function parseDurationSeconds(s: string): number {
  const m = DURATION_RE.exec(s);
  if (!m) throw new Error(`bad duration ${s}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/** A verb on one entity (airdrops carry their own); same shape as a pack verb, durations in reference ticks. */
export interface EntityVerb {
  range: number;
  durationTicks: number;
  handler: string;
  params?: Record<string, Json>;
}

/**
 * The verbs a dropped item offers, built from its blocks. Durations are in reference ticks
 * (1 in-world second each), like pack verbs. `scan` is always there; the robot learns the rest.
 */
export function airdropVerbs(item: CatalogItem): Record<string, EntityVerb> {
  const verbs: Record<string, EntityVerb> = { scan: { range: 6, durationTicks: 20, handler: 'basic.inspect' } };
  const portable = item.portable || item.behaviours.some((b) => b.block === 'portable');
  if (portable) {
    verbs.pickup = { range: 1, durationTicks: 10, handler: 'basic.pickup' };
    verbs.drop = { range: 0, durationTicks: 5, handler: 'basic.drop' };
  }
  for (const b of item.behaviours) {
    if (b.block === 'affectsNeeds') {
      verbs[b.verb] = { range: b.range, durationTicks: Math.max(1, Math.round(b.durationSeconds)), handler: 'basic.airdropNeeds', params: { needs: b.needs, observation: b.observation } };
    }
    if (b.block === 'makesNoise') {
      verbs[b.verb] = { range: b.range, durationTicks: 2 * b.notes.length, handler: 'basic.airdropNoise', params: { notes: b.notes, ...(b.observation && { observation: b.observation }) } };
    }
  }
  return verbs;
}

/** Uses before an item is used up (consumable block), or undefined for unlimited. */
export function airdropUses(item: CatalogItem): number | undefined {
  const c = item.behaviours.find((b) => b.block === 'consumable');
  return c?.block === 'consumable' ? c.uses : undefined;
}

/**
 * What a robot perceives an object as. Airdrops are "things" known only by their tags (it
 * isn't told names or behaviours), e.g. `thing-metal-small`; everything else by its type.
 */
export function perceivedType(e: { type: string; tags: readonly string[] }): string {
  return e.type === 'airdrop' ? ['thing', ...[...e.tags].sort()].join('-') : e.type;
}

// ------------------------------------------------------------------ templates and seed items

const ICONS = {
  battery: '<icon><rect x="7" y="5" w="10" h="16" r="1"/><line x1="10" y1="3" x2="14" y2="3" weight="heavy"/><rect x="9" y="12" w="6" h="7" shade="dense"/></icon>',
  ball: '<icon><circle cx="12" cy="12" r="8"/><path d="M 4 12 A 8 4 0 0 0 20 12" weight="thin"/><circle cx="12" cy="12" r="3" shade="light"/></icon>',
  bell: '<icon><path d="M 6 17 L 8 9 A 4 4 0 0 1 16 9 L 18 17 Z" shade="light"/><circle cx="12" cy="19" r="1.5" shade="dense"/><line x1="12" y1="3" x2="12" y2="5" weight="heavy"/></icon>',
  rock: '<icon><polyline points="4,18 7,9 13,6 19,10 20,17 4,18" weight="heavy"/><line x1="9" y1="13" x2="14" y2="11" dashed="true"/></icon>',
};

export const CATALOG_TEMPLATES: { name: string; item: CatalogItem }[] = [
  {
    name: 'snack',
    item: {
      schema: 1, id: 'battery-snack', name: 'Fizzy cell', description: 'A small cell that fizzes pleasantly. It does not charge anything.', icon: ICONS.battery,
      tags: ['metal', 'small'], portable: true, expiresAfter: '24h',
      behaviours: [
        { block: 'affectsNeeds', verb: 'eat', range: 0, durationSeconds: 5, needs: { curiosity: 0.05, signal: 0.05 }, observation: 'a fizzy tingle' },
        { block: 'consumable', uses: 1 },
      ],
    },
  },
  {
    name: 'toy',
    item: {
      schema: 1, id: 'bouncy-ball', name: 'Bouncy ball', description: 'Fun to play with, again and again.', icon: ICONS.ball,
      tags: ['round', 'soft'], portable: true, expiresAfter: '7d',
      behaviours: [{ block: 'affectsNeeds', verb: 'bounce', range: 1, durationSeconds: 10, needs: { curiosity: 0.08 }, observation: 'it bounced back up' }],
    },
  },
  {
    name: 'noise-maker',
    item: {
      schema: 1, id: 'squeaky-toy', name: 'Squeaky toy', description: 'Squeeze it and it squeaks a little tune.', icon: ICONS.bell,
      tags: ['soft', 'small'], portable: true, expiresAfter: '7d',
      behaviours: [
        { block: 'makesNoise', verb: 'squeeze', range: 1, notes: ['chirp-E', 'chirp-G'], observation: 'it squeaked' },
        { block: 'affectsNeeds', verb: 'chew', range: 0, durationSeconds: 8, needs: { curiosity: 0.04 }, observation: 'rubbery' },
      ],
    },
  },
  {
    name: 'inert',
    item: {
      schema: 1, id: 'heavy-rock', name: 'Heavy rock', description: 'It just sits there.', icon: ICONS.rock,
      tags: ['stone', 'heavy'], portable: false, behaviours: [{ block: 'inert' }],
    },
  },
];

/** Seeded into an empty catalogue on first run. */
export const CATALOG_SEED: CatalogItem[] = CATALOG_TEMPLATES.filter((t) => t.name !== 'toy').map((t) => t.item);

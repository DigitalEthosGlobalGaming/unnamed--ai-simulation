/**
 * The sample source's new garden (iteration 2, docs/architecture/objects.md): schema-2 definitions
 * for every object, the rules that run each in-world hour, product slots, and the viewer-facing
 * extras (stateSpec, appearance, products, footprint, createdBy). Deterministic: everything runs on
 * sim ticks, never the host clock.
 */
import type { ObjectDef, ObjectView, ProductSlot } from '../types.ts';
import type { Entity } from './types.ts';

const icon = (body: string) => `<icon>${body}</icon>`;

export const DEFS: ObjectDef[] = [
  {
    schema: 2,
    id: 'dock',
    name: 'Dock',
    description: 'Home. Resting here cools the robot down; it sleeps here by preference.',
    icon: icon('<path d="M5 20 V6 H19 V20" weight="heavy"/><rect x="8" y="12" w="8" h="8" shade="light" weight="thin"/>'),
    tags: ['shelter'],
    solid: true,
    verbs: { dock: { range: 0, durationSeconds: 60 }, rest: { range: 0, durationSeconds: 300 } },
  },
  {
    schema: 2,
    id: 'ball',
    name: 'Ball',
    description: 'Rolls when pushed.',
    icon: icon('<circle cx="12" cy="12" r="7" weight="heavy"/><path d="M7 9 A8 8 0 0 1 17 9" weight="thin"/>'),
    tags: ['portable', 'round'],
    portable: true,
    verbs: { push: { range: 1, durationSeconds: 20 }, chase: { range: 1, durationSeconds: 50 } },
  },
  {
    schema: 2,
    id: 'fountain',
    name: 'Fountain',
    description: 'Cold running water. Fills a watering can.',
    icon: icon('<circle cx="12" cy="12" r="8" weight="heavy"/><circle cx="12" cy="12" r="4" shade="medium"/>'),
    tags: ['water', 'loud'],
    solid: true,
    verbs: {
      rinse: { range: 1, durationSeconds: 30 },
      splash: { range: 1, durationSeconds: 45 },
      fill: {
        range: 1,
        durationSeconds: 10,
        requires: { holding: { type: 'watering-can' } },
        effects: [{ block: 'changeState', target: 'held', set: { water: 1 } }, { block: 'observe', text: 'the can grew heavy with water' }],
        fail: 'there is nothing to fill',
      },
    },
  },
  {
    schema: 2,
    id: 'piano',
    name: 'Piano',
    description: 'Makes notes when pressed.',
    icon: icon('<rect x="3" y="7" w="18" h="10" weight="heavy"/><line x1="7" y1="7" x2="7" y2="13"/><line x1="11" y1="7" x2="11" y2="13"/><line x1="15" y1="7" x2="15" y2="13"/>'),
    tags: ['loud'],
    solid: true,
    verbs: { play: { range: 1, durationSeconds: 80 }, press: { range: 1, durationSeconds: 10 } },
  },
  {
    schema: 2,
    id: 'garden-bed',
    name: 'Garden bed',
    description: 'A raised bed of soil. Seeds pressed in here grow into plants.',
    icon: icon('<rect x="2" y="7" w="20" h="10" weight="heavy"/><line x1="5" y1="12" x2="19" y2="12" dashed="true" weight="thin"/>'),
    tags: ['soil'],
    footprint: { w: 3, h: 2 },
    verbs: {
      plant: {
        range: 1,
        durationSeconds: 8,
        requires: { holding: { tag: 'seed' } },
        effects: [{ block: 'createObject', type: 'plant', at: 'freeTileIn', consumeHeld: true }, { block: 'observe', text: 'you pressed the seed into the soil' }],
        fail: 'there is no room left in the bed',
      },
    },
  },
  {
    schema: 2,
    id: 'plant',
    name: 'Plant',
    description: 'Grows when watered. Flowers, then seeds.',
    icon: icon('<line x1="12" y1="21" x2="12" y2="9" weight="heavy"/><path d="M12 14 A5 5 0 0 1 6 9" /><path d="M12 12 A5 5 0 0 0 18 7"/><circle cx="12" cy="6" r="3" shade="light"/>'),
    tags: ['plant', 'living'],
    state: { water: { initial: 0.6, min: 0, max: 1 }, growth: { initial: 0, min: 0, max: 1 } },
    verbs: {
      water: {
        range: 1,
        durationSeconds: 5,
        requires: { holding: { type: 'watering-can', state: { water: { gte: 0.25 } } } },
        effects: [
          { block: 'changeState', target: 'held', values: { water: -0.25 } },
          { block: 'changeState', target: 'self', values: { water: 0.4 } },
          { block: 'observe', text: 'the soil darkened as the water soaked in' },
        ],
        fail: 'the can is empty',
      },
      inspect: {
        range: 1,
        durationSeconds: 5,
        requires: { self: { growth: { gte: 0.7 } } },
        effects: [{ block: 'affectNeeds', needs: { curiosity: 0.15 }, observation: 'the flower smelled of something new' }],
      },
    },
    rules: [
      { every: '1h', change: { water: -0.03 } },
      { every: '1h', when: { water: { gte: 0.3 } }, change: { growth: 0.008 } },
      { every: '1h', when: { water: { lt: 0.05 } }, change: { growth: -0.01 } },
    ],
    products: [
      { slot: 'flower', item: 'flower', when: { growth: { gte: 0.7 } }, everyHours: 24, max: 1, verb: 'pick' },
      { slot: 'seeds', item: 'seed', when: { growth: { gte: 1 } }, everyHours: 24, max: 3, verb: 'gather', reset: { growth: 0.6 } },
    ],
    appearance: {
      water: [
        { lt: 0.15, text: 'the soil is cracked and dry' },
        { lt: 0.5, text: 'the soil looks dry' },
        { text: 'the soil is damp' },
      ],
      growth: [
        { lt: 0.1, text: 'a bare patch of soil' },
        { lt: 0.4, text: 'a small green shoot' },
        { lt: 0.7, text: 'a leafy plant' },
        { lt: 1, text: 'a plant with a flower bud' },
        { text: 'a plant in full flower' },
      ],
    },
  },
  {
    schema: 2,
    id: 'seed',
    name: 'Seed',
    description: 'Press it into the garden bed to grow a plant.',
    icon: icon('<ellipse cx="12" cy="12" rx="4" ry="6" shade="medium" weight="heavy"/>'),
    tags: ['seed', 'small'],
    portable: true,
  },
  {
    schema: 2,
    id: 'flower',
    name: 'Flower',
    description: 'Smells of something new. Wilts after two days.',
    icon: icon('<circle cx="12" cy="9" r="3" shade="dense"/><circle cx="12" cy="9" r="6" weight="thin"/><line x1="12" y1="15" x2="12" y2="22" weight="heavy"/>'),
    tags: ['flower', 'small'],
    portable: true,
    state: { fresh: { initial: 1, min: 0, max: 1 } },
    verbs: { smell: { range: 0, durationSeconds: 5, effects: [{ block: 'affectNeeds', needs: { curiosity: 0.05 }, observation: 'a faint sweet smell' }] } },
    rules: [{ every: '1h', change: { fresh: -0.021 } }, { every: '1h', when: { fresh: { lte: 0 } }, remove: true }],
    appearance: { fresh: [{ lt: 0.3, text: 'a wilting flower' }, { text: 'a fresh flower' }] },
  },
  {
    schema: 2,
    id: 'watering-can',
    name: 'Watering can',
    description: 'Fill it at the fountain; water the plants with it.',
    icon: icon('<rect x="5" y="9" w="11" h="11" r="1" weight="heavy"/><line x1="16" y1="12" x2="21" y2="7" weight="heavy"/><path d="M8 9 A4 4 0 0 1 13 9" weight="thin"/>'),
    tags: ['container'],
    portable: true,
    state: { water: { initial: 0, min: 0, max: 1 } },
    appearance: { water: [{ lt: 0.05, text: 'an empty can' }, { lt: 0.75, text: 'a can with some water in it' }, { text: 'a full can' }] },
  },
  {
    schema: 2,
    id: 'antenna-mast',
    name: 'Antenna mast',
    description: 'A tall mast. Signal is strong nearby.',
    icon: icon('<line x1="12" y1="3" x2="12" y2="21" weight="heavy"/><line x1="7" y1="21" x2="17" y2="21" weight="heavy"/><path d="M8 7 A6 6 0 0 1 16 7" weight="thin"/><path d="M5 5 A9 9 0 0 1 19 5" weight="thin"/>'),
    tags: ['metal', 'tall'],
    solid: true,
    rules: [{ every: '1h', nearby: { range: 3, needs: { signal: 0.2 } } }],
    appearance: { _: [{ text: 'a tall mast, humming' }] },
  },
];

export const DEF: Record<string, ObjectDef> = Object.fromEntries(DEFS.map((d) => [d.id, d]));

/** The new garden's starting objects (the mailbox is added by the server). */
export function gardenObjects(): Entity[] {
  const init = (type: string, extra: Record<string, number> = {}) => {
    const st: Record<string, number> = {};
    for (const [k, v] of Object.entries(DEF[type]?.state ?? {})) st[k] = v.initial;
    return { ...st, ...extra };
  };
  return [
    { id: 'obj-dock', kind: 'object', type: 'dock', pos: { x: 2, y: 2 }, tags: ['shelter'], state: {} },
    { id: 'obj-fountain', kind: 'object', type: 'fountain', pos: { x: 12, y: 12 }, tags: ['water', 'loud'], state: {} },
    { id: 'obj-ball', kind: 'object', type: 'ball', pos: { x: 7, y: 11 }, tags: ['portable', 'round'], state: {} },
    { id: 'obj-piano', kind: 'object', type: 'piano', pos: { x: 20, y: 14 }, tags: ['loud'], state: {} },
    { id: 'obj-bed', kind: 'object', type: 'garden-bed', pos: { x: 10, y: 1 }, tags: ['soil'], state: {} },
    { id: 'obj-plant-1', kind: 'object', type: 'plant', pos: { x: 10, y: 1 }, tags: ['plant', 'living'], state: init('plant', { water: 0.7, growth: 0.1 }) },
    { id: 'obj-seed-1', kind: 'object', type: 'seed', pos: { x: 13, y: 3 }, tags: ['seed', 'small'], state: {} },
    { id: 'obj-seed-2', kind: 'object', type: 'seed', pos: { x: 9, y: 3 }, tags: ['seed', 'small'], state: {} },
    { id: 'obj-can', kind: 'object', type: 'watering-can', pos: { x: 13, y: 13 }, tags: ['container'], state: init('watering-can') },
    { id: 'obj-mast', kind: 'object', type: 'antenna-mast', pos: { x: 17, y: 3 }, tags: ['metal', 'tall'], state: {} },
  ];
}

export const SOLID = new Set(DEFS.filter((d) => d.solid).map((d) => d.id).concat('mailbox'));

/* ------------------------------------------------------------ rules and products */

type Cond = Record<string, Record<string, number>>;
const holds = (st: Record<string, unknown>, c?: Cond) =>
  !c ||
  Object.entries(c).every(([k, ops]) => {
    const v = Number(st[k] ?? 0);
    return Object.entries(ops).every(([op, b]) => (op === 'lt' ? v < b : op === 'lte' ? v <= b : op === 'gt' ? v > b : op === 'gte' ? v >= b : v === b));
  });
const clampTo = (def: ObjectDef, k: string, v: number) => {
  const sp = def.state?.[k];
  return Math.round((sp ? Math.max(sp.min, Math.min(sp.max, v)) : v) * 1000) / 1000;
};

/** Products live on the entity (`products[].hours` next to `ready`), as on the server. */
export type LivingEntity = Entity & { products?: ProductSlot[]; createdBy?: { entityId: string; tick: number } };

/** One in-world hour of rules and product timers. Returns the objects that changed. */
export function gardenHour(objects: LivingEntity[]): LivingEntity[] {
  const changed: LivingEntity[] = [];
  for (const o of objects) {
    const def = DEF[o.type];
    if (!def || (!def.rules?.length && !def.products?.length)) continue;
    const before = JSON.stringify([o.state, o.products]);
    const st = o.state as Record<string, number>;
    for (const r of def.rules ?? []) {
      if (!r.change || !holds(st, r.when)) continue;
      for (const [k, d] of Object.entries(r.change)) st[k] = clampTo(def, k, Number(st[k] ?? 0) + d);
    }
    o.products = productsOf(o, def, 1);
    if (JSON.stringify([o.state, o.products]) !== before) changed.push(o);
  }
  return changed;
}

function productsOf(o: LivingEntity, def: ObjectDef, addHours: number): ProductSlot[] {
  return (def.products ?? []).map((p) => {
    const was = o.products?.find((x) => x.slot === p.slot);
    let ready = was?.ready ?? 0;
    let hours = was?.hours ?? 0;
    if (holds(o.state as Record<string, unknown>, p.when) && ready < p.max) {
      hours += addHours;
      if (hours >= p.everyHours) {
        ready += 1;
        hours = 0;
      }
    } else if (ready >= p.max) hours = 0;
    return { slot: p.slot, item: p.item, ready, max: p.max, verb: p.verb, hours };
  });
}

/** Harvest one product: the slot empties by one and `reset` applies. */
export function harvest(o: LivingEntity, slot: string): boolean {
  const def = DEF[o.type];
  const p = o.products?.find((x) => x.slot === slot);
  const pd = def?.products?.find((x) => x.slot === slot);
  if (!def || !p || !pd || p.ready < 1) return false;
  p.ready -= 1;
  for (const [k, v] of Object.entries(pd.reset ?? {})) (o.state as Record<string, number>)[k] = clampTo(def, k, v);
  return true;
}

/** The viewer-facing schema-2 extras for an entity (what the real server adds to snapshots). */
export function extrasOf(o: LivingEntity): Pick<ObjectView, 'stateSpec' | 'appearance' | 'products' | 'footprint' | 'createdBy'> {
  const def = DEF[o.type];
  if (!def) return {};
  const st = o.state as Record<string, unknown>;
  const spec: Record<string, { min: number; max: number }> = {};
  for (const [k, v] of Object.entries(def.state ?? {})) spec[k] = { min: v.min, max: v.max };
  const appearance: string[] = [];
  for (const [k, bands] of Object.entries(def.appearance ?? {})) {
    const v = Number(st[k] ?? 0);
    const b = bands.find((x) => (x.lt === undefined || v < x.lt) && (x.lte === undefined || v <= x.lte) && (x.gt === undefined || v > x.gt) && (x.gte === undefined || v >= x.gte));
    if (b) appearance.push(b.text);
  }
  const products = (o.products ?? productsOf({ ...o }, def, 0)).map((p) => {
    const pd = def.products!.find((x) => x.slot === p.slot)!;
    const growing = holds(st, pd.when) && p.ready < p.max;
    return { ...p, ...(growing && { nextInHours: Math.max(0, pd.everyHours - (p.hours ?? 0)) }) };
  });
  return {
    ...(Object.keys(spec).length && { stateSpec: spec }),
    appearance,
    ...(products.length && { products }),
    ...(def.footprint && { footprint: { ...def.footprint } }),
    ...(o.createdBy && { createdBy: { ...o.createdBy } }),
  };
}

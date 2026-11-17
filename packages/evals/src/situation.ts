import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CATALOG_TEMPLATES,
  airdropUses,
  airdropVerbs,
  buildRegistry,
  perceivedType,
  type Belief,
  type CatalogItem,
  type Character,
  type Candidate,
  type EntityDef,
  type JobRequest,
  type Json,
  type Memory,
  type Registry,
  type ThinkingDepth,
} from '@uas/core';
import { MindSystem, beliefText, fogOf, freezePrefix, pressureOf } from '@uas/mind';
import { renderPrompt } from '@uas/models';
import { World, type WorldState } from '@uas/sim';
import { basicPack, gardenGrid } from '@uas/pack-basic';

/**
 * A situation: one frozen moment for a model eval. It holds enough to rebuild the exact model
 * request through the *current* mind and prompt builder, plus property checks on the answer.
 * Hand-written situations describe the moment compactly (`world`, `character`); captured ones
 * carry the world state itself (`snapshot`, without the map grid).
 */

const Kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case');
const XY = z.tuple([z.int(), z.int()]);
const TRIGGERS = ['sensed', 'heard-noise', 'action-finished', 'action-rejected', 'need-threshold', 'idle-timeout', 'woke-up', 'admin-poke'] as const;

export const CheckSpecSchema = z.strictObject({
  check: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Share of applicable samples that must pass (default 2 of 3). */
  minPassRate: z.number().min(0).max(1).default(0.67),
  /** A suggestion a human still has to confirm (captured situations); not scored. */
  todo: z.boolean().default(false),
  note: z.string().optional(),
});
export type CheckSpec = z.infer<typeof CheckSpecSchema>;

const BeliefSpec = z.strictObject({
  key: z.string().regex(/^[a-zA-Z]+:[a-zA-Z0-9-]+@(day|night)$/, 'verb:type@day or @night'),
  text: z.string().optional(),
  needs: z.record(z.string(), z.number()).default({}),
  valence: z.number().min(-1).max(1).default(0),
  firmness: z.number().min(0).max(1),
  support: z.int().min(0).default(3),
  source: z.literal('told').optional(),
});
const MemorySpec = z.strictObject({
  text: z.string().min(1),
  store: z.enum(['stm', 'ltm']).default('stm'),
  kind: z.enum(['outcome', 'noise', 'person', 'place', 'fact', 'feeling']).default('outcome'),
  verb: z.string().optional(),
  objectType: z.string().optional(),
  when: z.enum(['day', 'night']).optional(),
  valence: z.number().min(-1).max(1).default(0),
  strength: z.number().min(0).max(1).default(0.5),
  /** Minutes before the moment (for ordering and worth). */
  minutesAgo: z.number().min(0).default(10),
});
const EntitySpec = z.strictObject({ id: z.string(), type: z.string(), pos: XY, state: z.record(z.string(), z.unknown()).optional() });

const WorldSpec = z.strictObject({
  /** In-world local time, `HH:MM`. Daylight is 06:00 to 18:00. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  day: z.int().min(0).default(2),
  /** Replace the default garden objects entirely. */
  entities: z.array(EntitySpec).optional(),
  /** Extra objects, or moved defaults (same id). */
  add: z.array(EntitySpec).default([]),
  remove: z.array(z.string()).default([]),
  /** Notes waiting in the mailbox, oldest first. */
  mailbox: z.array(z.string()).default([]),
  airdrops: z
    .array(z.strictObject({ id: Kebab, item: z.union([z.string(), z.record(z.string(), z.unknown())]), pos: XY, usesLeft: z.int().min(0).optional() }))
    .default([]),
});

const CharacterSpec = z.strictObject({
  id: z.string().default('robot'),
  pos: XY,
  energy: z.number().min(0).max(1),
  needs: z.record(z.string(), z.number().min(0).max(1)).default({}),
  /** Entity id the character is holding. */
  carrying: z.string().optional(),
  mood: z.strictObject({ valence: z.number(), arousal: z.number(), word: z.string() }).optional(),
  beliefs: z.array(BeliefSpec).default([]),
  memories: z.array(MemorySpec).default([]),
  openItems: z.array(z.strictObject({ kind: z.enum(['promise', 'person', 'question', 'want', 'unfinished']), text: z.string(), weight: z.number().default(1), about: z.string().optional() })).default([]),
  /** The robot has explored: every object is in its map (`known`), not only what it sees now. */
  knowsAll: z.boolean().default(true),
  /** In-world hours since it last woke (sleep pressure's time part; 0 = just woke). */
  hoursAwake: z.number().min(0).max(48).default(4),
  /** Memories formed since its last sleep (fog); defaults to the number of `memories`. */
  unsettled: z.int().min(0).optional(),
});

export const SituationSchema = z
  .strictObject({
    id: Kebab,
    title: z.string().min(1),
    /** One sentence: what this situation guards. */
    why: z.string().min(1),
    source: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('handwritten') }),
      z.strictObject({ kind: z.literal('captured'), world: z.string(), tick: z.int(), date: z.string(), characterId: z.string() }),
    ]),
    tags: z.array(z.string()).default([]),
    /**
     * `decide`: the decision model; `plan`: the same request sent to the text model as a plan;
     * `auto`: as the brain would route it (habit → its own top option, no call; gut → decide; think → plan).
     */
    job: z.enum(['decide', 'plan', 'auto']),
    trigger: z.enum(TRIGGERS).default('action-finished'),
    world: WorldSpec.optional(),
    character: CharacterSpec.optional(),
    /** Captured: the world state at that moment, without `config.grid` (rebuilt from `map`). */
    snapshot: z.record(z.string(), z.unknown()).optional(),
    map: z.string().default('basic:garden'),
    checks: z.array(CheckSpecSchema).default([]),
  })
  .refine((s) => (s.snapshot ? !s.world && !s.character : !!s.world && !!s.character), { message: 'either `snapshot` (captured) or `world` and `character` (hand-written)' });

export type Situation = z.infer<typeof SituationSchema>;
export type SituationInput = z.input<typeof SituationSchema>;

/** The default garden (as in worlds/garden.yaml) for hand-written situations. */
export const GARDEN_OBJECTS: { id: string; type: string; pos: [number, number]; state?: Record<string, unknown> }[] = [
  { id: 'pad', type: 'solarPad', pos: [8, 8] },
  { id: 'dock', type: 'dock', pos: [2, 7] },
  { id: 'ball', type: 'ball', pos: [12, 12] },
  { id: 'fountain', type: 'fountain', pos: [14, 6] },
  { id: 'piano', type: 'piano', pos: [3, 3] },
  { id: 'mailbox', type: 'mailbox', pos: [17, 8] },
];

let registryCache: Registry | undefined;
export const evalRegistry = () => (registryCache ??= buildRegistry([basicPack()]));

export function parseSituation(raw: unknown, where = 'situation'): Situation {
  const r = SituationSchema.safeParse(raw);
  if (!r.success) throw new Error(`${where}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** Every `*.json` under a directory (recursively), parsed and validated, sorted by id. */
export function loadSituations(dir: string): (Situation & { file: string })[] {
  const out: (Situation & { file: string })[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.json')) out.push({ ...parseSituation(JSON.parse(readFileSync(p, 'utf8')), p), file: p });
    }
  };
  walk(dir);
  const ids = new Set<string>();
  for (const s of out) {
    if (ids.has(s.id)) throw new Error(`duplicate situation id ${s.id} (${s.file})`);
    ids.add(s.id);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface Built {
  world: World;
  minds: MindSystem;
  character: Character;
}

/** Rebuild the world at the situation's moment, with a mind (no ticks are run). */
export function buildSituation(s: Situation): Built {
  const registry = evalRegistry();
  const minds = new MindSystem();
  if (s.snapshot) {
    const state = structuredClone(s.snapshot) as unknown as WorldState;
    state.config = { ...state.config, grid: gardenGrid() };
    const world = World.fromSnapshot(state, registry, minds, { allowPackUpgrade: true });
    const id = s.source.kind === 'captured' ? s.source.characterId : 'robot';
    const c = world.entity(id);
    if (c?.kind !== 'character' || !c.mind) throw new Error(`${s.id}: no character with a mind called ${id}`);
    return { world, minds, character: c };
  }
  const w = s.world!;
  const cs = s.character!;
  const [hh, mm] = w.time.split(':').map(Number) as [number, number];
  let objects = (w.entities ?? GARDEN_OBJECTS).filter((e) => !w.remove.includes(e.id));
  for (const a of w.add) objects = [...objects.filter((e) => e.id !== a.id), a];
  const defs: EntityDef[] = [
    { id: cs.id, type: 'robot', pos: { x: cs.pos[0], y: cs.pos[1] }, state: { name: 'Robot' } },
    ...objects.map((e) => ({ id: e.id, type: e.type, pos: { x: e.pos[0], y: e.pos[1] }, ...(e.state && { state: e.state as Record<string, Json> }) })),
  ];
  const world = World.create(
    { worldId: `eval-${s.id}`, seed: 1, grid: gardenGrid(), secondsPerTick: 1, startSecond: w.day * 86_400 + hh * 3600 + mm * 60 },
    registry,
    defs,
    minds,
    { mind: { brain: 'models' } },
  );
  // Airdrops as the sim lands them (a copy of the item, verbs from its blocks).
  for (const d of w.airdrops) {
    const item = (typeof d.item === 'string' ? CATALOG_TEMPLATES.find((t) => t.item.id === d.item)?.item : d.item) as CatalogItem | undefined;
    if (!item) throw new Error(`${s.id}: unknown catalogue item ${String(d.item)}`);
    const uses = d.usesLeft ?? airdropUses(item);
    world.state.entities[`drop-${d.id}`] = {
      id: `drop-${d.id}`,
      kind: 'object',
      type: 'airdrop',
      pos: { x: d.pos[0], y: d.pos[1] },
      tags: [...item.tags],
      state: {
        dropId: d.id,
        itemId: item.id,
        item: structuredClone(item) as unknown as Json,
        verbs: airdropVerbs(item) as unknown as Json,
        droppedBy: { username: 'visitor', admin: false, userKey: 'eval' },
        droppedTick: 0,
        ...(uses !== undefined && { usesLeft: uses }),
      },
    } as never;
  }
  if (w.mailbox.length) {
    world.state.mailbox = { queue: w.mailbox.map((text, i) => ({ mailId: `m${i + 1}`, text, by: { username: 'visitor', admin: false, userKey: 'eval' }, postedTick: 0 })) };
    for (const e of world.entities()) if (e.type === 'mailbox') e.state.waiting = w.mailbox.length;
  }
  const c = world.entity(cs.id) as Character;
  c.energy = cs.energy;
  for (const [k, v] of Object.entries(cs.needs)) {
    if (!(k in c.needs)) throw new Error(`${s.id}: unknown need ${k}`);
    c.needs[k] = v;
  }
  if (cs.carrying) {
    const held = world.entity(cs.carrying);
    if (!held) throw new Error(`${s.id}: carrying unknown entity ${cs.carrying}`);
    held.heldBy = c.id;
    held.pos = { ...c.pos };
  }
  const m = c.mind!;
  m.triggers = [];
  if (cs.mood) m.mood = { ...m.mood, ...cs.mood };
  const day = world.day;
  m.beliefs = cs.beliefs.map(
    (b): Belief => ({
      key: b.key,
      text: b.text ?? (b.source === 'told' ? `a stranger's note said to ${b.key.split(':')[0]} the ${b.key.split(':')[1]!.split('@')[0]}` : beliefText(b.key, b.needs)),
      expectedNeedDeltas: { ...b.needs },
      expectedValence: b.valence,
      support: b.support,
      firmness: b.firmness,
      lastSupportedDay: day,
      ...(b.source && { source: b.source }),
    }),
  );
  const perMinute = 60 / world.state.config.secondsPerTick;
  cs.memories.forEach((x, i) => {
    const tick = world.tick - Math.round(x.minutesAgo * perMinute);
    const mem: Memory = {
      id: `m${i + 1}`,
      store: x.store,
      tick,
      day,
      kind: x.kind,
      text: x.text,
      about: { ...(x.verb && { verb: x.verb }), ...(x.objectType && { objectType: x.objectType }), ...(x.when && { when: x.when }) },
      valence: x.valence,
      strength: x.strength,
      recalls: 0,
      recallDays: [],
      lastRecallTick: tick,
    };
    (x.store === 'stm' ? m.stm : m.ltm).push(mem);
  });
  m.openItems = cs.openItems.map((o, i) => ({ id: `o${i + 1}`, kind: o.kind, text: o.text, weight: o.weight, tick: world.tick, ...(o.about && { about: o.about }) }));
  m.nextId = 100;
  if (cs.knowsAll) {
    for (const e of world.entities()) {
      if (e.kind !== 'object') continue;
      m.known[e.id] = { type: perceivedType(e), pos: { ...e.pos }, affordances: world.verbsFor(e), tick: world.tick };
    }
  }
  const arch = world.archetype(c.type)!;
  // Sleep pressure and fog, as the mind keeps them (iteration 2).
  m.unsettled = cs.unsettled ?? cs.memories.length;
  m.awakeSinceTick = world.tick - Math.round((cs.hoursAwake * 3600) / world.state.config.secondsPerTick);
  m.fog = Math.round(fogOf(m, arch.mind.stmSize) * 1000) / 1000;
  m.sleepPressure = pressureOf(cs.hoursAwake, m.fog);
  freezePrefix(world.registry, arch, m, world.tick, minds.ticksPerDay(world), day);
  return { world, minds, character: c };
}

export interface SituationRequest {
  request: JobRequest;
  candidates: Candidate[];
  /** How hard the brain would choose to think here (habit, gut or think), and why. */
  thinking: { depth: ThinkingDepth; why: string };
  built: Built;
}

/** The model request the brain would send at this moment, through the current builder. */
export function situationRequest(s: Situation): SituationRequest {
  const built = buildSituation(s);
  const req = built.minds.decisionRequest(built.world, built.character, s.trigger, { perceive: !s.snapshot });
  const { candidates, thinking, ...request } = req;
  return { request, candidates, thinking, built };
}

/** The prompt exactly as a model would get it (system, user, options), for golden snapshots. */
export function promptText(s: Situation): string {
  const { request, candidates, thinking } = situationRequest(s);
  const { system, user } = renderPrompt(request.context);
  return [
    `# ${s.id} (${s.job})`,
    '## system',
    system,
    '## user',
    user,
    `## thinking: ${thinking.depth} (${thinking.why})`,
    '## options',
    ...candidates.map((c) => `${c.id}: ${c.label}  [${c.key}] -> ${c.actions.map((a) => `${a.verb}${a.targetId ? ` ${a.targetId}` : ''}${a.args ? ` ${JSON.stringify(a.args)}` : ''}`).join(', ')}`),
    '',
  ].join('\n');
}

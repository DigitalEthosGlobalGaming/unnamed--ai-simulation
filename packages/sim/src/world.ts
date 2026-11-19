import {
  BLOCKS_HANDLER,
  DROP_HANDLER,
  PERIOD_SECONDS,
  PICKUP_HANDLER,
  appearanceOf,
  checkCondition,
  clampState,
  compileObjectDef,
  migrateToSchema2,
  validateObjectDef2,
  type EffectBlock,
  type EffectContext,
  type ObjectDef,
  type ProductState,
  type WorldObject,
  DecideAnswerSchema,
  type VerbDef,
  MAX_QUEUE,
  RngStreams,
  hashJson,
  inBounds,
  manhattan,
  posKey,
  samePos,
  terrainAt,
  type Action,
  type ActionStatus,
  type AnyEntity,
  type Character,
  type Delta,
  type EffectResult,
  type EntityDef,
  type EntityId,
  type Grid,
  type InputEvent,
  type Json,
  type Pos,
  type Registry,
  type RngState,
  type SimInputEvent,
  type Sound,
  type Entity,
  type StateChange,
  type TickDeltas,
  type WorldId,
  type WorldView,
} from '@uas/core';
import { findPath, type PathGoal } from './path.ts';

const isRecord = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Handlers the engine provides itself (schema-2 blocks; portable pickup and drop). */
const BUILT_IN_HANDLERS = new Set([BLOCKS_HANDLER, PICKUP_HANDLER, DROP_HANDLER]);

export interface WorldConfig {
  worldId: WorldId;
  seed: number;
  grid: Grid;
  /** In-world seconds that pass per tick. */
  secondsPerTick: number;
  dayLengthSeconds: number;
  /** In-world second of the day at tick 0. */
  startSecond: number;
  /** Ticks to cross one tile. */
  moveTicksPerTile: number;
  /**
   * Multiplier on action durations given in ticks (pack `durationTicks`, built-in `ticks` args):
   * they are written for 1 in-world second per tick, so a world at 0.25 s per tick uses 4.
   * Default 1.
   */
  durationScale?: number;
}

export const DEFAULT_CONFIG = {
  secondsPerTick: 6,
  dayLengthSeconds: 86_400,
  startSecond: 8 * 3600,
  moveTicksPerTile: 5,
} satisfies Partial<WorldConfig>;

/**
 * Hooks for the mind runtime (or anything else) to join the tick.
 * Order per tick: inputs (onInput) → actions → effects (applyNeeds) → afterTick.
 */
export interface SimPlugin {
  onSpawn?(world: World, character: Character): void;
  /** Return true when the plugin handled the input. */
  onInput?(world: World, event: InputEvent): boolean;
  /** Apply an effect's need deltas to the actor; the default adds them as-is. */
  applyNeeds?(world: World, actor: Character, action: Action, target: Entity, needDeltas: Record<string, number>): void;
  /** Needs, mood, senses, triggers and brain run here, after effects. */
  afterTick?(world: World, deltas: readonly Delta[]): void;
}

/** The complete, plain-JSON world state. A snapshot is a copy of this. */
export interface WorldState {
  config: WorldConfig;
  packVersions: string;
  /** The tick the next `step()` will process. */
  tick: number;
  nextId: number;
  /** Bumped whenever walkability changes; keys the path cache. */
  mapVersion: number;
  rng: Record<string, RngState>;
  entities: Record<EntityId, AnyEntity>;
  /** Plugin-owned state (e.g. mind config), snapshotted with everything else. */
  ext: Record<string, Json>;
  /**
   * In-world time: `seconds(tick) = baseSeconds + (tick - baseTick) × secondsPerTick`, in local
   * wall-clock seconds since the epoch for a real-time world (or from `startSecond` for a scaled
   * one). Moved only by logged `clock.*` inputs. `dayZero` makes `day` count from 0.
   */
  clock?: { baseSeconds: number; baseTick: number; dayZero: number; timezone: string; anchored?: boolean };
  /** The world's mailbox: messages oldest first (deterministic, snapshotted). Text is private until read. */
  mailbox?: { queue: MailItem[] };
  /** In-world second up to which object rules have run (schema 2). */
  rulesSeconds?: number;
}

export interface MailItem {
  mailId: string;
  text: string;
  by: { username: string; admin: boolean; userKey: string };
  postedTick: number;
  expiresTick?: number;
}

/** Need and energy level a new character starts at (until the mind package owns this). */
export const START_LEVEL = 0.75;
const BUILT_INS = new Set(['moveTo', 'vocalize', 'wait', 'rest', 'follow']);
const TICKS_PER_NOTE = 2;
const PATH_CACHE_MAX = 2_000;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const intArg = (v: Json | undefined, def: number, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : def;

export class World implements WorldView {
  readonly state: WorldState;
  readonly registry: Registry;
  private readonly streams: RngStreams;
  private pending: SimInputEvent[] = [];
  private deltas: Delta[] = [];
  private sortedIds: EntityId[] | undefined;
  private readonly pathCache = new Map<string, Pos[] | null>();
  private tickSounds: Sound[] = [];
  readonly plugin: SimPlugin | undefined;
  /** Loaded for a pack upgrade: inputs recorded under other pack versions are accepted (see `enqueue`). */
  private readonly allowPackUpgrade: boolean;

  constructor(state: WorldState, registry: Registry, plugin?: SimPlugin, opts: { allowPackUpgrade?: boolean } = {}) {
    // A world saved under older pack versions may be loaded to upgrade it (see `pack.loaded`).
    if (state.packVersions !== registry.packVersions && !opts.allowPackUpgrade) {
      throw new Error(`content pack mismatch: world needs ${state.packVersions}, loaded ${registry.packVersions}`);
    }
    state.clock ??= { baseSeconds: state.config.startSecond, baseTick: 0, dayZero: 0, timezone: 'world' };
    this.state = state;
    this.registry = registry;
    this.plugin = plugin;
    this.allowPackUpgrade = !!opts.allowPackUpgrade;
    this.streams = new RngStreams(state.config.seed, state.rng);
  }

  static create(
    config: Pick<WorldConfig, 'worldId' | 'seed' | 'grid'> & Partial<WorldConfig>,
    registry: Registry,
    entities: EntityDef[] = [],
    plugin?: SimPlugin,
    ext: Record<string, Json> = {},
  ): World {
    const world = new World(
      {
        config: { ...DEFAULT_CONFIG, ...config },
        packVersions: registry.packVersions,
        tick: 0,
        nextId: 1,
        mapVersion: 0,
        rng: {},
        entities: {},
        ext,
      },
      registry,
      plugin,
    );
    for (const def of entities) {
      const err = world.spawn(def);
      if (typeof err === 'string') throw new Error(err);
    }
    world.deltas = [];
    return world;
  }

  /** Restore from a snapshot; the snapshot itself is not mutated. */
  static fromSnapshot(state: WorldState, registry: Registry, plugin?: SimPlugin, opts: { allowPackUpgrade?: boolean } = {}): World {
    return new World(structuredClone(state), registry, plugin, opts);
  }

  snapshot(): WorldState {
    return structuredClone(this.state);
  }

  hash(): string {
    return hashJson(this.state);
  }

  // ------------------------------------------------------------- WorldView

  get tick(): number {
    return this.state.tick;
  }

  /** A duration written in reference ticks, in this world's ticks (see `durationScale`). */
  scaled(ticks: number): number {
    return Math.max(1, Math.round(ticks * (this.state.config.durationScale ?? 1)));
  }

  /** In-world seconds (local wall-clock seconds since the epoch in a real-time world). */
  get seconds(): number {
    const k = this.state.clock!;
    return k.baseSeconds + (this.state.tick - k.baseTick) * this.state.config.secondsPerTick;
  }

  get timeOfDay(): number {
    const len = this.state.config.dayLengthSeconds;
    return (((this.seconds % len) + len) % len) / len;
  }

  /** 06:00 to 18:00. */
  get isDaylight(): boolean {
    const t = this.timeOfDay;
    return t >= 0.25 && t < 0.75;
  }

  /** In-world day number, counting from 0. */
  get day(): number {
    return Math.floor(this.seconds / this.state.config.dayLengthSeconds) - this.state.clock!.dayZero;
  }

  archetype(type: string) {
    return this.registry.archetypes.get(type);
  }

  verbsOf(type: string): string[] {
    return Object.keys(this.registry.objects.get(type)?.verbs ?? {});
  }

  verbsFor(e: Readonly<AnyEntity>): string[] {
    const own = e.kind === 'object' && isRecord(e.state.verbs) ? Object.keys(e.state.verbs) : [];
    return [...new Set([...this.verbsOf(e.type), ...own])];
  }

  /** A verb's definition on one entity: its own (airdrops) first, then its type's. */
  verbDefOf(e: Readonly<AnyEntity> | undefined, verb: string): VerbDef | undefined {
    if (e?.kind !== 'object') return undefined;
    const own = isRecord(e.state.verbs) ? e.state.verbs[verb] : undefined;
    if (isRecord(own) && typeof own.handler === 'string' && typeof own.range === 'number' && typeof own.durationTicks === 'number') {
      return { range: own.range, durationTicks: own.durationTicks, handler: own.handler, ...(isRecord(own.params) && { params: own.params }) };
    }
    return this.registry.objects.get(e.type)?.verbs[verb];
  }

  /** A part of the world's active prompt template (`prompts.activate`), if one was activated. */
  promptPart(id: string, part: string): string | undefined {
    const p = (this.state.ext.prompts as Record<string, { body?: { parts?: Record<string, string> } }> | undefined)?.[id];
    return p?.body?.parts?.[part];
  }

  mailPeek(): { mailId: string; text: string } | undefined {
    const m = this.state.mailbox?.queue[0];
    return m && { mailId: m.mailId, text: m.text };
  }

  /** Sounds made during the current tick. */
  sounds(): readonly Sound[] {
    return this.tickSounds;
  }

  /** A named stream of the world PRNG. */
  rng(name: string) {
    return this.streams.get(name);
  }

  get grid(): Grid {
    return this.state.config.grid;
  }

  entity(id: EntityId): AnyEntity | undefined {
    return this.state.entities[id];
  }

  entities(): AnyEntity[] {
    this.sortedIds ??= Object.keys(this.state.entities).sort();
    return this.sortedIds.map((id) => this.state.entities[id]!);
  }

  characters(): Character[] {
    return this.entities().filter((e): e is Character => e.kind === 'character');
  }

  entitiesAt(pos: Pos): AnyEntity[] {
    return this.entities().filter((e) => samePos(e.pos, pos));
  }

  isWalkable(pos: Pos): boolean {
    if (!terrainAt(this.grid, pos)?.walkable) return false;
    return !this.entitiesAt(pos).some((e) => e.kind === 'object' && !e.heldBy && this.isSolid(e));
  }

  // ------------------------------------------------------------- inputs and stepping

  /** Queue an input event for the tick it is stamped with. */
  enqueue(event: SimInputEvent | InputEvent): void {
    if (event.tick < this.state.tick) throw new Error(`input seq ${event.seq} is for past tick ${event.tick}`);
    // Inputs carry the pack versions in force when they were recorded. Replays enqueue a whole
    // log stretch at once, so across a `pack.loaded` upgrade later inputs carry the loaded
    // registry's versions and earlier ones older versions (accepted only when upgrading).
    if (event.packVersions !== this.state.packVersions && event.packVersions !== this.registry.packVersions && !this.allowPackUpgrade) {
      throw new Error(`input seq ${event.seq} was recorded with packs ${event.packVersions}`);
    }
    this.pending.push(event as SimInputEvent);
    this.pending.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
  }

  /** Advance one tick: inputs, then actions, then effect handlers. */
  step(): TickDeltas {
    const tick = this.state.tick;
    this.deltas = [];
    this.tickSounds = [];
    while (this.pending[0] && this.pending[0].tick <= tick) {
      const e = this.pending.shift()!;
      if (!this.plugin?.onInput?.(this, e)) this.applyInput(e);
    }

    this.expire();
    this.runRules();
    this.nearbyNeeds();
    const finished: Character[] = [];
    for (const c of this.characters()) {
      if (!c.current) this.startNext(c);
      if (c.current && this.advance(c)) finished.push(c);
    }
    for (const c of finished) if (this.state.entities[c.id]) this.resolve(c);
    this.refreshViews();
    this.plugin?.afterTick?.(this, this.deltas);

    this.state.tick++;
    return { tick, changes: this.deltas };
  }

  private applyInput(e: SimInputEvent): void {
    const reject = (reason: string) => this.emit({ kind: 'inputRejected', seq: e.seq, type: e.type, reason });
    switch (e.type) {
      case 'model.answer': {
        const p = e.payload;
        const c = this.state.entities[p.characterId];
        if (c?.kind !== 'character') return reject(`no character ${p.characterId}`);
        if (p.job !== 'decide') return reject(`job ${p.job} is not handled by the sim yet`);
        const parsed = DecideAnswerSchema.safeParse(p.answer);
        if (!parsed.success) return reject('malformed decide answer');
        return this.replaceQueue(c, parsed.data.actions as Action[]);
      }
      case 'admin.spawn': {
        const err = this.spawn(e.payload);
        return typeof err === 'string' ? reject(err) : undefined;
      }
      case 'admin.edit': {
        const ent = this.state.entities[e.payload.id];
        if (!ent) return reject(`no entity ${e.payload.id}`);
        if (e.payload.pos) {
          if (!inBounds(this.grid, e.payload.pos)) return reject('position out of bounds');
          this.setHeld(ent, null);
          this.move(ent, e.payload.pos);
        }
        if (e.payload.state) this.setState(ent, e.payload.state);
        if (ent.kind === 'character' && (e.payload.needs || e.payload.energy !== undefined)) {
          const values: Record<string, number> = {};
          for (const [k, v] of Object.entries(e.payload.needs ?? {})) if (k in ent.needs) values[k] = ent.needs[k] = clamp01(v);
          if (e.payload.energy !== undefined) values.energy = ent.energy = clamp01(e.payload.energy);
          this.emit({ kind: 'needs', id: ent.id, values });
        }
        return;
      }
      case 'admin.despawn':
        if (!this.state.entities[e.payload.id]) return reject(`no entity ${e.payload.id}`);
        return this.despawn(e.payload.id);
      case 'admin.poke':
        return reject('no mind runtime to poke');
      case 'airdrop.drop':
        return this.drop(e.payload, reject);
      case 'airdrop.remove': {
        const ent = this.entities().find((x) => x.type === 'airdrop' && x.state.dropId === e.payload.dropId);
        if (!ent) return reject(`no airdrop ${e.payload.dropId}`);
        return this.removeAirdrop(ent, 'deleted');
      }
      case 'mail.post': {
        const p = e.payload;
        if (typeof p.text !== 'string' || !p.mailId) return reject('bad mail');
        const box = (this.state.mailbox ??= { queue: [] });
        if (box.queue.some((m) => m.mailId === p.mailId)) return reject(`mail ${p.mailId} exists`);
        const ticks = p.expiresAfterSeconds ? Math.max(1, Math.round(p.expiresAfterSeconds / this.state.config.secondsPerTick)) : 0;
        box.queue.push({ mailId: p.mailId, text: p.text, by: { ...p.by }, postedTick: this.state.tick, ...(ticks && { expiresTick: this.state.tick + ticks }) });
        this.emit({ kind: 'mail', mailId: p.mailId, status: 'waiting' });
        return this.mailboxChanged();
      }
      case 'mail.remove': {
        const box = this.state.mailbox;
        const i = box?.queue.findIndex((m) => m.mailId === e.payload.mailId) ?? -1;
        if (!box || i < 0) return reject(`no waiting mail ${e.payload.mailId}`);
        box.queue.splice(i, 1);
        this.emit({ kind: 'mail', mailId: e.payload.mailId, status: 'deleted' });
        return this.mailboxChanged();
      }
      case 'prompts.activate': {
        const p = e.payload;
        if (!p?.templateId || !p.body?.parts) return reject('bad template activation');
        const prompts = { ...((this.state.ext.prompts as Record<string, Json> | undefined) ?? {}) };
        prompts[p.templateId] = { version: p.version, body: { parts: { ...p.body.parts } } } as unknown as Json;
        this.state.ext.prompts = prompts;
        return;
      }
      case 'pack.loaded':
        if (e.payload.packVersions !== this.registry.packVersions) return reject(`packs ${e.payload.packVersions} are not loaded`);
        this.state.packVersions = e.payload.packVersions;
        return;
      case 'models.load':
      case 'settings.change':
        return; // only meaningful to a mind runtime (and the host)
      case 'sim.config': {
        const p = e.payload;
        const spt = p.secondsPerTick;
        const mtt = p.moveTicksPerTile;
        const ds = p.durationScale;
        if ((spt !== undefined && !(spt > 0)) || (mtt !== undefined && !(Number.isInteger(mtt) && mtt > 0)) || (ds !== undefined && !(ds > 0))) {
          return reject('bad sim.config payload');
        }
        // Re-base the clock first so in-world time is continuous across the rate change.
        const now = this.seconds;
        this.state.clock = { ...this.state.clock!, baseSeconds: now, baseTick: this.state.tick };
        if (spt !== undefined) this.state.config.secondsPerTick = spt;
        if (mtt !== undefined) this.state.config.moveTicksPerTile = mtt;
        if (ds !== undefined) this.state.config.durationScale = ds;
        return this.emit({ kind: 'clock', seconds: now, previous: now, reason: 'rate', timezone: this.state.clock.timezone });
      }
      case 'clock.anchor':
      case 'clock.jump': {
        const p = e.payload;
        if (!Number.isFinite(p.epochMs) || !Number.isFinite(p.tzOffsetMinutes)) return reject('bad clock payload');
        const previous = this.seconds;
        const seconds = Math.round(p.epochMs / 1000) + p.tzOffsetMinutes * 60;
        const clock = this.state.clock!;
        const len = this.state.config.dayLengthSeconds;
        // Anchoring keeps the world's own day count (0 for a new world; for a world that ran before
        // it had a real-time clock, the days it had lived, counted from its ticks), so `day` never
        // becomes days-since-1970. Later jumps keep counting from there.
        const priorDay = clock.anchored ? this.day : Math.floor((this.state.config.startSecond + this.state.tick * this.state.config.secondsPerTick) / len);
        const dayZero = e.type === 'clock.anchor' ? Math.floor(seconds / len) - priorDay : clock.dayZero;
        this.state.clock = { baseSeconds: seconds, baseTick: this.state.tick, dayZero, timezone: p.timezone, anchored: clock.anchored || e.type === 'clock.anchor' };
        return this.emit({ kind: 'clock', seconds, previous, reason: e.type === 'clock.anchor' ? 'anchor' : (p.reason ?? 'realign'), timezone: p.timezone });
      }
      default:
        return reject(`unknown input type ${(e as { type: string }).type}`);
    }
  }

  // ------------------------------------------------------------- action queue

  /** Replace a character's queue, cancelling whatever it was doing. */
  replaceQueue(c: Character, actions: Action[]): void {
    if (c.current) {
      this.actionDelta(c, c.current.action, 'cancelled', 'replaced by a new decision');
      c.current = undefined;
    }
    for (const a of c.queue) this.actionDelta(c, a, 'cancelled', 'replaced by a new decision');
    c.queue = [];
    for (const a of actions) {
      if (c.queue.length >= MAX_QUEUE) this.actionDelta(c, a, 'rejected', `queue holds at most ${MAX_QUEUE} actions`);
      else {
        c.queue.push(a);
        this.actionDelta(c, a, 'queued');
      }
    }
  }

  private startNext(c: Character): void {
    while (!c.current && c.queue.length > 0) {
      const action = c.queue.shift()!;
      const reason = this.begin(c, action);
      if (reason) this.actionDelta(c, action, 'rejected', reason);
      // `begin` may have started a walk towards the target first (see `approach`).
      else this.actionDelta(c, c.current!.action, 'started');
    }
  }

  /**
   * The executor walks to an out-of-range target before using it: a plan step chosen from
   * somewhere else ("play the piano" after "go and look around") would otherwise be rejected.
   * The step goes back to the head of the queue, marked so it walks only once; a target it
   * can't reach, or one someone holds, stays "out of range".
   */
  private approach(c: Character, action: Action, target: AnyEntity): boolean {
    if (action.args?.approached === true || target.heldBy !== undefined) return false;
    const walk: Action = { verb: 'moveTo', targetId: target.id, reason: action.reason || `heading to the ${target.type}`, args: { approach: true } };
    const path = this.planMove(c, walk);
    if (typeof path === 'string' || path.length === 0) return false;
    c.queue.unshift({ ...action, args: { ...action.args, approached: true } });
    c.current = { action: walk, startedTick: this.state.tick, path, nextStepTick: this.state.tick + this.state.config.moveTicksPerTile };
    return true;
  }

  /** Validate and start an action. Returns a rejection reason, or undefined on success. */
  private begin(c: Character, action: Action): string | undefined {
    const tick = this.state.tick;
    const target = action.targetId === undefined ? undefined : this.state.entities[action.targetId];
    if (action.targetId !== undefined && !target) return `no such target ${action.targetId}`;

    const verbDef = this.verbDefOf(target, action.verb);
    if (verbDef && !this.registry.handlers.has(verbDef.handler) && !BUILT_IN_HANDLERS.has(verbDef.handler)) return `${action.verb} does not work here`;
    if (target && verbDef) {
      if (this.reach(c, target) > verbDef.range) return this.approach(c, action, target) ? undefined : 'out of range';
      c.current = { action, startedTick: tick, endsTick: tick + this.scaled(verbDef.durationTicks) };
      return;
    }
    if (!BUILT_INS.has(action.verb)) return target ? `${target.type} has no verb ${action.verb}` : `unknown verb ${action.verb}`;

    switch (action.verb) {
      case 'moveTo': {
        const path = this.planMove(c, action);
        if (typeof path === 'string') return path;
        c.current = { action, startedTick: tick, path, nextStepTick: tick + this.state.config.moveTicksPerTile };
        return;
      }
      case 'follow':
        if (!target || target.id === c.id) return 'follow needs another entity as target';
        c.current = {
          action,
          startedTick: tick,
          endsTick: tick + this.scaled(intArg(action.args?.ticks, 100, 1, 3000)),
          nextStepTick: tick + this.state.config.moveTicksPerTile,
        };
        return;
      case 'vocalize': {
        const notes = action.args?.notes;
        const err = this.checkNotes(c, notes);
        if (err) return err;
        const list = notes as string[];
        c.current = { action, startedTick: tick, endsTick: tick + this.scaled(TICKS_PER_NOTE * list.length) };
        this.emit({ kind: 'vocalize', id: c.id, pos: { ...c.pos }, notes: [...list] });
        this.tickSounds.push({ sourceId: c.id, pos: { ...c.pos }, notes: [...list], loudness: 1 });
        return;
      }
      case 'wait':
        c.current = { action, startedTick: tick, endsTick: tick + this.scaled(intArg(action.args?.ticks, 10, 1, 3000)) };
        return;
      case 'rest':
        c.current = { action, startedTick: tick, endsTick: tick + this.scaled(intArg(action.args?.ticks, 100, 1, 3000)) };
        return;
    }
    return `unknown verb ${action.verb}`;
  }

  /** Progress the head action. Returns true when a timed action is due for resolution. */
  private advance(c: Character): boolean {
    const cur = c.current!;
    const tick = this.state.tick;
    if (cur.action.verb === 'moveTo' && cur.path) {
      if (tick < cur.nextStepTick!) return false;
      let next = cur.path[0];
      if (next && !this.isWalkable(next)) {
        const replanned = this.planMove(c, cur.action);
        if (typeof replanned === 'string') return this.finish(c, 'failed', 'path blocked'), false;
        cur.path = replanned;
        next = cur.path[0];
      }
      if (next) {
        this.move(c, next);
        cur.path.shift();
        cur.nextStepTick = tick + this.state.config.moveTicksPerTile;
      }
      if (cur.path.length === 0) this.finish(c, 'done');
      return false;
    }
    if (cur.action.verb === 'follow' && !this.isObjectVerb(cur.action)) {
      if (tick >= cur.endsTick!) return this.finish(c, 'done'), false;
      const target = this.state.entities[cur.action.targetId!];
      if (!target) return this.finish(c, 'failed', 'lost the target'), false;
      if (tick < cur.nextStepTick!) return false;
      cur.nextStepTick = tick + this.state.config.moveTicksPerTile;
      const step = this.cachedPath(c.pos, { target: target.pos, radius: 1 })?.[0];
      if (step) this.move(c, step);
      return false;
    }
    return tick >= cur.endsTick!;
  }

  /** Effect phase: built-in timed actions just finish; object verbs run their handler. */
  private resolve(c: Character): void {
    const action = c.current!.action;
    if (!this.isObjectVerb(action)) return this.finish(c, 'done');

    const target = this.state.entities[action.targetId!];
    if (!target) return this.finish(c, 'failed', 'the target is gone');
    const def = this.verbDefOf(target, action.verb)!;
    if (this.reach(c, target) > def.range) return this.finish(c, 'failed', 'out of range');

    const ctx = { actor: c, target, world: this, rng: this.streams.get('effects'), params: { ...def.params, ...action.args } };
    const result = BUILT_IN_HANDLERS.has(def.handler) ? this.builtIn(def.handler, ctx, action.verb) : this.registry.handlers.get(def.handler)!(ctx);
    if (!result.ok) return this.finish(c, 'failed', result.reason ?? 'it did not work', result.observation);
    this.applyResult(c, action, target, result);
    if (target.tags.includes('loud')) this.tickSounds.push({ sourceId: target.id, pos: { ...target.pos }, loudness: 0.8 });
    if (result.noise?.length) {
      this.emit({ kind: 'vocalize', id: target.id, pos: { ...target.pos }, notes: [...result.noise] });
      this.tickSounds.push({ sourceId: target.id, pos: { ...target.pos }, notes: [...result.noise], loudness: 1 });
    }
    if (result.takeMail) this.takeMail(c);
    this.finish(c, 'done', undefined, result.observation);
    if (target.type === 'airdrop') {
      if (this.state.entities[target.id]) this.airdropUsed(c, target, action.verb);
      else {
        // Used up by a schema-2 `consume` block (already despawned).
        this.emit({ kind: 'airdrop', event: 'used', dropId: String(target.state.dropId), entityId: target.id, itemId: String(target.state.itemId), verb: action.verb, by: c.id });
        this.emit({ kind: 'airdrop', event: 'removed', dropId: String(target.state.dropId), entityId: target.id, itemId: String(target.state.itemId), pos: { ...target.pos }, reason: 'used up' });
      }
    }
  }

  private finish(c: Character, status: ActionStatus, reason?: string, observation?: string): void {
    this.actionDelta(c, c.current!.action, status, reason, observation);
    c.current = undefined;
  }

  private isObjectVerb(action: Action): boolean {
    const t = action.targetId === undefined ? undefined : this.state.entities[action.targetId];
    return !!this.verbDefOf(t, action.verb);
  }

  // ------------------------------------------------------------- effects

  private applyResult(actor: Character, action: Action, target: Entity, r: EffectResult): void {
    if (r.needDeltas && this.plugin?.applyNeeds) this.plugin.applyNeeds(this, actor, action, target, r.needDeltas);
    else if (r.needDeltas) {
      const values: Record<string, number> = {};
      for (const key of Object.keys(r.needDeltas).sort()) {
        const d = r.needDeltas[key]!;
        // Physical actions never change the battery (decision 42): only thinking drains it, only sleep recharges.
        if (key in actor.needs) values[key] = actor.needs[key] = clamp01(actor.needs[key]! + d);
      }
      this.emit({ kind: 'needs', id: actor.id, values });
    }
    for (const ch of r.stateChanges ?? []) this.applyChange(ch);
    for (const def of r.spawn ?? []) this.spawn(def);
    for (const id of r.despawn ?? []) if (this.state.entities[id]) this.despawn(id);
  }

  private applyChange(ch: StateChange): void {
    const e = this.state.entities[ch.id];
    if (!e) return;
    if (ch.set) this.setState(e, ch.set);
    if (ch.products && e.kind === 'object') {
      e.products = structuredClone(ch.products);
      this.emitView(e);
    }
    if (ch.heldBy !== undefined) this.setHeld(e, ch.heldBy);
    if (ch.pos && inBounds(this.grid, ch.pos)) this.move(e, ch.pos);
  }

  // ------------------------------------------------------------- entity mutation (all deltas originate here)

  private spawn(def: EntityDef): AnyEntity | string {
    const id = def.id ?? `e${String(this.state.nextId++).padStart(4, '0')}`;
    if (this.state.entities[id]) return `entity ${id} already exists`;
    if (!inBounds(this.grid, def.pos)) return 'position out of bounds';
    const arch = this.registry.archetypes.get(def.type);
    const obj = this.registry.objects.get(def.type);
    let entity: AnyEntity;
    if (arch) {
      entity = {
        id,
        kind: 'character',
        type: def.type,
        pos: { ...def.pos },
        tags: [...arch.tags],
        state: { ...def.state },
        needs: Object.fromEntries(Object.keys(arch.needs).map((n) => [n, START_LEVEL])),
        energy: START_LEVEL,
        queue: [],
      };
    } else if (obj) {
      const o: WorldObject = { id, kind: 'object', type: def.type, pos: { ...def.pos }, tags: [...(def.tags ?? obj.tags)], state: { ...obj.state, ...def.state } };
      if (obj.stateSpec) {
        o.stateSpec = structuredClone(obj.stateSpec);
        if (obj.footprint) o.footprint = { ...obj.footprint };
        o.products = (obj.products ?? []).map((p) => ({ slot: p.slot, item: p.item, ready: 0, max: p.max, verb: p.verb, hours: 0, ...(checkCondition(p.when, o.state) && { nextInHours: p.everyHours }) }));
        o.appearance = obj.def2 ? appearanceOf(obj.def2, o.state) : [];
      }
      if (def.createdBy) o.createdBy = { ...def.createdBy };
      if (def.heldBy && this.state.entities[def.heldBy]) {
        o.heldBy = def.heldBy;
        o.pos = { ...this.state.entities[def.heldBy]!.pos };
      }
      entity = o;
    } else return `unknown entity type ${def.type}`;
    if (entity.kind === 'character') this.plugin?.onSpawn?.(this, entity);
    if (entity.type === 'mailbox') entity.state.waiting = this.state.mailbox?.queue.length ?? 0;
    this.state.entities[id] = entity;
    this.sortedIds = undefined;
    if (this.isSolid(entity)) this.state.mapVersion++;
    this.emit({ kind: 'spawned', entity: structuredClone(entity) });
    return entity;
  }

  private despawn(id: EntityId): void {
    const e = this.state.entities[id]!;
    for (const other of this.entities()) if (other.heldBy === id) this.setHeld(other, null);
    if (this.isSolid(e)) this.state.mapVersion++;
    delete this.state.entities[id];
    this.sortedIds = undefined;
    this.emit({ kind: 'despawned', id });
  }

  /** Move an entity and anything it carries. */
  private move(e: AnyEntity, to: Pos): void {
    if (samePos(e.pos, to)) return;
    const from = e.pos;
    e.pos = { ...to };
    if (this.isSolid(e)) this.state.mapVersion++;
    this.emit({ kind: 'moved', id: e.id, from, to: { ...to } });
    for (const carried of this.entities()) if (carried.heldBy === e.id) this.move(carried, to);
  }

  private setHeld(e: AnyEntity, holder: EntityId | null): void {
    if ((e.heldBy ?? null) === holder) return;
    if (holder === null) delete e.heldBy;
    else e.heldBy = holder;
    this.emit({ kind: 'held', id: e.id, heldBy: holder });
    const h = holder === null ? undefined : this.state.entities[holder];
    if (h) this.move(e, h.pos);
  }

  private setState(e: AnyEntity, set: Record<string, Json>): void {
    Object.assign(e.state, structuredClone(set));
    this.emit({ kind: 'state', id: e.id, set: structuredClone(set) });
  }

  // ------------------------------------------------------------- schema-2 objects (docs/architecture/objects.md)

  private readonly dropDefs = new Map<string, ObjectDef | null>();

  /** The engine form of an entity's object type; an airdrop's own item (migrated from schema 1 if needed). */
  objectDefOf(e: Readonly<AnyEntity>): ObjectDef | undefined {
    if (e.kind !== 'object') return undefined;
    if (e.type !== 'airdrop') return this.registry.objects.get(e.type);
    const key = String(e.state.dropId);
    if (!this.dropDefs.has(key)) {
      const item = isRecord(e.state.item) ? migrateToSchema2(e.state.item as Record<string, unknown>) : undefined;
      const r = item ? validateObjectDef2(item, { pack: false }) : undefined;
      this.dropDefs.set(key, r?.ok ? (compileObjectDef(r.def) as ObjectDef) : null);
    }
    return this.dropDefs.get(key) ?? undefined;
  }

  private numericState(e: Readonly<AnyEntity>): Record<string, number> {
    return Object.fromEntries(Object.entries(e.state).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  }

  /** The engine's own handlers: schema-2 blocks, and portable pickup/drop. */
  private builtIn(name: string, ctx: EffectContext, verb: string): EffectResult {
    const { actor, target } = ctx;
    const name2 = this.objectDefOf(target as AnyEntity)?.name?.toLowerCase() ?? target.type;
    const held = this.entities().find((e) => e.heldBy === actor.id);
    if (name === PICKUP_HANDLER) {
      if (target.heldBy === actor.id) return { ok: false, reason: "you're already holding it", observation: `the ${name2} was already in your grippers` };
      if (target.heldBy) return { ok: false, reason: 'someone is already holding it', observation: 'it would not come loose' };
      if (held) return { ok: false, reason: 'already carrying something', observation: 'your grippers were full' };
      return { ok: true, needDeltas: { curiosity: 0.02 }, stateChanges: [{ id: target.id, heldBy: actor.id }], observation: `you picked up the ${name2}` };
    }
    if (name === DROP_HANDLER) {
      return target.heldBy === actor.id
        ? { ok: true, stateChanges: [{ id: target.id, heldBy: null }], observation: `you put the ${name2} down` }
        : { ok: false, reason: 'not holding it', observation: 'there was nothing to let go of' };
    }
    return this.runBlocks(ctx, verb, held);
  }

  /**
   * A schema-2 verb: requirements, then effects in order, all or nothing. Nothing is applied here:
   * the result is applied by the normal effect path, so a failure leaves the world untouched.
   */
  private runBlocks(ctx: EffectContext, verb: string, held: AnyEntity | undefined): EffectResult {
    const { actor, target, params } = ctx;
    const p = params as { requires?: Record<string, Json>; effects?: EffectBlock[]; fail?: string; reset?: Record<string, number> };
    // A failed requirement shows the verb's `fail` text; an effect that can't happen says why.
    const failText = (generic: string): EffectResult => ({ ok: false, reason: p.fail ?? generic, observation: p.fail ?? generic });
    const failEffect = (why: string): EffectResult => ({ ok: false, reason: why, observation: why });
    const req = (p.requires ?? {}) as { self?: Record<string, Json>; holding?: { type?: string; tag?: string; state?: Record<string, Json> }; near?: { type?: string; tag?: string; range: number }; tile?: { tag: string } };
    if (req.self && !checkCondition(req.self as never, target.state)) return failText('it did not work');
    if (req.holding) {
      const h = req.holding;
      if (!held || (h.type && held.type !== h.type) || (h.tag && !held.tags.includes(h.tag)) || (h.state && !checkCondition(h.state as never, held.state))) {
        return failText(h.type ? `you need to be holding the right thing` : 'you need to be holding something');
      }
    }
    if (req.near) {
      const n = req.near;
      const ok = this.entities().some((e) => e.kind === 'object' && e.id !== held?.id && (!n.type || e.type === n.type) && (!n.tag || e.tags.includes(n.tag)) && this.distanceTo(e, actor.pos) <= n.range);
      if (!ok) return failText('nothing suitable is near');
    }
    if (req.tile && !target.tags.includes(req.tile.tag)) return failText('not here');

    const states = new Map<string, Record<string, number>>();
    const cur = (e: Readonly<AnyEntity>) => {
      if (!states.has(e.id)) states.set(e.id, this.numericState(e));
      return states.get(e.id)!;
    };
    const specOf = (e: Readonly<AnyEntity>) => (e.kind === 'object' ? (e.stateSpec ?? this.objectDefOf(e)?.stateSpec ?? {}) : {});
    const out: EffectResult = { ok: true, observation: '', needDeltas: {}, stateChanges: [], spawn: [], despawn: [] };
    const obs: string[] = [];
    let products: ProductState[] | undefined;
    for (const b of p.effects ?? []) {
      const which = (t: string): Readonly<AnyEntity> | undefined => (t === 'held' ? held : (target as AnyEntity));
      switch (b.block) {
        case 'changeState': {
          const e = which(b.target);
          if (!e) return failEffect('you are not holding anything');
          const st = cur(e);
          const spec = specOf(e);
          for (const [k, d] of Object.entries(b.values ?? {})) st[k] = clampState(spec[k], (st[k] ?? 0) + d);
          for (const [k, v] of Object.entries(b.set ?? {})) st[k] = clampState(spec[k], v);
          break;
        }
        case 'affectNeeds':
          for (const [k, v] of Object.entries(b.needs)) if (k !== 'energy') out.needDeltas![k] = (out.needDeltas![k] ?? 0) + v;
          obs.push(b.observation);
          break;
        case 'observe':
          obs.push(b.text);
          break;
        case 'makeNoise':
          out.noise = [...b.notes];
          if (b.observation) obs.push(b.observation);
          break;
        case 'consume': {
          const e = which(b.target);
          if (!e) return failEffect('you are not holding anything');
          const st = cur(e);
          // With a `uses` value it is removed at the start of the next tick once that reaches 0
          // (so minds still see what they just used); without one, straight away.
          if (typeof st.uses === 'number' && specOf(e).uses) st.uses = Math.max(0, st.uses - b.uses);
          else out.despawn!.push(e.id);
          break;
        }
        case 'createObject': {
          let at: Pos | undefined;
          if (b.at === 'here') at = { ...actor.pos };
          else if (b.at === 'target') at = { ...target.pos };
          else at = this.freeTileIn(target as AnyEntity, actor.pos, out.spawn!);
          if (!at) return failEffect('no room');
          out.spawn!.push({ type: b.type, pos: at, createdBy: { entityId: actor.id, tick: this.state.tick } });
          if (b.consumeHeld) {
            if (!held) return failEffect('you are not holding anything');
            out.despawn!.push(held.id);
          }
          break;
        }
        case 'harvest': {
          const prods = products ?? structuredClone((target as WorldObject).products ?? []);
          const slot = prods.find((x) => x.slot === b.slot);
          if (!slot || slot.ready < 1) return failEffect(`there is nothing to ${verb} yet`);
          if (held && !out.despawn!.includes(held.id)) return failEffect('your grippers are full');
          slot.ready -= 1;
          products = prods;
          out.spawn!.push({ type: slot.item, pos: { ...actor.pos }, heldBy: actor.id });
          obs.push(`you took a ${slot.item.replace(/-/g, ' ')}`);
          break;
        }
        case 'handler': {
          const fn = this.registry.handlers.get(b.name);
          if (!fn) return failEffect('it did not work');
          const r = fn({ ...ctx, params: { ...((b.params ?? {}) as Record<string, Json>) } });
          if (!r.ok) return r;
          for (const [k, v] of Object.entries(r.needDeltas ?? {})) out.needDeltas![k] = (out.needDeltas![k] ?? 0) + v;
          out.stateChanges!.push(...(r.stateChanges ?? []));
          out.spawn!.push(...(r.spawn ?? []));
          out.despawn!.push(...(r.despawn ?? []));
          if (r.noise) out.noise = r.noise;
          if (r.takeMail) out.takeMail = true;
          if (r.observation) obs.push(r.observation);
          break;
        }
      }
    }
    if (p.reset) {
      const st = cur(target as AnyEntity);
      for (const [k, v] of Object.entries(p.reset)) st[k] = clampState(specOf(target as AnyEntity)[k], v);
    }
    for (const [id, st] of states) out.stateChanges!.push({ id, set: st });
    if (products) out.stateChanges!.push({ id: target.id, products });
    out.observation = obs.join('; ') || 'nothing happened';
    return out;
  }

  /** The free tile inside an object's footprint nearest `from` (no other object on it). */
  private freeTileIn(e: AnyEntity, from: Pos, pending: readonly EntityDef[]): Pos | undefined {
    const fp = e.kind === 'object' && e.footprint ? e.footprint : { w: 1, h: 1 };
    const tiles: Pos[] = [];
    for (let y = e.pos.y; y < e.pos.y + fp.h; y++) for (let x = e.pos.x; x < e.pos.x + fp.w; x++) tiles.push({ x, y });
    const free = tiles.filter(
      (t) => inBounds(this.grid, t) && !!terrainAt(this.grid, t)?.walkable && !this.entitiesAt(t).some((o) => o.kind === 'object' && o.id !== e.id && !o.heldBy) && !pending.some((d) => samePos(d.pos, t)),
    );
    free.sort((a, b) => manhattan(from, a) - manhattan(from, b) || a.y - b.y || a.x - b.x);
    return free[0];
  }

  /**
   * Rules and product timers on the in-world clock (never the host's). After a clock jump the
   * missed periods are applied one by one, capped at 7 in-world days.
   */
  private runRules(): void {
    const now = Math.floor(this.seconds);
    const last = this.state.rulesSeconds;
    this.state.rulesSeconds = now;
    if (last === undefined || now <= last) return;
    let catchUp: { periods: number; capped: boolean } | undefined;
    for (const [every, P] of Object.entries(PERIOD_SECONDS) as [keyof typeof PERIOD_SECONDS, number][]) {
      const n = Math.floor(now / P) - Math.floor(last / P);
      if (n <= 0) continue;
      const cap = Math.floor((7 * 86_400) / P);
      const k = Math.min(n, cap);
      if (P === 3600 && n > 1) catchUp = { periods: k, capped: n > cap };
      for (const e of this.entities()) {
        if (e.kind !== 'object') continue;
        const def = this.objectDefOf(e);
        const rules = (def?.rules ?? []).filter((r) => r.every === every && (r.change || r.remove));
        const products = P === 3600 ? (def?.products ?? []) : [];
        if (!rules.length && !products.length) continue;
        this.applyPeriods(e, def!, rules, products, k);
      }
    }
    if (catchUp) this.emit({ kind: 'catchUp', seconds: now - last, ...catchUp });
  }

  private applyPeriods(e: WorldObject, def: ObjectDef, rules: NonNullable<ObjectDef['rules']>, products: NonNullable<ObjectDef['products']>, k: number): void {
    const st = this.numericState(e);
    const spec = e.stateSpec ?? def.stateSpec ?? {};
    const prods = structuredClone(e.products ?? []);
    let remove = false;
    for (let i = 0; i < k && !remove; i++) {
      for (const r of rules) {
        if (!checkCondition(r.when, st)) continue;
        if (r.remove) remove = true;
        for (const [key, d] of Object.entries(r.change ?? {})) st[key] = clampState(spec[key], (st[key] ?? 0) + d);
      }
      for (const p of products) {
        const slot = prods.find((x) => x.slot === p.slot);
        if (!slot || !checkCondition(p.when, st)) continue;
        if (slot.ready >= slot.max) continue;
        slot.hours += 1;
        if (slot.hours >= p.everyHours) {
          slot.ready += 1;
          slot.hours = 0;
        }
      }
    }
    for (const slot of prods) {
      const p = products.find((x) => x.slot === slot.slot);
      if (p) {
        // No countdown while full, or while the slot's `when` doesn't hold (it isn't filling).
        if (slot.ready >= slot.max || !checkCondition(p.when, st)) delete slot.nextInHours;
        else slot.nextInHours = Math.round(Math.max(0, p.everyHours - slot.hours) * 10) / 10;
      }
    }
    const changed = Object.fromEntries(Object.entries(st).filter(([key, v]) => e.state[key] !== v));
    if (Object.keys(changed).length) this.setState(e, changed);
    if (products.length && JSON.stringify(prods) !== JSON.stringify(e.products ?? [])) {
      const readyChanged = JSON.stringify(prods.map((x) => [x.ready, x.nextInHours])) !== JSON.stringify((e.products ?? []).map((x) => [x.ready, x.nextInHours]));
      e.products = prods;
      if (readyChanged) this.emitView(e);
    }
    if (remove) this.despawn(e.id);
  }

  /** `nearby` rules: characters in range get the needs, scaled by the time they spend there. */
  private nearbyNeeds(): void {
    for (const e of this.entities()) {
      if (e.kind !== 'object') continue;
      const def = this.objectDefOf(e);
      for (const r of def?.rules ?? []) {
        if (!r.nearby || !checkCondition(r.when, e.state)) continue;
        const scale = this.state.config.secondsPerTick / PERIOD_SECONDS[r.every];
        for (const c of this.characters()) {
          if (this.distanceTo(e, c.pos) > r.nearby.range) continue;
          for (const [k, d] of Object.entries(r.nearby.needs)) if (k in c.needs) c.needs[k] = clamp01(c.needs[k]! + d * scale);
        }
      }
    }
  }

  private emitView(e: WorldObject): void {
    this.emit({ kind: 'objectView', id: e.id, appearance: [...(e.appearance ?? [])], products: (e.products ?? []).map(({ hours: _h, ...v }) => v) });
  }

  /** Keep schema-2 objects' appearance current, with an `objectView` delta on change. */
  private refreshViews(): void {
    for (const e of this.entities()) {
      if (e.kind !== 'object' || !e.stateSpec) continue;
      const def = this.objectDefOf(e);
      const appearance = def?.def2 ? appearanceOf(def.def2, e.state) : [];
      if (JSON.stringify(e.appearance ?? []) !== JSON.stringify(appearance)) {
        e.appearance = appearance;
        this.emitView(e);
      }
    }
  }

  // ------------------------------------------------------------- airdrops and the mailbox

  /** Land a copy of a catalogue item on the nearest free walkable tile. */
  private drop(p: { dropId: string; item: Json; pos: Pos; by: { username: string; admin: boolean; userKey: string }; expiresAfterSeconds?: number }, reject: (r: string) => void): void {
    if (!isRecord(p.item) || typeof p.item.id !== 'string') return reject('bad airdrop item');
    if (this.entities().some((x) => x.type === 'airdrop' && x.state.dropId === p.dropId)) return reject(`airdrop ${p.dropId} exists`);
    if (!this.registry.objects.has('airdrop')) return reject('no airdrop object type loaded');
    const at = this.nearestFreeTile(p.pos);
    if (!at) return reject('no free tile to land on');
    // Schema 2 (schema-1 items are migrated): verbs, state and appearance come from the item.
    const migrated = migrateToSchema2(p.item as Record<string, unknown>);
    const r = validateObjectDef2(migrated, { pack: false });
    if (!r.ok) return reject(`bad airdrop item: ${r.errors[0]!.path} ${r.errors[0]!.message}`);
    const compiled = compileObjectDef(r.def);
    const item = r.def;
    const ticks = p.expiresAfterSeconds ? Math.max(1, Math.round(p.expiresAfterSeconds / this.state.config.secondsPerTick)) : 0;
    const entity = this.spawn({
      id: `drop-${p.dropId}`,
      type: 'airdrop',
      pos: at,
      tags: [...item.tags],
      state: {
        ...compiled.state,
        dropId: p.dropId,
        itemId: item.id,
        item: structuredClone(migrated) as Json,
        verbs: { ...compiled.verbs, scan: { range: 6, durationTicks: 20, handler: 'basic.inspect' } } as unknown as Json,
        droppedBy: { ...p.by },
        droppedTick: this.state.tick,
        ...(ticks && { expiresTick: this.state.tick + ticks }),
      },
    });
    if (typeof entity === 'string') return reject(entity);
    if (entity.kind === 'object') {
      entity.stateSpec = structuredClone(compiled.stateSpec ?? {});
      entity.products = (compiled.products ?? []).map((x) => ({ slot: x.slot, item: x.item, ready: 0, max: x.max, verb: x.verb, hours: 0, ...(checkCondition(x.when, entity.state) && { nextInHours: x.everyHours }) }));
      entity.appearance = appearanceOf(item, entity.state);
      this.emitView(entity);
    }
    this.emit({ kind: 'airdrop', event: 'added', dropId: p.dropId, entityId: entity.id, itemId: item.id, pos: { ...at } });
  }

  /** Breadth-first from the requested tile (clamped to the map): walkable terrain with no object on it. */
  nearestFreeTile(want: Pos): Pos | undefined {
    const g = this.grid;
    const start = { x: Math.min(g.width - 1, Math.max(0, Math.round(want.x))), y: Math.min(g.height - 1, Math.max(0, Math.round(want.y))) };
    const free = (p: Pos) => !!terrainAt(g, p)?.walkable && !this.entitiesAt(p).some((e) => e.kind === 'object');
    const seen = new Set([posKey(start)]);
    const queue = [start];
    while (queue.length) {
      const p = queue.shift()!;
      if (free(p)) return p;
      for (const n of [{ x: p.x, y: p.y - 1 }, { x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }]) {
        if (inBounds(g, n) && !seen.has(posKey(n))) {
          seen.add(posKey(n));
          queue.push(n);
        }
      }
    }
    return undefined;
  }

  /** Consumables count every use; at zero the item is gone. */
  private airdropUsed(c: Character, target: AnyEntity, verb: string): void {
    const dropId = String(target.state.dropId);
    this.emit({ kind: 'airdrop', event: 'used', dropId, entityId: target.id, itemId: String(target.state.itemId), verb, by: c.id });
    if (typeof target.state.usesLeft !== 'number') return;
    // At zero it is removed at the start of the next tick, so this tick's minds still see what they used.
    this.setState(target, { usesLeft: Math.max(0, target.state.usesLeft - 1) });
  }

  private removeAirdrop(e: AnyEntity, reason: 'expired' | 'used up' | 'deleted'): void {
    this.emit({ kind: 'airdrop', event: 'removed', dropId: String(e.state.dropId), entityId: e.id, itemId: String(e.state.itemId), pos: { ...e.pos }, reason });
    this.despawn(e.id);
  }

  /** Expiry and used-up removal happen inside the sim, by tick, so replays match. */
  private expire(): void {
    const tick = this.state.tick;
    for (const e of this.entities()) {
      const usedUp = (typeof e.state.usesLeft === 'number' && e.state.usesLeft <= 0) || (e.kind === 'object' && !!e.stateSpec?.uses && typeof e.state.uses === 'number' && e.state.uses <= 0);
      if (e.type !== 'airdrop') {
        if (usedUp) this.despawn(e.id);
        continue;
      }
      if (usedUp) this.removeAirdrop(e, 'used up');
      else if (typeof e.state.expiresTick === 'number' && e.state.expiresTick <= tick) this.removeAirdrop(e, 'expired');
    }
    const box = this.state.mailbox;
    if (!box) return;
    const expired = box.queue.filter((m) => m.expiresTick !== undefined && m.expiresTick <= tick);
    if (!expired.length) return;
    box.queue = box.queue.filter((m) => !expired.includes(m));
    for (const m of expired) this.emit({ kind: 'mail', mailId: m.mailId, status: 'expired' });
    this.mailboxChanged();
  }

  private takeMail(reader: Character): void {
    const m = this.state.mailbox?.queue.shift();
    if (!m) return;
    this.emit({ kind: 'mail', mailId: m.mailId, status: 'read', readerId: reader.id });
    this.mailboxChanged();
  }

  /** Every mailbox shows the flag through `state.waiting`. */
  private mailboxChanged(): void {
    const waiting = this.state.mailbox?.queue.length ?? 0;
    for (const e of this.entities()) if (e.type === 'mailbox' && e.state.waiting !== waiting) this.setState(e, { waiting });
    this.emit({ kind: 'mailbox', waiting });
  }

  // ------------------------------------------------------------- helpers

  private isSolid(e: AnyEntity): boolean {
    return e.kind === 'object' && !!this.registry.objects.get(e.type)?.solid;
  }

  /** Distance used for verb range; something the actor holds is always in reach. */
  private reach(c: Character, target: AnyEntity): number {
    return target.heldBy === c.id ? 0 : this.distanceTo(target, c.pos);
  }

  /** Manhattan distance to the nearest tile an entity covers (a footprint, or its own tile). */
  distanceTo(e: Readonly<AnyEntity>, pos: Pos): number {
    const fp = e.kind === 'object' ? e.footprint : undefined;
    if (!fp) return manhattan(pos, e.pos);
    const dx = pos.x < e.pos.x ? e.pos.x - pos.x : pos.x > e.pos.x + fp.w - 1 ? pos.x - (e.pos.x + fp.w - 1) : 0;
    const dy = pos.y < e.pos.y ? e.pos.y - pos.y : pos.y > e.pos.y + fp.h - 1 ? pos.y - (e.pos.y + fp.h - 1) : 0;
    return dx + dy;
  }

  private planMove(c: Character, action: Action): Pos[] | string {
    let goal: PathGoal;
    if (action.targetId !== undefined) {
      const t = this.state.entities[action.targetId];
      if (!t) return `no such target ${action.targetId}`;
      // Walk onto pads and balls; stop next to solid objects and characters.
      goal = { target: t.pos, radius: t.kind === 'object' && !this.isSolid(t) ? 0 : 1 };
    } else {
      const { x, y } = action.args ?? {};
      if (typeof x !== 'number' || typeof y !== 'number') return 'moveTo needs a target or args.x and args.y';
      goal = { target: { x, y }, radius: 0 };
      if (!this.isWalkable(goal.target)) return 'destination is not walkable';
    }
    return this.cachedPath(c.pos, goal) ?? 'no path';
  }

  private cachedPath(from: Pos, goal: PathGoal): Pos[] | null {
    const key = `${this.state.mapVersion}|${posKey(from)}|${posKey(goal.target)}|${goal.radius}`;
    let path = this.pathCache.get(key);
    if (path === undefined) {
      if (this.pathCache.size >= PATH_CACHE_MAX) this.pathCache.clear();
      path = findPath(from, goal, (p) => this.isWalkable(p));
      this.pathCache.set(key, path);
    }
    return path && path.map((p) => ({ ...p }));
  }

  private checkNotes(c: Character, notes: Json | undefined): string | undefined {
    const noises = this.registry.archetypes.get(c.type)?.noises;
    if (!noises) return `a ${c.type} cannot vocalize`;
    if (!Array.isArray(notes) || notes.length === 0) return 'vocalize needs args.notes';
    if (notes.length > noises.maxChain) return `at most ${noises.maxChain} notes`;
    for (const n of notes) {
      const [noise, pitch, extra] = typeof n === 'string' ? n.split('-') : [];
      if (extra !== undefined || !noise || !pitch || !noises.set[noise] || !noises.pitches[pitch]) {
        return `unknown note ${JSON.stringify(n)}`;
      }
    }
    return undefined;
  }

  private actionDelta(c: Character, action: Action, status: ActionStatus, reason?: string, observation?: string): void {
    const d: Extract<Delta, { kind: 'action' }> = { kind: 'action', id: c.id, action: structuredClone(action), status };
    if (reason !== undefined) d.reason = reason;
    if (observation !== undefined) d.observation = observation;
    this.emit(d);
  }

  emit(d: Delta): void {
    this.deltas.push(d);
  }
}

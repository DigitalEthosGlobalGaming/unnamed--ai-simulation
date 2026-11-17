import {
  DecideAnswerSchema,
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
  clock?: { baseSeconds: number; baseTick: number; dayZero: number; timezone: string };
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

  constructor(state: WorldState, registry: Registry, plugin?: SimPlugin) {
    if (state.packVersions !== registry.packVersions) {
      throw new Error(`content pack mismatch: world needs ${state.packVersions}, loaded ${registry.packVersions}`);
    }
    state.clock ??= { baseSeconds: state.config.startSecond, baseTick: 0, dayZero: 0, timezone: 'world' };
    this.state = state;
    this.registry = registry;
    this.plugin = plugin;
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
  static fromSnapshot(state: WorldState, registry: Registry, plugin?: SimPlugin): World {
    return new World(structuredClone(state), registry, plugin);
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
    if (event.packVersions !== this.state.packVersions) {
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

    const finished: Character[] = [];
    for (const c of this.characters()) {
      if (!c.current) this.startNext(c);
      if (c.current && this.advance(c)) finished.push(c);
    }
    for (const c of finished) if (this.state.entities[c.id]) this.resolve(c);
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
      case 'models.load':
        return; // only meaningful to a mind runtime
      case 'clock.anchor':
      case 'clock.jump': {
        const p = e.payload;
        if (!Number.isFinite(p.epochMs) || !Number.isFinite(p.tzOffsetMinutes)) return reject('bad clock payload');
        const previous = this.seconds;
        const seconds = Math.round(p.epochMs / 1000) + p.tzOffsetMinutes * 60;
        const clock = this.state.clock!;
        // Anchoring a fresh world starts day 0 on the local date; later jumps keep counting days.
        const dayZero = e.type === 'clock.anchor' ? Math.floor(seconds / this.state.config.dayLengthSeconds) : clock.dayZero;
        this.state.clock = { baseSeconds: seconds, baseTick: this.state.tick, dayZero, timezone: p.timezone };
        return this.emit({ kind: 'clock', seconds, previous, reason: e.type === 'clock.anchor' ? 'anchor' : (p.reason ?? 'realign'), timezone: p.timezone });
      }
      case 'visitor.command': {
        const v = this.state.entities[e.payload.visitorId];
        if (v?.kind !== 'character' || v.state.visitor !== true) return reject(`no visitor ${e.payload.visitorId}`);
        const parsed = DecideAnswerSchema.safeParse({ actions: e.payload.actions });
        if (!parsed.success) return reject('malformed visitor actions');
        return this.replaceQueue(v, parsed.data.actions as Action[]);
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
      else this.actionDelta(c, action, 'started');
    }
  }

  /** Validate and start an action. Returns a rejection reason, or undefined on success. */
  private begin(c: Character, action: Action): string | undefined {
    const tick = this.state.tick;
    const target = action.targetId === undefined ? undefined : this.state.entities[action.targetId];
    if (action.targetId !== undefined && !target) return `no such target ${action.targetId}`;

    const verbDef = target?.kind === 'object' ? this.registry.objects.get(target.type)?.verbs[action.verb] : undefined;
    if (target && verbDef) {
      if (this.reach(c, target) > verbDef.range) return 'out of range';
      c.current = { action, startedTick: tick, endsTick: tick + verbDef.durationTicks };
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
          endsTick: tick + intArg(action.args?.ticks, 100, 1, 3000),
          nextStepTick: tick + this.state.config.moveTicksPerTile,
        };
        return;
      case 'vocalize': {
        const notes = action.args?.notes;
        const err = this.checkNotes(c, notes);
        if (err) return err;
        const list = notes as string[];
        c.current = { action, startedTick: tick, endsTick: tick + TICKS_PER_NOTE * list.length };
        this.emit({ kind: 'vocalize', id: c.id, pos: { ...c.pos }, notes: [...list] });
        this.tickSounds.push({ sourceId: c.id, pos: { ...c.pos }, notes: [...list], loudness: 1 });
        return;
      }
      case 'wait':
        c.current = { action, startedTick: tick, endsTick: tick + intArg(action.args?.ticks, 10, 1, 3000) };
        return;
      case 'rest':
        c.current = { action, startedTick: tick, endsTick: tick + intArg(action.args?.ticks, 100, 1, 3000) };
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
    const def = this.registry.objects.get(target.type)!.verbs[action.verb]!;
    if (this.reach(c, target) > def.range) return this.finish(c, 'failed', 'out of range');

    const handler = this.registry.handlers.get(def.handler)!;
    const result = handler({
      actor: c,
      target,
      world: this,
      rng: this.streams.get('effects'),
      params: { ...def.params, ...action.args },
    });
    if (!result.ok) return this.finish(c, 'failed', result.reason ?? 'it did not work', result.observation);
    this.applyResult(c, action, target, result);
    if (target.tags.includes('loud')) this.tickSounds.push({ sourceId: target.id, pos: { ...target.pos }, loudness: 0.8 });
    this.finish(c, 'done', undefined, result.observation);
  }

  private finish(c: Character, status: ActionStatus, reason?: string, observation?: string): void {
    this.actionDelta(c, c.current!.action, status, reason, observation);
    c.current = undefined;
  }

  private isObjectVerb(action: Action): boolean {
    const t = action.targetId === undefined ? undefined : this.state.entities[action.targetId];
    return t?.kind === 'object' && !!this.registry.objects.get(t.type)?.verbs[action.verb];
  }

  // ------------------------------------------------------------- effects

  private applyResult(actor: Character, action: Action, target: Entity, r: EffectResult): void {
    if (r.needDeltas && this.plugin?.applyNeeds) this.plugin.applyNeeds(this, actor, action, target, r.needDeltas);
    else if (r.needDeltas) {
      const values: Record<string, number> = {};
      for (const key of Object.keys(r.needDeltas).sort()) {
        const d = r.needDeltas[key]!;
        if (key === 'energy') values.energy = actor.energy = clamp01(actor.energy + d);
        else if (key in actor.needs) values[key] = actor.needs[key] = clamp01(actor.needs[key]! + d);
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
      entity = { id, kind: 'object', type: def.type, pos: { ...def.pos }, tags: [...obj.tags], state: { ...obj.state, ...def.state } };
    } else return `unknown entity type ${def.type}`;
    if (entity.kind === 'character') this.plugin?.onSpawn?.(this, entity);
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

  // ------------------------------------------------------------- helpers

  private isSolid(e: AnyEntity): boolean {
    return e.kind === 'object' && !!this.registry.objects.get(e.type)?.solid;
  }

  /** Distance used for verb range; something the actor holds is always in reach. */
  private reach(c: Character, target: AnyEntity): number {
    return target.heldBy === c.id ? 0 : manhattan(c.pos, target.pos);
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

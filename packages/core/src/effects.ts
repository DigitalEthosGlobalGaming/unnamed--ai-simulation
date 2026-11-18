import type { EntityId, Json } from './json.ts';
import type { Grid, Pos } from './grid.ts';
import type { AnyEntity, Character, Entity, EntityDef } from './entities.ts';
import type { Rng } from './rng.ts';
import type { ArchetypeDef } from './pack.ts';
import type { Sound } from './mind-types.ts';

/** Read-only view of the world handed to effect handlers (and later, senses). */
export interface WorldView {
  readonly tick: number;
  /** 0..1 through the in-world day; 0 = midnight. */
  readonly timeOfDay: number;
  readonly isDaylight: boolean;
  readonly grid: Grid;
  entity(id: EntityId): Readonly<AnyEntity> | undefined;
  /** All entities in stable ID order. */
  entities(): readonly Readonly<AnyEntity>[];
  entitiesAt(pos: Pos): readonly Readonly<AnyEntity>[];
  /** Terrain is walkable and no solid object stands there. */
  isWalkable(pos: Pos): boolean;
  archetype(type: string): Readonly<ArchetypeDef> | undefined;
  /** Verb names an object type offers (empty for characters). */
  verbsOf(type: string): string[];
  /** Verb names one entity offers: its type's verbs plus any of its own (airdrops). */
  verbsFor(entity: Readonly<AnyEntity>): string[];
  /** The engine form of an entity's object type (airdrops: their own item), with schema-2 extras. */
  objectDefOf(entity: Readonly<AnyEntity>): import('./pack.ts').ObjectDef | undefined;
  /** Manhattan distance from `pos` to the nearest tile an entity covers (footprints). */
  distanceTo(entity: Readonly<AnyEntity>, pos: Pos): number;
  /** A part of the world's active prompt template, if one was activated (e.g. `mail`/`line`). */
  promptPart(id: string, part: string): string | undefined;
  /** The oldest waiting mailbox message, if any (read-only). */
  mailPeek(): { mailId: string; text: string } | undefined;
  sounds(): readonly Sound[];
}

export interface StateChange {
  id: EntityId;
  set?: Record<string, Json>;
  pos?: Pos;
  /** null = put down. */
  heldBy?: EntityId | null;
  /** Replace the object's product slots (harvest). */
  products?: import('./entities.ts').ProductState[];
}

export interface EffectContext {
  actor: Readonly<Character>;
  target: Readonly<Entity>;
  world: WorldView;
  rng: Rng;
  /** Verb params from the pack JSON merged with the action's args. */
  params: Record<string, Json>;
}

export interface EffectResult {
  ok: boolean;
  reason?: string;
  /** Applied to the actor; key `energy` is the built-in energy need. Before boredom scaling. */
  needDeltas?: Record<string, number>;
  stateChanges?: StateChange[];
  spawn?: EntityDef[];
  despawn?: EntityId[];
  observation: string;
  /** The target makes this note chain (heard like a vocalize). */
  noise?: string[];
  /** Take the oldest mailbox message (the one `mailPeek` returned). */
  takeMail?: boolean;
}

export type EffectHandler = (ctx: EffectContext) => EffectResult;

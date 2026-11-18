import type { EntityId, Json } from './json.ts';
import type { Pos } from './grid.ts';
import type { MindState } from './mind-types.ts';

export interface Entity {
  id: EntityId;
  kind: 'character' | 'object';
  type: string;
  pos: Pos;
  tags: string[];
  state: Record<string, Json>;
  heldBy?: EntityId;
}

export interface Action {
  verb: string;
  targetId?: EntityId;
  args?: Record<string, Json>;
  reason: string;
}

/** The head action while it runs. All fields are plain JSON so they snapshot. */
export interface ActiveAction {
  action: Action;
  startedTick: number;
  /** Timed actions finish at this tick. */
  endsTick?: number;
  /** moveTo / follow: remaining steps and when the next one is due. */
  path?: Pos[];
  nextStepTick?: number;
}

export interface Character extends Entity {
  kind: 'character';
  /** 0..1 per archetype need; 1 = fully satisfied. */
  needs: Record<string, number>;
  /** Built-in need; 0..1. */
  energy: number;
  queue: Action[];
  current?: ActiveAction;
  /** Present when a mind runtime is attached. */
  mind?: MindState;
}

/** A product slot as an entity carries it (`hours` is the fill timer; the view is the rest). */
export interface ProductState {
  slot: string;
  item: string;
  ready: number;
  max: number;
  verb: string;
  /** Hours its condition has held since the last fill. */
  hours: number;
  /** Hours until the next one, while it can still fill. */
  nextInHours?: number;
}

export interface WorldObject extends Entity {
  kind: 'object';
  /** Schema-2 objects (docs/architecture/objects.md): kept current by the sim for viewers and perception. */
  stateSpec?: Record<string, { min: number; max: number }>;
  appearance?: string[];
  products?: ProductState[];
  footprint?: { w: number; h: number };
  createdBy?: { entityId: EntityId; tick: number };
}

export type AnyEntity = Character | WorldObject;

/** What a spawn (admin or effect) asks for; the sim assigns the rest. */
export interface EntityDef {
  type: string;
  pos: Pos;
  id?: EntityId;
  state?: Record<string, Json>;
  /** Replaces the type's default tags (airdrops carry their item's tags). */
  tags?: string[];
  /** Spawn straight into a character's hands (harvest). */
  heldBy?: EntityId;
  /** Made by `createObject` (who, when). */
  createdBy?: { entityId: EntityId; tick: number };
}

export const MAX_QUEUE = 3;

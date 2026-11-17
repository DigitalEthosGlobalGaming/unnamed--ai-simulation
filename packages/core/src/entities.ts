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

export interface WorldObject extends Entity {
  kind: 'object';
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
}

export const MAX_QUEUE = 3;

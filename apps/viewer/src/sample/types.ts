/**
 * SIMULATED DATA. The sample simulator's own internal shapes. They never reach the viewer:
 * `server.ts` translates them into the real `@uas/client` protocol (snapshot state, `Delta[]`,
 * `FeedEntry`), so the viewer has one code path for both sources.
 */
import type { FeedEntry, TriggerKind, Usage } from '@uas/client';

export type { FeedEntry, TriggerKind, Usage };
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Tier = FeedEntry['tier'];
export type FeedAction = FeedEntry['actions'][number];

export interface Vec2 {
  x: number;
  y: number;
}

export interface Entity {
  id: string;
  kind: 'character' | 'object';
  type: string;
  pos: Vec2;
  tags: string[];
  state: Record<string, Json>;
  heldBy?: string;
}

/** Belief as the real core defines it, plus when it formed / was revised (sample only). */
export interface Belief {
  key: string;
  text: string;
  expectedNeedDeltas: Record<string, number>;
  expectedValence: number;
  support: number;
  firmness: number;
  lastSupportedDay: number;
  formedTick: number;
  revisedTick?: number;
}

export type NeedKey = 'cool' | 'signal' | 'curiosity';

export interface MindView {
  energy: number;
  needs: Record<NeedKey, number>;
  valence: number;
  arousal: number;
  mood: string;
  asleep: boolean;
  sleepPressure: number;
  fog: number;
  sleepWork?: SleepWork;
}

export type { Depth, SleepWork } from '../types.ts';
import type { SleepWork } from '../types.ts';

export interface CurrentAction {
  verb: string;
  targetId?: string;
  reason: string;
  startedTick: number;
}

export interface Alert {
  kind: 'energy-low' | 'need-critical' | 'action-rejected';
  text: string;
  tick: number;
}

export interface CharacterView extends Entity {
  kind: 'character';
  name: string;
  heading: number;
  mind: MindView;
  action: CurrentAction | null;
  beliefs: Belief[];
  alerts: Alert[];
  trail: Vec2[];
  sightRange: number;
  hearingRange: number;
}

export interface WorldMap {
  width: number;
  height: number;
  tiles: ('floor' | 'wall' | 'water' | 'path')[];
}

export interface Terrain {
  walkable: boolean;
  blocksSight: boolean;
  kind: 'floor' | 'wall' | 'water' | 'path';
}

/** The sample sim's per-tick changes (translated to real `Delta`s by `server.ts`). */
export type Change =
  | { kind: 'move'; id: string; pos: Vec2; heading: number }
  | { kind: 'mind'; id: string; mind: MindView }
  | { kind: 'action'; id: string; action: CurrentAction | null }
  | { kind: 'noise'; id: string; notes: string[]; pos: Vec2 }
  | { kind: 'belief'; id: string; belief: Belief }
  | { kind: 'alerts'; id: string; alerts: Alert[] }
  | { kind: 'object'; id: string; pos: Vec2; state: Record<string, Json>; heldBy?: string }
  | { kind: 'spawn'; entity: Entity & { createdBy?: { entityId: string; tick: number } } }
  | { kind: 'despawn'; id: string }
  | { kind: 'spend'; spendTodayAud: number };

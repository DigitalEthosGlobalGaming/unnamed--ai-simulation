/**
 * Viewer types. Wire shapes (Delta, FeedEntry, Belief, Usage, the snapshot state, the catalog)
 * come from `@uas/client`; what is defined here is the viewer's own view model, derived from
 * a snapshot plus deltas (see `client/view.ts`), and the connection interface both data
 * sources implement (`source/real.ts` over the server, `sample/server.ts` offline).
 */
import type { Belief, Delta, FeedEntry, Noises, ServerMessage, WorldCatalog, WorldStateView } from '@uas/client';

export type { Belief, Delta, FeedEntry, Noises, ServerMessage, WorldCatalog, WorldStateView };
export type { Json, TriggerKind, Usage } from '@uas/client';
export type Tier = FeedEntry['tier'];

export interface Vec2 {
  x: number;
  y: number;
}

export interface WorldClock {
  tick: number;
  ticksPerSecond: number;
  secondsPerTick: number;
  dayLengthSeconds: number;
  /** In-world second at tick 0. */
  startSecond: number;
}

/** Terrain as the plan draws it; derived from the grid's terrain keys and properties. */
export type TileKind = 'floor' | 'path' | 'wall' | 'water' | 'rock';

export interface WorldMap {
  width: number;
  height: number;
  tiles: TileKind[]; // row-major
}

export interface ObjectView {
  id: string;
  kind: 'object';
  type: string;
  pos: Vec2;
  state: Record<string, unknown>;
  heldBy?: string;
}

export interface MindView {
  energy: number; // battery 0..1
  needs: Record<string, number>;
  valence: number;
  arousal: number;
  mood: string;
  asleep: boolean;
}

export interface CurrentAction {
  verb: string;
  targetId?: string;
  reason: string;
  startedTick: number;
}

export type AlertKind = 'energy-low' | 'need-critical' | 'action-rejected';

export interface Alert {
  kind: AlertKind;
  text: string; // short red-pen note, e.g. 'BATTERY 9%'
  tick: number;
}

export interface CharacterView {
  id: string;
  kind: 'character';
  type: string;
  name: string;
  pos: Vec2;
  heading: number; // radians, 0 = east
  mind: MindView;
  action: CurrentAction | null;
  beliefs: Belief[];
  alerts: Alert[];
  trail: Vec2[];
  sightRange: number;
  hearingRange: number;
  visitor: boolean;
}

export interface WorldView {
  worldId: string;
  name: string;
  packs: string[];
  clock: WorldClock;
  map: WorldMap;
  objects: ObjectView[];
  characters: CharacterView[];
  spendTodayAud: number;
  capAud: number | null;
}

export type ConnectionStatus = 'connecting' | 'live' | 'disconnected';

/** Server messages plus the connection's own status and spend notices. */
export type ViewerMessage =
  | ServerMessage
  | { type: 'status'; status: ConnectionStatus; detail?: string }
  | { type: 'spend'; spendTodayAud: number };

/** A belief change on the timeline (from `beliefs` deltas). */
export interface BeliefMark {
  tick: number;
  characterId: string;
}

/** What the viewer needs from a data source. `@uas/client` backs the real one. */
export interface WorldConnection {
  /** Display data (objects, archetypes, cap). Available once status is 'live'. */
  catalog(): WorldCatalog | null;
  subscribe(onMessage: (m: ViewerMessage) => void): () => void;
  /** Recorded brain feed up to a tick (REST `GET /worlds/:id/feed` plus the live feed). */
  feedUntil(tick: number): FeedEntry[];
  /** Where beliefs changed, for the timeline markers. */
  beliefMarks(): BeliefMark[];
  /** Earliest and latest ticks, for the scale bar. */
  range(): { from: number; to: number };
  /** Current beliefs of a character (REST `/memories`); optional for offline sources. */
  memories?(characterId: string): Promise<Belief[]>;
  seek(tick: number): void;
  play(speed: number): void;
  pause(): void;
  goLive(): void;
  reconnect(): void;
}

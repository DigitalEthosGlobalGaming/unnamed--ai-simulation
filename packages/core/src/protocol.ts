import type { Delta, FeedEntry, FeedStepStatus } from './events.ts';

/** WebSocket protocol between frontends and `@uas/server`. */
export type Channel = 'deltas' | 'feed' | 'noises';
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ClientMessage =
  | { type: 'subscribe'; worldId: string; channels?: Channel[]; region?: Region }
  | { type: 'unsubscribe'; worldId: string }
  | { type: 'replay.open'; worldId: string; tick: number }
  | { type: 'play'; sessionId: string; speed?: number }
  | { type: 'pause'; sessionId: string }
  | { type: 'seek'; sessionId: string; tick: number }
  | { type: 'replay.close'; sessionId: string };

/** `state` is the full `WorldState` from @uas/sim (entities, clock config, minds). */
export type ServerMessage =
  | { type: 'snapshot'; worldId: string; sessionId?: string; tick: number; state: unknown }
  | { type: 'deltas'; worldId: string; sessionId?: string; tick: number; changes: Delta[] }
  | { type: 'feed'; worldId: string; sessionId?: string; entry: FeedEntry }
  /** A step of a feed entry resolved: update `actions[step]` of the entry with this `characterId` and `tick === feedTick`. */
  | { type: 'feedStep'; worldId: string; sessionId?: string; characterId: string; feedTick: number; step: number; status: FeedStepStatus; result?: string }
  | { type: 'noises'; worldId: string; sessionId?: string; tick: number; noises: Extract<Delta, { kind: 'vocalize' }>[] }
  | { type: 'replay.opened'; worldId: string; sessionId: string; tick: number }
  | { type: 'replay.ended'; sessionId: string; tick: number }
  | { type: 'error'; message: string };

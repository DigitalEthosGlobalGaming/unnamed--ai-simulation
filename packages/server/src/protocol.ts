import type { Delta, InputEvent } from '@uas/core';
import type { WorldState } from '@uas/sim';
import type { WorldFile } from './config.ts';
import type { WorldStatus } from './runtime.ts';

/** Data the supervisor hands a new worker. Plain structured-clone data only. */
export interface WorkerInit {
  config: WorldFile;
  dbPath: string;
  initialState?: WorldState;
  parent?: { worldId: string; forkTick: number };
}

export type WorkerMethod =
  | { method: 'submit'; type: string; payload: unknown; causedBy?: InputEvent['causedBy'] }
  | { method: 'clock'; paused?: boolean; timeScale?: number; watched?: boolean; realign?: boolean }
  | { method: 'status' }
  | { method: 'state' }
  | { method: 'mind'; characterId: string }
  | { method: 'memories'; characterId: string }
  | { method: 'usage'; day?: string }
  | { method: 'settings' }
  | { method: 'setSettings'; patch: unknown; userId?: string }
  | { method: 'shutdown' };

export type ToWorker = { type: 'call'; id: number } & WorkerMethod;

export type FromWorker =
  | { type: 'ready'; status: WorldStatus }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'deltas'; worldId: string; tick: number; changes: Delta[] }
  | { type: 'status'; status: WorldStatus }
  | { type: 'log'; message: string };

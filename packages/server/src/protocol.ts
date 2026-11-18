import type { ObjectDef2, Delta, InputEvent, JobRequest, Pos, Sender } from '@uas/core';
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
  | { method: 'airdrops' }
  | { method: 'airdrop'; dropId: string }
  | { method: 'drop'; item: ObjectDef2; pos: Pos; by: Sender }
  | { method: 'removeAirdrop'; dropId: string; userId?: string }
  | { method: 'mail'; userKey?: string; admin: boolean }
  | { method: 'postMail'; text: unknown; by: Sender }
  | { method: 'removeMail'; mailId: string; userId?: string }
  | { method: 'prompts' }
  /** One object's current state (for its history), or null. */
  | { method: 'objectState'; objectId: string }
  /** One metered model call for a prompt test: through the world's gateway, counted towards its daily cap. */
  | { method: 'modelCall'; model: string; request: JobRequest; as: 'decide' | 'plan' }
  | { method: 'shutdown' };

export type ToWorker = { type: 'call'; id: number } & WorkerMethod;

export type FromWorker =
  | { type: 'ready'; status: WorldStatus }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'deltas'; worldId: string; tick: number; changes: Delta[] }
  | { type: 'status'; status: WorldStatus }
  | { type: 'log'; message: string };

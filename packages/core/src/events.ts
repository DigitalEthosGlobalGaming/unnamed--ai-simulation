import { z } from 'zod';
import type { EntityId, Json, WorldId } from './json.ts';
import type { Pos } from './grid.ts';
import type { Action, AnyEntity, EntityDef } from './entities.ts';
import type { Belief, Memory, MemoryId, SleepPhase, VisitorRequest } from './mind-types.ts';

export type JobName = 'decide' | 'route' | 'appraise' | 'scoreMemory' | 'vocalize' | 'plan' | 'reflect' | 'embed';

export type TriggerKind =
  | 'sensed'
  | 'heard-noise'
  | 'action-finished'
  | 'action-rejected'
  | 'need-threshold'
  | 'idle-timeout'
  | 'woke-up'
  | 'admin-poke';

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costAud: number;
  latencyMs: number;
  modelId: string;
}

// ---------------------------------------------------------------- input log

export interface InputEvent<T = unknown> {
  worldId: WorldId;
  seq: number;
  tick: number;
  type: string;
  payload: T;
  packVersions: string;
  causedBy?: { jobId?: string; userId?: string };
}

export interface ModelAnswerPayload {
  jobId: string;
  job: JobName;
  characterId: EntityId;
  modelId: string;
  promptHash: string;
  answer: Json;
  usage: Usage;
}

/** `answer` shape for job `decide`: replaces the character's queue. */
export interface DecideAnswer {
  actions: Action[];
}

export type AdminSpawnPayload = EntityDef;
export interface AdminEditPayload {
  id: EntityId;
  pos?: Pos;
  state?: Record<string, Json>;
  /** Characters only: set need levels (0..1). */
  needs?: Record<string, number>;
  /** Characters only: set energy (0..1). */
  energy?: number;
}
export interface AdminDespawnPayload {
  id: EntityId;
}
export interface AdminPokePayload {
  characterId: EntityId;
}
/** A visitor's own actions. Anything aimed at a character also joins that character's visitor queue. */
/**
 * Wall-clock alignment, set by the server (the sim never reads a clock). `epochMs` is real UTC
 * time; `tzOffsetMinutes` the world timezone's offset at that instant, so the world's time of
 * day equals local wall time. `clock.anchor` starts a world; `clock.jump` re-aligns it after
 * downtime, a pause, a speed-up, or drift.
 */
export interface ClockPayload {
  epochMs: number;
  tzOffsetMinutes: number;
  timezone: string;
  reason?: 'restart' | 'resume' | 'realign' | 'sync';
}

/** Change sim timing on an existing world (e.g. when it switches to real time), logged so replays follow. */
export interface SimConfigPayload {
  secondsPerTick?: number;
  moveTicksPerTile?: number;
  durationScale?: number;
}

/** A live settings change from an admin; the mind applies its part (energy rate, need decay). */
export interface SettingsChangePayload {
  changes: Record<string, number | boolean>;
}

/** Host-reported model load (outside the sim), recorded so replays see the same signal. */
export interface ModelsLoadPayload {
  busy: boolean;
}
export interface VisitorCommandPayload {
  visitorId: EntityId;
  actions: Action[];
}

export interface InputPayloads {
  'model.answer': ModelAnswerPayload;
  'admin.spawn': AdminSpawnPayload;
  'admin.edit': AdminEditPayload;
  'admin.despawn': AdminDespawnPayload;
  'admin.poke': AdminPokePayload;
  'visitor.command': VisitorCommandPayload;
  'models.load': ModelsLoadPayload;
  'clock.anchor': ClockPayload;
  'clock.jump': ClockPayload;
  'sim.config': SimConfigPayload;
  'settings.change': SettingsChangePayload;
}
export type InputType = keyof InputPayloads;

/** Discriminated union of the input events the sim understands. */
export type SimInputEvent = { [K in InputType]: InputEvent<InputPayloads[K]> & { type: K } }[InputType];

// ---------------------------------------------------------------- delta stream

export type ActionStatus = 'queued' | 'started' | 'done' | 'failed' | 'rejected' | 'cancelled';

export type Delta =
  | { kind: 'spawned'; entity: AnyEntity }
  | { kind: 'despawned'; id: EntityId }
  | { kind: 'moved'; id: EntityId; from: Pos; to: Pos }
  | { kind: 'state'; id: EntityId; set: Record<string, Json> }
  | { kind: 'held'; id: EntityId; heldBy: EntityId | null }
  | { kind: 'needs'; id: EntityId; values: Record<string, number> }
  | {
      kind: 'action';
      id: EntityId;
      action: Action;
      status: ActionStatus;
      reason?: string;
      observation?: string;
    }
  | { kind: 'vocalize'; id: EntityId; pos: Pos; notes: string[] }
  | { kind: 'inputRejected'; seq: number; type: string; reason: string }
  /** The world clock was anchored or jumped; `seconds` are local wall-clock seconds since the epoch. */
  | { kind: 'clock'; seconds: number; previous: number; reason: string; timezone: string }
  | { kind: 'mood'; id: EntityId; valence: number; arousal: number; word: string }
  | { kind: 'feed'; entry: FeedEntry }
  | { kind: 'memory'; id: EntityId; memory: Memory; evicted?: MemoryId }
  | { kind: 'beliefs'; id: EntityId; beliefs: Belief[] }
  | { kind: 'sleep'; id: EntityId; phase: SleepPhase }
  | { kind: 'diary'; id: EntityId; day: number; text: string }
  | { kind: 'visitorQueue'; id: EntityId; queue: VisitorRequest[] }
  | { kind: 'visitorPick'; id: EntityId; request: VisitorRequest }
  | { kind: 'visitorDropped'; id: EntityId; request: VisitorRequest; reason: 'expired' | 'queue full' };

export interface TickDeltas {
  tick: number;
  changes: Delta[];
}

// ---------------------------------------------------------------- brain feed

export interface FeedEntry {
  tick: number;
  characterId: EntityId;
  trigger: TriggerKind;
  tier: 'carry-on' | 'autopilot' | 'local' | 'decision' | 'llm' | 'fallback';
  modelId?: string;
  confidence?: number;
  actions: {
    verb: string;
    targetId?: EntityId;
    reason: string;
    status: 'queued' | 'rejected' | 'done' | 'failed';
  }[];
  usage?: Usage;
  energyCost?: number;
  notes?: string[];
  /** Why a fallback happened, e.g. 'queued too long'. */
  reason?: string;
}

// ---------------------------------------------------------------- validation


const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

export const ActionSchema = z.strictObject({
  verb: z.string().min(1),
  targetId: z.string().optional(),
  args: z.record(z.string(), jsonValue).optional(),
  reason: z.string(),
});

export const DecideAnswerSchema = z.strictObject({ actions: z.array(ActionSchema) });

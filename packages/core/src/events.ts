import { z } from 'zod';
import type { EntityId, Json, WorldId } from './json.ts';
import type { Pos } from './grid.ts';
import type { Action, AnyEntity, EntityDef } from './entities.ts';
import type { Belief, Habit, Memory, MemoryId, SheetEdit, SheetLine, SleepPhase } from './mind-types.ts';

export type JobName = 'decide' | 'route' | 'appraise' | 'scoreMemory' | 'vocalize' | 'plan' | 'reflect' | 'consolidate' | 'sheet' | 'embed';

/** How hard the robot chose to think: habit (free), gut (decision model) or think it through (plan model). */
export type ThinkingDepth = 'habit' | 'gut' | 'think';

/** Steps of the sleep pipeline, in order. */
export type SleepWorkStep = 'consolidating' | 'habits' | 'sheet' | 'refine' | 'done';

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

/** A world moved to new content pack versions (logged, so replays know where the change happened). */
export interface PackLoadedPayload {
  packVersions: string;
}

/** Who sent a visitor input: shown publicly as the username; `userKey` (a pseudonymous hash) rate-limits. */
export interface Sender {
  username: string;
  admin: boolean;
  userKey: string;
}
/** Airdrop: a copy of the catalogue item's JSON lands near `pos` (snapped to the nearest free walkable tile). */
export interface AirdropDropPayload {
  dropId: string;
  item: Json;
  pos: Pos;
  by: Sender;
  /** 0 or absent: never expires. */
  expiresAfterSeconds?: number;
}
export interface AirdropRemovePayload {
  dropId: string;
  reason: 'deleted';
}
/** A message for the world's mailbox (already length-capped and filtered by the server). */
export interface MailPostPayload {
  mailId: string;
  text: string;
  by: Sender;
  expiresAfterSeconds?: number;
}
export interface MailRemovePayload {
  mailId: string;
}

/** Change sim timing on an existing world (e.g. when it switches to real time), logged so replays follow. */
export interface SimConfigPayload {
  secondsPerTick?: number;
  moveTicksPerTile?: number;
  durationScale?: number;
}

/** A live settings change from an admin; the mind applies its part (energy rate, need decay). */
export interface SettingsChangePayload {
  changes: Record<string, number | boolean | string[]>;
}

/** Host-reported model load (outside the sim), recorded so replays see the same signal. */
export interface ModelsLoadPayload {
  busy: boolean;
}

export interface InputPayloads {
  'model.answer': ModelAnswerPayload;
  'admin.spawn': AdminSpawnPayload;
  'admin.edit': AdminEditPayload;
  'admin.despawn': AdminDespawnPayload;
  'admin.poke': AdminPokePayload;
  'models.load': ModelsLoadPayload;
  'clock.anchor': ClockPayload;
  'clock.jump': ClockPayload;
  'sim.config': SimConfigPayload;
  'settings.change': SettingsChangePayload;
  'pack.loaded': PackLoadedPayload;
  'airdrop.drop': AirdropDropPayload;
  'airdrop.remove': AirdropRemovePayload;
  'mail.post': MailPostPayload;
  'mail.remove': MailRemovePayload;
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
  /** An airdropped item landed, was used (a verb completed on it) or was removed. */
  | { kind: 'airdrop'; event: 'added' | 'used' | 'removed'; dropId: string; entityId: EntityId; itemId: string; pos?: Pos; verb?: string; by?: EntityId; reason?: 'expired' | 'used up' | 'deleted' }
  /** How many messages wait in the mailbox (drives its flag). */
  | { kind: 'mailbox'; waiting: number }
  /** A message changed status. Never carries the text (waiting text is private). */
  | { kind: 'mail'; mailId: string; status: 'waiting' | 'read' | 'expired' | 'deleted'; readerId?: EntityId }
  /** The world clock was anchored or jumped; `seconds` are local wall-clock seconds since the epoch. */
  | { kind: 'clock'; seconds: number; previous: number; reason: string; timezone: string }
  | { kind: 'mood'; id: EntityId; valence: number; arousal: number; word: string }
  | { kind: 'feed'; entry: FeedEntry }
  /** A step of an earlier feed entry resolved (the entry is identified by character and its `tick`). */
  | { kind: 'feedStep'; characterId: EntityId; feedTick: number; step: number; status: FeedStepStatus; result?: string }
  | { kind: 'memory'; id: EntityId; memory: Memory; evicted?: MemoryId }
  | { kind: 'beliefs'; id: EntityId; beliefs: Belief[] }
  | { kind: 'sleep'; id: EntityId; phase: SleepPhase }
  /** Sleep pressure and fog (0..1), sent when either moves by 0.01 or more. */
  | { kind: 'pressure'; id: EntityId; sleepPressure: number; fog: number }
  /** The sleep pipeline moved on (`done`/`total`: e.g. memories consolidated). */
  | { kind: 'sleepWork'; id: EntityId; step: SleepWorkStep; done?: number; total?: number }
  /** The character sheet changed (one step per sleep), or the goal did. */
  | { kind: 'sheet'; id: EntityId; sheet: SheetLine[]; goal?: string; edit: SheetEdit }
  /** Habits after a sleep's habit detection. */
  | { kind: 'habits'; id: EntityId; habits: Habit[] }
  | { kind: 'diary'; id: EntityId; day: number; text: string };

export interface TickDeltas {
  tick: number;
  changes: Delta[];
}

// ---------------------------------------------------------------- brain feed

/** How a queued step ended: ran, failed while running, rejected before starting, or dropped for a newer decision. */
export type FeedStepStatus = 'done' | 'failed' | 'rejected' | 'superseded';

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
    status: 'queued' | FeedStepStatus;
    /** What happened: the observation when it ran, or why it failed or was rejected. */
    result?: string;
  }[];
  usage?: Usage;
  energyCost?: number;
  notes?: string[];
  /** Why a fallback happened, e.g. 'queued too long'. */
  reason?: string;
  /** How hard it chose to think (absent for carry-on and fallbacks), and why. */
  depth?: ThinkingDepth;
  depthWhy?: string;
  /** The decision model was unsure, so this was planned by a text model: which model, and its confidence. */
  escalated?: { from: string; confidence: number };
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

import type { EntityId, Json } from './json.ts';
import type { Pos } from './grid.ts';
import type { Action, Character } from './entities.ts';
import type { WorldView } from './effects.ts';
import type { JobName, TriggerKind } from './events.ts';

// ---------------------------------------------------------------- senses

export interface Observation {
  sense: string;
  subjectId?: EntityId;
  kind: string;
  summary: string;
  affordances?: string[];
  salience: number;
  features?: Record<string, number>;
}

export interface Sense {
  /** e.g. 'basic.sight' */
  id: string;
  /** Ticks; default: every tick, diffed so a still scene costs nothing. */
  runEvery?: number;
  observe(self: Readonly<Character>, world: WorldView): Observation[];
}

/** A sound made this tick: a vocalize, or a verb used on an object tagged `loud`. */
export interface Sound {
  sourceId: EntityId;
  pos: Pos;
  notes?: string[];
  /** 0..1 at the source. */
  loudness: number;
}

// ---------------------------------------------------------------- memory and beliefs

export type MemoryId = string;

export interface Memory {
  id: MemoryId;
  store: 'stm' | 'ltm';
  tick: number;
  day: number;
  kind: 'outcome' | 'noise' | 'person' | 'place' | 'fact' | 'feeling';
  text: string;
  /** `when` is the felt time of day, so day and night outcomes form separate beliefs. */
  about: { verb?: string; objectType?: string; entityId?: EntityId; place?: string; when?: 'day' | 'night' };
  valence: number;
  strength: number;
  recalls: number;
  recallDays: number[];
  /** Tick of admission or last recall; Δt in the worth formula. */
  lastRecallTick: number;
  /** Need changes the mind felt over the action (outcome memories only). */
  felt?: Record<string, number>;
  embedding?: number[];
}

export interface Belief {
  /** 'charge:solarPad@night' */
  key: string;
  text: string;
  expectedNeedDeltas: Record<string, number>;
  expectedValence: number;
  support: number;
  firmness: number;
  lastSupportedDay: number;
}

export interface OpenItem {
  id: string;
  kind: 'promise' | 'person' | 'question' | 'want' | 'unfinished';
  text: string;
  weight: number;
  tick: number;
  about?: string;
}

export interface SheetLine {
  text: string;
  locked: boolean;
  source: 'authored' | 'self';
  /** Self lines: days the pattern was seen, and the last one. */
  seenDays?: number[];
}

// ---------------------------------------------------------------- brain

export interface Trigger {
  kind: TriggerKind;
  tick: number;
  salience: number;
  detail?: string;
}

/** A candidate action offered to autopilot or a model, built by code. */
export interface Candidate {
  id: string;
  label: string;
  actions: Action[];
  /** 'verb:objectType' or 'verb:self'. */
  key: string;
}

export interface PendingJob {
  jobId: string;
  job: JobName;
  tick: number;
  deadlineTick: number;
  trigger: TriggerKind;
  candidates?: Candidate[];
  /** appraise / scoreMemory: the outcome draft they refine. */
  draftId?: string;
}

export interface OutcomeDraft {
  id: string;
  tick: number;
  memory: Omit<Memory, 'id' | 'store' | 'recalls' | 'recallDays' | 'lastRecallTick'>;
  waitingFor: JobName[];
}

export type SleepPhase = 'awake' | 'drowsy' | 'asleep';

/** A visitor interaction aimed at a character, waiting for its brain to be free. */
export interface VisitorRequest {
  id: string;
  visitorId: EntityId;
  kind: 'noise' | 'action';
  /** e.g. 'beep-C chirp-E' or 'push ball' */
  detail: string;
  notes?: string[];
  tick: number;
}

export interface MindState {
  mood: { valence: number; arousal: number; word: string; bias: number };
  boredom: Record<string, { b: number; tick: number }>;
  openItems: OpenItem[];
  stm: Memory[];
  ltm: Memory[];
  beliefs: Belief[];
  sheet: SheetLine[];
  /** What the senses reported last time, by diff key; for change-only emission. */
  lastObs: Record<string, number>;
  /** The mind's own map of perceived objects: the only source of candidates. */
  known: Record<EntityId, { type: string; pos: Pos; affordances: string[]; tick: number }>;
  heard: { notes: string[]; tick: number; fromId?: EntityId }[];
  usedChains: { notes: string[]; valence: number }[];
  triggers: Trigger[];
  pendingJobs: PendingJob[];
  drafts: OutcomeDraft[];
  /** Needs at the start of the head action, to feel its outcome. */
  actionStart?: { tick: number; needs: Record<string, number>; energy: number; verb: string };
  idleSince: number;
  sleep: SleepPhase;
  /** Day of the last finished reflection. */
  reflectedDay: number;
  /** Lines of today's diary, the input to reflection. */
  diaryToday: string[];
  /** The cached prompt prefix; rebuilt only at sleep or content reload. */
  prefix: { rules: string; sheet: string; beliefs: string; day: number };
  energyFloorLatched: boolean;
  nextId: number;
  /** Felt words last tick, to detect threshold crossings. */
  lastLevels: Record<string, string>;
  visitorQueue: VisitorRequest[];
  visitorCooldownUntil: number;
  /** Steps of a model plan beyond the 3-action queue; followed without another model call until they expire. */
  planSteps?: { actions: Action[]; untilTick: number; tier: 'decision' | 'llm' | 'local' };
}

// ---------------------------------------------------------------- prompts and jobs

/** Fixed order; the first three blocks are the cached prefix. */
export interface PromptParts {
  rules: string;
  sheet: string;
  beliefs: string;
  shortTerm: string;
  state: string;
  observations: string;
  question: string;
}

export const PROMPT_ORDER = ['rules', 'sheet', 'beliefs', 'shortTerm', 'state', 'observations', 'question'] as const;
export const CACHED_PARTS = 3;

/** A job the brain wants run. The host sends it to the gateway; the answer returns as `model.answer`. */
export interface JobRequest {
  jobId: string;
  job: JobName;
  characterId: EntityId;
  tick: number;
  /** For router conditions. */
  energy: number;
  isNight: boolean;
  context: PromptParts;
  question: string;
  options?: { id: string; label: string }[];
  multi?: { max: number };
  /** Extra structured input, e.g. the outcome being appraised. */
  input?: Json;
}

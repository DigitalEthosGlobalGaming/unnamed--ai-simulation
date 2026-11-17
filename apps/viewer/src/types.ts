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
  /** In-world time anchor: seconds = baseSeconds + (tick − baseTick) × secondsPerTick. */
  baseSeconds: number;
  baseTick: number;
  /** Ticks per tile step, to pace movement between `moved` deltas. */
  moveTicksPerTile: number;
  /** Real-time worlds: in-world time is local wall-clock time (seconds since the epoch, read in UTC). */
  realtime: boolean;
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
  /** Sleep pressure 0..1 (time awake and short-term memory fullness); recharge in sleep scales with it. */
  sleepPressure?: number;
  /** Short-term memory fullness as the robot feels it, 0..1. */
  fog?: number;
  /** What sleep is doing now, while asleep. */
  sleepWork?: SleepWork;
}

export type SleepStep = 'consolidating' | 'habits' | 'sheet' | 'refine' | 'done';
export interface SleepWork {
  step: SleepStep;
  done?: number;
  total?: number;
}

/** How hard the robot chose to think for a decision (iteration 2). */
export type Depth = 'habit' | 'gut' | 'think';

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
  /** The last whole-tile step and when it arrived (performance.now()), to draw it gliding. */
  step?: { from: Vec2; to: Vec2; at: number };
  sightRange: number;
  hearingRange: number;
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
  | { type: 'spend'; spendTodayAud: number }
  /** World status the viewer paces itself by (`WorldStatus.clockMode`, effective tick rate). */
  | { type: 'pace'; realtime: boolean; ticksPerRealSecond: number };

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
  /** Older brain feed before a tick (REST `?beforeTick=`): the newest `limit`, oldest first. */
  feedBefore?(beforeTick: number, limit: number, characterId?: string): Promise<FeedEntry[]>;
  /** How many of the oldest loaded feed entries were dropped to keep memory bounded (keeps revision numbers stable). */
  feedTrimmed?(): number;
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
  /** Sign-in and world settings, when the source supports them. */
  account?: AccountApi;
  /** Catalogue, airdrops and the mailbox, when the source supports them. */
  visitors?: VisitorApi;
}

/* ------------------------------------------------- accounts and world settings
   Contract: GET /auth/me, GET /auth/login?returnTo=, POST /auth/logout,
   GET/PATCH /worlds/:id/settings (built by the backend in parallel; the sample mocks it). */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

export interface AuthState {
  user: AuthUser | null;
  role: 'admin' | 'visitor' | 'spectator';
  /** Whether "Sign in with Vercel" is configured on this server. */
  loginAvailable: boolean;
}

export interface SettingField {
  label: string;
  /** `items`: a list of catalogue item ids (e.g. `catalogEnabled`), shown as a checklist. */
  kind: 'number' | 'boolean' | 'string[]';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}

export type SettingValue = number | boolean | string[];

export interface WorldSettings {
  values: Record<string, SettingValue>;
  schema: Record<string, SettingField>;
  derived: {
    /** True while the average decision cost is an estimate (no decision made today yet). */
    averageDecisionCostEstimated?: boolean;
    batteryPerDecision: number | null;
    decisionsPerFullBattery: number | null;
    spentTodayAud: number;
    dailyCapAud: number | null;
  };
  /** What the last change did, in the server's words (e.g. "dailyCapAud: 0.5 → 0.2"). */
  effects?: string[];
}

/** A rejected settings change: the server's `{ error, field? }` with its HTTP status. */
export class SettingsError extends Error {
  readonly status: number;
  readonly field: string | undefined;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

/** Accounts and settings: optional on a connection (absent means the source has none). */
export interface AccountApi {
  me(): Promise<AuthState>;
  /** Full-page redirect to the sign-in provider, coming back to `returnTo`. */
  login(returnTo: string): void;
  logout(): Promise<void>;
  settings(): Promise<WorldSettings>;
  updateSettings(patch: Record<string, SettingValue>): Promise<WorldSettings>;
}

/* ------------------------------------------------- visitors: catalogue, airdrops, mailbox
   Contract: docs/architecture/visitors.md (built by the backend in parallel; the sample mocks it). */

export interface CatalogBlock {
  block: string;
  [k: string]: unknown;
}

export interface CatalogItem {
  schema: number;
  id: string;
  name: string;
  description: string;
  /** Restricted icon language (see icons/iconlang.ts). */
  icon: string;
  tags: string[];
  portable?: boolean;
  /** Duration string: `30m`, `24h`, `7d`. */
  expiresAfter?: string;
  behaviours: CatalogBlock[];
  /** Admin listing only. */
  disabled?: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export interface Airdrop {
  id: string;
  entityId: string;
  itemId: string;
  /** A copy of the item at drop time. */
  item: CatalogItem;
  pos: Vec2;
  droppedBy: { username: string; admin: boolean };
  droppedTick: number;
  expiresTick?: number;
  usesLeft?: number;
}

export interface AirdropDetail extends Airdrop {
  beliefs: { characterId: string; text: string; firmness: number }[];
}

export interface MailStatus {
  id: string;
  status: 'waiting' | 'read' | 'expired' | 'deleted';
  /** 1 = next to be read. */
  position?: number;
  text?: string;
  from: { username: string; admin: boolean };
  postedTick: number;
  readTick?: number;
  reaction?: { feedTick: number; summary: string; notes?: string[] };
}

export interface MailView {
  waiting: number;
  mine?: MailStatus[];
  all?: MailStatus[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidateResult = { ok: true; item: CatalogItem } | { ok: false; errors: ValidationIssue[] };

/** A refused visitor or catalogue request: `{ error }` or `{ errors[] }`, with its status and any Retry-After. */
export class VisitorError extends Error {
  readonly status: number;
  readonly errors: ValidationIssue[];
  readonly retryAfterSeconds: number | undefined;
  constructor(status: number, message: string, errors: ValidationIssue[] = [], retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface VisitorApi {
  catalog(): Promise<CatalogItem[]>;
  templates(): Promise<{ name: string; item: CatalogItem }[]>;
  validate(item: unknown): Promise<ValidateResult>;
  saveItem(item: CatalogItem, disabled?: boolean): Promise<CatalogItem>;
  deleteItem(itemId: string): Promise<void>;
  airdrops(): Promise<Airdrop[]>;
  airdrop(dropId: string): Promise<AirdropDetail>;
  drop(itemId: string, pos: Vec2): Promise<Airdrop>;
  removeDrop(dropId: string): Promise<void>;
  mail(): Promise<MailView>;
  postMail(text: string): Promise<MailStatus>;
  deleteMail(mailId: string): Promise<void>;
}

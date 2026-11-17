import type {
  Action,
  CatalogItem,
  ArchetypeDef,
  Belief,
  Character,
  Channel,
  ClientMessage,
  EntityDef,
  FeedEntry,
  InputEvent,
  Json,
  Memory,
  OpenItem,
  Pos,
  Region,
  ServerMessage,
  SheetLine,
  SleepPhase,
  Noises,
  WorldObject,
  TickDeltas,
} from '@uas/core';

export type * from '@uas/core';

export interface WorldStatus {
  worldId: string;
  tick: number;
  day: number;
  timeOfDay: number;
  paused: boolean;
  timeScale: number;
  /** Rate while watched; the world slows to `idleTicksPerRealSecond` when nobody is subscribed. */
  ticksPerRealSecond: number;
  idleTicksPerRealSecond: number;
  watched: boolean;
  effectiveTicksPerRealSecond: number;
  /** `realtime`: in-world time is local wall-clock time in `timezone`; `scaled`: a fast test world. */
  clockMode: 'realtime' | 'scaled';
  timezone: string;
  /** In-world time: local wall-clock seconds since the epoch (realtime); read it as a UTC date to get local time. */
  worldSeconds: number;
  driftSeconds: number;
  pendingJobs: number;
  mailWaiting: number;
  costAudToday: number;
  modelLatencyMs: number;
  tickLagMs: number;
  secondsPerTick: number;
  inWorldSecondsPerRealSecond: number;
  queue: QueueStats;
}

export interface QueueStats {
  waiting: number;
  running: number;
  byLane: Record<string, { waiting: number; running: number }>;
  waitMs: { p50: number; p95: number; max: number };
  runMs: { p50: number; p95: number; max: number };
  completed: number;
  dropped: { stale: number; superseded: number; failed: number };
  timeouts: number;
}

export interface WorldSummary {
  id: string;
  name: string;
  packs: string[];
  map: string;
  publicRead: boolean;
  status?: WorldStatus;
}

/** Display data for a world: pack objects (verbs), archetypes (needs, noises, ranges), costs. */
export interface WorldCatalog {
  worldId: string;
  name: string;
  packs: string[];
  /** Real-time pacing at timeScale 1. */
  ticksPerRealSecond: number;
  /** @deprecated alias of ticksPerRealSecond */
  ticksPerSecond: number;
  /** In-world seconds per tick. */
  secondsPerTick: number | null;
  dailyCapAud: number | null;
  energyFloor: number | null;
  energyPerAud: number | null;
  objects: { type: string; tags: string[]; portable: boolean; solid: boolean; verbs: string[] }[];
  archetypes: {
    type: string;
    tags: string[];
    needs: ArchetypeDef['needs'];
    energy: ArchetypeDef['energy'];
    noises: Noises | null;
    sightRange: number;
    hearingRange: number;
  }[];
}

/**
 * The `state` of a `snapshot` message (the sim's `WorldState`), typed for frontends. Only the
 * fields a viewer reads are listed; the rest (rng, ext, nextId…) is opaque.
 */
export interface WorldStateView {
  config: {
    worldId: string;
    seed: number;
    grid: { width: number; height: number; terrain: Record<string, { walkable: boolean; blocksSight: boolean; soundDamping: number }>; tiles: string[] };
    secondsPerTick: number;
    dayLengthSeconds: number;
    startSecond: number;
    moveTicksPerTile: number;
  };
  packVersions: string;
  tick: number;
  /** In-world time anchor: seconds = baseSeconds + (tick − baseTick) × secondsPerTick (absent on old snapshots). */
  clock?: { baseSeconds: number; baseTick: number };
  entities: Record<string, Character | WorldObject>;
  /** The mailbox queue, oldest first. `text` is empty unless you are an admin (use `mail()` for your own). */
  mailbox?: { queue: { mailId: string; text: string; by: { username: string; admin: boolean }; postedTick: number; expiresTick?: number }[] };
}

export interface MindView {
  id: string;
  needs: Record<string, number>;
  energy: number;
  mood: { valence: number; arousal: number; word: string; bias: number };
  sleep: SleepPhase;
  openItems: OpenItem[];
  queue: Action[];
  current: { action: Action; startedTick: number; endsTick?: number } | null;
  pendingJobs: { jobId: string; job: string; tick: number }[];
}

export interface MemoriesView {
  stm: Memory[];
  ltm: Memory[];
  beliefs: Belief[];
  sheet: SheetLine[];
}

export interface UsageRow {
  day: string;
  modelId: string;
  job: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costAud: number;
  energy: number;
}

export interface AuthMe {
  user: { id: string; name: string | null; email: string | null; avatarUrl: string | null; username: string | null } | null;
  role: 'admin' | 'visitor' | 'spectator';
  /** False when the server has no VERCEL_OAUTH_CLIENT_ID: hide the sign-in button. */
  loginAvailable: boolean;
}

export interface SettingsValues {
  ticksPerRealSecond: number;
  moveSecondsPerTile: number;
  timeScale: number;
  paused: boolean;
  dailyCapAud: number;
  energyPerAud: number;
  hostedModels: boolean;
  needDecayMultiplier: number;
  escalateBelow: number;
  /** Visitor limits (admins are exempt). Defaults are effectively unlimited. */
  catalogEnabled: string[];
  airdropMaxActivePerVisitor: number;
  airdropCooldownSeconds: number;
  airdropWorldCap: number;
  /** In-world seconds; 0 = never. */
  airdropDefaultExpiry: number;
  mailCapacity: number;
  /** In-world seconds; 0 = never. */
  mailExpirySeconds: number;
  mailMaxWaitingPerVisitor: number;
  mailCooldownSeconds: number;
}

/** How to render one setting: a generic number or boolean control, or a list of catalogue item ids. */
export interface SettingField {
  key: keyof SettingsValues;
  label: string;
  kind: 'number' | 'boolean' | 'string[]';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  help: string;
}

export interface SettingsDerived {
  averageDecisionCostAud: number;
  /** True until a decision has been made today (then it's measured). */
  averageDecisionCostEstimated: boolean;
  /** Battery (0..1 = a full battery) one average decision costs: averageDecisionCostAud × energyPerAud. */
  batteryPerDecision: number;
  decisionsPerFullBattery: number | null;
  spentTodayAud: number;
  dailyCapAud: number;
  capRemainingAud: number;
  hostedModelsAvailable: string[];
  secondsPerTick: number;
  moveTicksPerTile: number;
  inWorldSecondsPerRealSecond: number;
}

export interface WorldSettings {
  values: SettingsValues;
  schema: SettingField[];
  derived: SettingsDerived;
}

export interface SettingsUpdate {
  values: SettingsValues;
  derived: SettingsDerived;
  /** Human-readable summary of what changed, e.g. "dailyCapAud: 0.5 → 0.2". */
  effects: string[];
}

// ---- visitors: the airdrop catalogue, airdrops and the mailbox (docs/architecture/visitors.md)

/** `GET /catalog` for admins: items plus edit metadata (others get plain `CatalogItem`s, enabled only). */
export type CatalogEntry = CatalogItem & { disabled?: boolean; updatedAt?: string; updatedBy?: string | null };
export interface PathError {
  path: string;
  message: string;
}
export type ValidateResult = { ok: true; item: CatalogItem } | { ok: false; errors: PathError[] };

export interface Airdrop {
  id: string;
  entityId: string;
  itemId: string;
  /** A copy of the catalogue item at drop time. */
  item: CatalogItem;
  pos: { x: number; y: number };
  droppedBy: { username: string; admin: boolean };
  droppedTick: number;
  expiresTick?: number;
  usesLeft?: number;
}
export interface AirdropDetail extends Airdrop {
  /** What characters believe about things like this (beliefs are by what the robot perceives: `thing-<tags>`). */
  beliefs: { characterId: string; text: string; firmness: number }[];
}
export interface MailStatus {
  id: string;
  status: 'waiting' | 'read' | 'expired' | 'deleted';
  /** 1 = next to be read. */
  position?: number;
  /** The sender and admins always; everyone once read. */
  text?: string;
  from: { username: string; admin: boolean };
  postedTick: number;
  readTick?: number;
  /** What the robot did right after reading (its next feed entry). */
  reaction?: { feedTick: number; summary: string; notes?: string[] };
}
export interface MailView {
  waiting: number;
  mine?: MailStatus[];
  all?: MailStatus[];
}

export class ApiError extends Error {
  readonly status: number;
  /** Path-specific problems (catalogue validation). */
  readonly errors?: PathError[];
  constructor(status: number, message: string, errors?: PathError[]) {
    super(message);
    this.status = status;
    if (errors) this.errors = errors;
  }
}

/** Typed REST client for `@uas/server`. Works in browsers and Node (global fetch). */
export class UasClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(this.apiKey && { authorization: `Bearer ${this.apiKey}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, (data as { errors?: PathError[] })?.errors);
    return data as T;
  }

  worlds = () => this.req<WorldSummary[]>('GET', '/worlds');
  createWorld = (config: Record<string, Json>) => this.req<WorldSummary>('POST', '/worlds', config);
  world = (id: string) => this.req<WorldSummary>('GET', `/worlds/${id}`);
  catalog = (id: string) => this.req<WorldCatalog>('GET', `/worlds/${id}/catalog`);
  /** Recorded deltas in [fromTick, toTick); `kinds` keeps only those delta kinds. */
  deltas = (id: string, fromTick = 0, toTick?: number, kinds?: string[]) =>
    this.req<TickDeltas[]>(
      'GET',
      `/worlds/${id}/deltas?fromTick=${fromTick}${toTick === undefined ? '' : `&toTick=${toTick}`}${kinds?.length ? `&kinds=${kinds.join(',')}` : ''}`,
    );
  clock = (id: string, c: { paused?: boolean; timeScale?: number; realign?: boolean }) => this.req<WorldStatus>('PATCH', `/worlds/${id}/clock`, c);
  spawn = (id: string, def: EntityDef) => this.req<InputEvent>('POST', `/worlds/${id}/entities`, def);
  editEntity = (id: string, eid: string, edit: { pos?: Pos; state?: Record<string, Json>; needs?: Record<string, number>; energy?: number }) =>
    this.req<InputEvent>('PATCH', `/worlds/${id}/entities/${eid}`, edit);
  removeEntity = (id: string, eid: string) => this.req<InputEvent>('DELETE', `/worlds/${id}/entities/${eid}`);
  mind = (id: string, cid: string) => this.req<MindView>('GET', `/worlds/${id}/characters/${cid}/mind`);
  memories = (id: string, cid: string) => this.req<MemoriesView>('GET', `/worlds/${id}/characters/${cid}/memories`);
  diary = (id: string, cid: string, day?: number) =>
    this.req<{ day: number; entries: { tick: number; text: string }[] }>('GET', `/worlds/${id}/characters/${cid}/diary${day === undefined ? '' : `?day=${day}`}`);
  poke = (id: string, cid: string) => this.req<InputEvent>('POST', `/worlds/${id}/characters/${cid}/poke`);
  events = (id: string, fromSeq = 0, limit = 100) => this.req<InputEvent[]>('GET', `/worlds/${id}/events?fromSeq=${fromSeq}&limit=${limit}`);
  feed = (id: string, characterId?: string, limit = 100) =>
    this.req<FeedEntry[]>('GET', `/worlds/${id}/feed?limit=${limit}${characterId ? `&characterId=${characterId}` : ''}`);
  seek = (id: string, tick: number) => this.req<{ sessionId: string; tick: number; state: unknown }>('POST', `/worlds/${id}/seek`, { tick });
  fork = (id: string, tick: number, opts: { id?: string; config?: Record<string, Json> } = {}) => this.req<WorldSummary>('POST', `/worlds/${id}/fork`, { tick, ...opts });
  packs = () => this.req<{ name: string; version: string; licence: string; contentHash: string }[]>('GET', '/packs');
  usage = (worldId?: string, day?: string) =>
    this.req<Record<string, { rows: UsageRow[]; queue: QueueStats }>>('GET', `/usage?${worldId ? `worldId=${worldId}&` : ''}${day ? `day=${day}` : ''}`);

  // ---- Sign in with Vercel (cookie session; works through the same-origin /api proxy)
  me = () => this.req<AuthMe>('GET', '/auth/me');
  /** Navigate the browser here to sign in; it comes back to `returnTo` (a same-site path). */
  loginUrl = (returnTo = '/') => `${this.baseUrl}/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  logout = () => this.req<{ ok: true }>('POST', '/auth/logout');

  // ---- Live world settings
  settings = (id: string) => this.req<WorldSettings>('GET', `/worlds/${id}/settings`);
  updateSettings = (id: string, patch: Partial<SettingsValues>) => this.req<SettingsUpdate>('PATCH', `/worlds/${id}/settings`, patch);

  // ---- Visitors: the airdrop catalogue (server-wide), airdrops and the mailbox (per world)
  catalogItems = () => this.req<CatalogEntry[]>('GET', '/catalog');
  catalogTemplates = () => this.req<{ name: string; item: CatalogItem }[]>('GET', '/catalog/templates');
  validateItem = (item: unknown) => this.req<ValidateResult>('POST', '/catalog/validate', { item });
  /** Throws ApiError (400) with `errors` when the item is invalid. */
  saveItem = (item: CatalogItem, disabled?: boolean) =>
    this.req<CatalogEntry>('PUT', `/catalog/${encodeURIComponent(item.id)}`, { item, ...(disabled !== undefined && { disabled }) });
  deleteItem = (itemId: string) => this.req<{ ok: true }>('DELETE', `/catalog/${encodeURIComponent(itemId)}`);
  airdrops = (id: string) => this.req<Airdrop[]>('GET', `/worlds/${id}/airdrops`);
  airdrop = (id: string, dropId: string) => this.req<AirdropDetail>('GET', `/worlds/${id}/airdrops/${encodeURIComponent(dropId)}`);
  dropItem = (id: string, itemId: string, pos: { x: number; y: number }) => this.req<Airdrop>('POST', `/worlds/${id}/airdrops`, { itemId, pos });
  removeAirdrop = (id: string, dropId: string) => this.req<{ ok: true }>('DELETE', `/worlds/${id}/airdrops/${encodeURIComponent(dropId)}`);
  mail = (id: string) => this.req<MailView>('GET', `/worlds/${id}/mail`);
  postMail = (id: string, text: string) => this.req<MailStatus>('POST', `/worlds/${id}/mail`, { text });
  removeMail = (id: string, mailId: string) => this.req<{ ok: true }>('DELETE', `/worlds/${id}/mail/${encodeURIComponent(mailId)}`);

  /** Open the WebSocket stream. */
  connect(): WorldStream {
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws${this.apiKey ? `?key=${encodeURIComponent(this.apiKey)}` : ''}`;
    return new WorldStream(new WebSocket(url));
  }
}

type Handler<T> = (msg: T) => void;
type ByType = { [K in ServerMessage['type']]: Extract<ServerMessage, { type: K }> };

/** Typed WebSocket wrapper: `on('deltas', m => ...)`, `subscribe(worldId)`, replay controls. */
export class WorldStream {
  readonly socket: WebSocket;
  readonly open: Promise<void>;
  private readonly handlers = new Map<string, Set<Handler<never>>>();

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.open = new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
    });
    socket.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      for (const h of this.handlers.get(msg.type) ?? []) (h as Handler<ServerMessage>)(msg);
      for (const h of this.handlers.get('*') ?? []) (h as Handler<ServerMessage>)(msg);
    });
  }

  on<K extends keyof ByType>(type: K, h: Handler<ByType[K]>): () => void;
  on(type: '*', h: Handler<ServerMessage>): () => void;
  on(type: string, h: Handler<never>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(h);
    this.handlers.set(type, set);
    return () => set.delete(h);
  }

  /** Resolves with the next message of `type` that matches. */
  next<K extends keyof ByType>(type: K, match: (m: ByType[K]) => boolean = () => true): Promise<ByType[K]> {
    return new Promise((resolve) => {
      const off = this.on(type, (m) => {
        if (match(m)) {
          off();
          resolve(m);
        }
      });
    });
  }

  send(msg: ClientMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

  subscribe(worldId: string, opts: { channels?: Channel[]; region?: Region } = {}): void {
    this.send({ type: 'subscribe', worldId, ...opts });
  }
  unsubscribe(worldId: string): void {
    this.send({ type: 'unsubscribe', worldId });
  }
  openReplay(worldId: string, tick: number): void {
    this.send({ type: 'replay.open', worldId, tick });
  }
  play(sessionId: string, speed?: number): void {
    this.send({ type: 'play', sessionId, ...(speed && { speed }) });
  }
  pause(sessionId: string): void {
    this.send({ type: 'pause', sessionId });
  }
  seek(sessionId: string, tick: number): void {
    this.send({ type: 'seek', sessionId, tick });
  }
  closeReplay(sessionId: string): void {
    this.send({ type: 'replay.close', sessionId });
  }
  close(): void {
    this.socket.close();
  }
}

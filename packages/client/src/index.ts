import type {
  Action,
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
  VisitorRequest,
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
  pendingJobs: number;
  visitorQueueDepth: number;
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
  entities: Record<string, Character | WorldObject>;
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
  visitorQueue: VisitorRequest[];
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

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText);
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
  clock = (id: string, c: { paused?: boolean; timeScale?: number }) => this.req<WorldStatus>('PATCH', `/worlds/${id}/clock`, c);
  spawn = (id: string, def: EntityDef) => this.req<InputEvent>('POST', `/worlds/${id}/entities`, def);
  editEntity = (id: string, eid: string, edit: { pos?: Pos; state?: Record<string, Json>; needs?: Record<string, number>; energy?: number }) =>
    this.req<InputEvent>('PATCH', `/worlds/${id}/entities/${eid}`, edit);
  removeEntity = (id: string, eid: string) => this.req<InputEvent>('DELETE', `/worlds/${id}/entities/${eid}`);
  mind = (id: string, cid: string) => this.req<MindView>('GET', `/worlds/${id}/characters/${cid}/mind`);
  memories = (id: string, cid: string) => this.req<MemoriesView>('GET', `/worlds/${id}/characters/${cid}/memories`);
  diary = (id: string, cid: string, day?: number) =>
    this.req<{ day: number; entries: { tick: number; text: string }[] }>('GET', `/worlds/${id}/characters/${cid}/diary${day === undefined ? '' : `?day=${day}`}`);
  poke = (id: string, cid: string) => this.req<InputEvent>('POST', `/worlds/${id}/characters/${cid}/poke`);
  joinAsVisitor = (id: string, pos?: Pos) => this.req<{ visitorId: string }>('POST', `/worlds/${id}/visitors`, pos ? { pos } : {});
  visitorActions = (id: string, vid: string, actions: Action[]) => this.req<InputEvent>('POST', `/worlds/${id}/visitors/${vid}/actions`, { actions });
  /** Make noises at a character: `notes` like ['beep-C', 'chirp-E']. Joins its visitor queue. */
  noiseAt = (id: string, vid: string, characterId: string, notes: string[]) =>
    this.visitorActions(id, vid, [{ verb: 'vocalize', args: { notes, at: characterId }, reason: 'visitor' }]);
  events = (id: string, fromSeq = 0, limit = 100) => this.req<InputEvent[]>('GET', `/worlds/${id}/events?fromSeq=${fromSeq}&limit=${limit}`);
  feed = (id: string, characterId?: string, limit = 100) =>
    this.req<FeedEntry[]>('GET', `/worlds/${id}/feed?limit=${limit}${characterId ? `&characterId=${characterId}` : ''}`);
  seek = (id: string, tick: number) => this.req<{ sessionId: string; tick: number; state: unknown }>('POST', `/worlds/${id}/seek`, { tick });
  fork = (id: string, tick: number, opts: { id?: string; config?: Record<string, Json> } = {}) => this.req<WorldSummary>('POST', `/worlds/${id}/fork`, { tick, ...opts });
  packs = () => this.req<{ name: string; version: string; licence: string; contentHash: string }[]>('GET', '/packs');
  usage = (worldId?: string, day?: string) =>
    this.req<Record<string, { rows: UsageRow[]; queue: QueueStats }>>('GET', `/usage?${worldId ? `worldId=${worldId}&` : ''}${day ? `day=${day}` : ''}`);

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

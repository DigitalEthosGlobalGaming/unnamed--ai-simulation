/**
 * The real data source: `@uas/client` over REST and the WebSocket. Live stream on subscribe;
 * replay through a server replay session (replay.open / seek / play / pause / replay.close).
 */
import { UasClient, type WorldStream } from '@uas/client';
import { RestPrompts } from './prompts.ts';
import type { ObjectDef, ObjectHistory, PromptsApi, VisitorApi, AccountApi, Belief, BeliefMark, ConnectionStatus, FeedEntry, ViewerMessage, WorldCatalog, WorldConnection } from '../types.ts';
import { RestAccount } from './account.ts';
import { RestVisitors } from './visitors.ts';

const FEED_HISTORY = 500;
const FEED_KEEP = 2000;
const STATUS_POLL_MS = 5_000;
const PACE_MS = 500;

export interface RealOptions {
  /** REST base, e.g. '/api' behind the Vite proxy, or 'http://host:8080'. */
  baseUrl: string;
  apiKey?: string;
  /** World id; default: the first world the server lists. */
  worldId?: string;
}

export class RealConnection implements WorldConnection {
  private readonly api: UasClient;
  private stream: WorldStream | null = null;
  private listeners = new Set<(m: ViewerMessage) => void>();
  private cat: WorldCatalog | null = null;
  private worldId: string | undefined;
  private feed: FeedEntry[] = [];
  private readonly base: string;
  private readonly apiKey: string | undefined;
  private trimmed = 0;
  private marks: BeliefMark[] = [];
  private liveTick = 0;
  private sessionId: string | null = null;
  private pendingSeek: number | null = null;
  private wantPlay: number | null = null;
  private status: ConnectionStatus = 'connecting';
  private poll: number | undefined;
  private generation = 0;
  /** The server only sends ticks that changed something; between them the viewer's clock is paced locally. */
  private pace = { live: { tick: 0, at: 0 }, replay: { tick: 0, at: 0 }, timeScale: 1, paused: false, effective: null as number | null };
  private paceTimer: number | undefined;

  readonly account: AccountApi;
  readonly visitors: VisitorApi;
  readonly prompts: PromptsApi;

  constructor(opts: RealOptions) {
    const base = opts.baseUrl.startsWith('http') ? opts.baseUrl : `${location.origin}${opts.baseUrl}`;
    this.base = base.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.api = new UasClient(base, opts.apiKey);
    this.worldId = opts.worldId;
    const rest = new RestAccount(base, () => this.worldId, opts.apiKey);
    this.visitors = new RestVisitors(base, () => this.worldId, opts.apiKey);
    this.prompts = new RestPrompts(base, () => this.worldId, opts.apiKey);
    // A settings change can alter pacing and the cap: re-read the world's status right after.
    this.account = {
      me: () => rest.me(),
      login: (r) => rest.login(r),
      logout: () => rest.logout(),
      settings: () => rest.settings(),
      updateSettings: async (patch) => {
        const out = await rest.updateSettings(patch);
        void this.pollStatus();
        return out;
      },
    };
  }

  catalog(): WorldCatalog | null {
    return this.cat;
  }

  subscribe(onMessage: (m: ViewerMessage) => void): () => void {
    this.listeners.add(onMessage);
    onMessage({ type: 'status', status: this.status });
    if (this.listeners.size === 1) void this.connect();
    return () => this.listeners.delete(onMessage);
  }

  private emit(m: ViewerMessage) {
    for (const l of this.listeners) l(m);
  }

  private setStatus(status: ConnectionStatus, detail?: string) {
    this.status = status;
    this.emit({ type: 'status', status, ...(detail && { detail }) });
  }

  private async connect() {
    const gen = ++this.generation;
    this.setStatus('connecting');
    try {
      if (!this.worldId) {
        const worlds = await this.api.worlds();
        if (!worlds.length) throw new Error('the server runs no worlds');
        // Prefer a live world; archived ones open only when asked for with ?world=.
        this.worldId = (worlds.find((w) => !w.archived) ?? worlds[0]!).id;
      }
      const id = this.worldId;
      this.cat = await this.api.catalog(id);
      this.feed = await this.api.feed(id, undefined, FEED_HISTORY);
      this.trimmed = 0;
      const beliefRows = await this.api.deltas(id, 0, undefined, ['beliefs']);
      this.marks = beliefRows.flatMap((r) => r.changes.flatMap((c) => (c.kind === 'beliefs' ? [{ tick: r.tick, characterId: c.id }] : [])));
      if (gen !== this.generation) return;

      const stream = this.api.connect();
      this.stream = stream;
      await stream.open;
      stream.on('*', (m) => this.onServer(m));
      stream.socket.addEventListener('close', () => {
        if (gen !== this.generation) return;
        this.stream = null;
        this.sessionId = null;
        this.setStatus('disconnected', 'the WebSocket closed');
      });
      stream.subscribe(id, { channels: ['deltas', 'feed'] });
      void this.pollStatus();
      window.clearInterval(this.poll);
      this.poll = window.setInterval(() => void this.pollStatus(), STATUS_POLL_MS);
      window.clearInterval(this.paceTimer);
      this.paceTimer = window.setInterval(() => this.paceClock(), PACE_MS);
    } catch (e) {
      if (gen !== this.generation) return;
      this.setStatus('disconnected', (e as Error).message);
    }
  }

  private async pollStatus() {
    if (!this.worldId) return;
    try {
      const w = await this.api.world(this.worldId);
      if (w.status) {
        this.pace.timeScale = w.status.timeScale;
        this.pace.paused = w.status.paused;
        const st = w.status as typeof w.status & { effectiveTicksPerRealSecond?: number; clockMode?: string };
        this.pace.effective = st.effectiveTicksPerRealSecond ?? null;
        // `archived` is on the world summary (docs/architecture/objects.md): read-only, no inputs.
        this.emit({ type: 'pace', realtime: st.clockMode === 'realtime', ticksPerRealSecond: this.rate(), archived: (w as { archived?: boolean }).archived === true });
        if (w.status.tick > this.liveTick) {
          this.markLive(w.status.tick);
          // Bring the shown clock up to the server's tick too (quiet worlds send few deltas).
          if (!this.sessionId && this.worldId) this.emit({ type: 'deltas', worldId: this.worldId, tick: w.status.tick, changes: [] });
        }
        this.emit({ type: 'spend', spendTodayAud: w.status.costAudToday });
      }
    } catch {
      /* the socket's close handler reports disconnection */
    }
  }

  private rate(): number {
    // The server's effective rate (it may idle slower when nobody watches); else the configured rate × time scale.
    return this.pace.effective ?? (this.cat?.ticksPerRealSecond ?? this.cat?.ticksPerSecond ?? 5) * this.pace.timeScale;
  }

  private markLive(tick: number) {
    this.liveTick = tick;
    this.pace.live = { tick, at: performance.now() };
  }

  /** Advance the shown clock between sparse deltas with empty `deltas` messages (capped estimates). */
  private paceClock() {
    if (this.status !== 'live' || !this.worldId) return;
    const now = performance.now();
    if (!this.pace.paused) {
      const est = Math.floor(this.pace.live.tick + ((now - this.pace.live.at) / 1000) * this.rate());
      if (est > this.liveTick) {
        this.liveTick = est;
        if (!this.sessionId) this.emit({ type: 'deltas', worldId: this.worldId, tick: est, changes: [] });
      }
    }
    if (this.sessionId && this.wantPlay !== null) {
      const r = this.pace.replay;
      const est = Math.min(this.liveTick, Math.floor(r.tick + ((now - r.at) / 1000) * this.rate() * this.wantPlay));
      if (est > r.tick) this.emit({ type: 'deltas', worldId: this.worldId, sessionId: this.sessionId, tick: est, changes: [] });
    }
  }

  private onServer(m: Parameters<Parameters<WorldStream['on']>[1]>[0]) {
    switch (m.type) {
      case 'snapshot':
        if (!m.sessionId) {
          this.markLive(m.tick);
          if (this.status !== 'live') this.setStatus('live');
        } else if (m.sessionId !== this.sessionId) return;
        else this.pace.replay = { tick: m.tick, at: performance.now() };
        break;
      case 'deltas':
        if (!m.sessionId) {
          this.markLive(m.tick);
          for (const c of m.changes) if (c.kind === 'beliefs') this.marks.push({ tick: m.tick, characterId: c.id });
          // While replaying, live deltas only move the end of the scale bar.
          if (this.sessionId) return;
        } else if (m.sessionId !== this.sessionId) return;
        else this.pace.replay = { tick: m.tick, at: performance.now() };
        break;
      case 'feed':
        if (!m.sessionId) {
          this.feed.push(m.entry);
          // Bounded: older history stays on the server and pages back in through feedBefore.
          if (this.feed.length > FEED_KEEP + 500) {
            const drop = this.feed.length - FEED_KEEP;
            this.feed.splice(0, drop);
            this.trimmed += drop;
          }
        }
        if (this.sessionId) return;
        break;
      case 'replay.opened':
        this.sessionId = m.sessionId;
        if (this.pendingSeek !== null && this.pendingSeek !== m.tick) this.stream?.seek(m.sessionId, this.pendingSeek);
        this.pendingSeek = null;
        if (this.wantPlay !== null) this.stream?.play(m.sessionId, this.wantPlay);
        return;
      case 'replay.ended':
        if (m.sessionId !== this.sessionId) return;
        this.wantPlay = null;
        break;
      case 'error':
        console.warn('[uas]', m.message);
        return;
      default:
        break;
    }
    this.emit(m);
  }

  async feedBefore(beforeTick: number, limit: number, characterId?: string): Promise<FeedEntry[]> {
    if (!this.worldId) return [];
    const rows = await this.api.feed(this.worldId, characterId, limit, beforeTick);
    // A server without the cursor answers with the newest entries instead: treat that as "no paging".
    return rows.some((e) => e.tick >= beforeTick) ? [] : rows;
  }

  async objectHistory(objectId: string, keys: string[], sinceTick?: number, maxPoints = 96): Promise<ObjectHistory | null> {
    if (!this.worldId) return null;
    const q = new URLSearchParams({ keys: keys.join(','), maxPoints: String(maxPoints), ...(sinceTick !== undefined && { sinceTick: String(sinceTick) }) });
    const res = await fetch(`${this.base}/worlds/${encodeURIComponent(this.worldId)}/objects/${encodeURIComponent(objectId)}/history?${q}`, {
      credentials: 'include',
      ...(this.apiKey && { headers: { authorization: `Bearer ${this.apiKey}` } }),
    });
    if (!res.ok) return null; // a server without history: the card just leaves it out
    return (await res.json()) as ObjectHistory;
  }

  async objectDefs(): Promise<ObjectDef[]> {
    const res = await fetch(`${this.base}/objects/defs`, { credentials: 'include', ...(this.apiKey && { headers: { authorization: `Bearer ${this.apiKey}` } }) });
    if (!res.ok) return []; // a server before schema 2
    const defs = (await res.json()) as unknown;
    return Array.isArray(defs) ? (defs as ObjectDef[]) : [];
  }

  feedTrimmed(): number {
    return this.trimmed;
  }

  feedUntil(tick: number): FeedEntry[] {
    let hi = this.feed.length;
    let lo = 0;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.feed[mid]!.tick <= tick) lo = mid + 1;
      else hi = mid;
    }
    return this.feed.slice(0, lo);
  }

  beliefMarks(): BeliefMark[] {
    return this.marks;
  }

  range() {
    return { from: 0, to: this.liveTick };
  }

  async memories(characterId: string): Promise<Belief[]> {
    if (!this.worldId) return [];
    return (await this.api.memories(this.worldId, characterId)).beliefs;
  }

  seek(tick: number): void {
    const t = Math.max(0, Math.min(Math.round(tick), this.liveTick));
    if (!this.stream || !this.worldId) return;
    if (this.sessionId) this.stream.seek(this.sessionId, t);
    else if (this.pendingSeek === null) {
      this.pendingSeek = t;
      this.wantPlay = null;
      this.stream.openReplay(this.worldId, t);
    } else this.pendingSeek = t;
  }

  play(speed: number): void {
    this.wantPlay = speed;
    this.pace.replay.at = performance.now();
    if (!this.sessionId) return this.seek(Math.max(0, this.liveTick - 1));
    this.stream?.play(this.sessionId, speed);
  }

  pause(): void {
    this.wantPlay = null;
    if (!this.sessionId) return this.seek(this.liveTick);
    this.stream?.pause(this.sessionId);
  }

  goLive(): void {
    if (!this.stream || !this.worldId) return;
    if (this.sessionId) this.stream.closeReplay(this.sessionId);
    this.sessionId = null;
    this.pendingSeek = null;
    this.wantPlay = null;
    // A fresh live snapshot: resubscribe.
    this.stream.unsubscribe(this.worldId);
    this.stream.subscribe(this.worldId, { channels: ['deltas', 'feed'] });
  }

  reconnect(): void {
    this.stream?.close();
    this.stream = null;
    this.sessionId = null;
    void this.connect();
  }
}

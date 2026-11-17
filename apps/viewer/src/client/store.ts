/**
 * Viewer state: one world view kept current by applying the server's deltas, the brain feed,
 * the selection and the live/replay mode. Transport-agnostic: it consumes `ViewerMessage`s from
 * a `WorldConnection` (the real server via `@uas/client`, or the offline sample).
 */
import type { Delta, BeliefMark, CharacterView, ConnectionStatus, FeedEntry, Vec2, ViewerMessage, WorldCatalog, WorldConnection, WorldStateView, WorldView } from '../types.ts';
import { applyDeltas, labelOf, verbsOf, viewFromState } from './view.ts';

export interface NoiseEvent {
  id: string;
  characterId: string;
  notes: string[];
  pos: Vec2;
  at: number; // performance.now()
}

export type Mode = 'live' | 'replay';

type Listener = () => void;

export class ViewerStore {
  world: WorldView | null = null;
  status: ConnectionStatus = 'connecting';
  statusDetail = '';
  mode: Mode = 'live';
  playing = true;
  speed = 1;
  selectedId: string | null = null;
  /** Feed row picked in the revision table, on a cloud or on a timeline marker: `${tick}:${characterId}`. */
  highlight: string | null = null;
  /** Bumped when the highlight changes from outside the table, so the table scrolls to it. */
  highlightSeq = 0;
  private revs = new WeakMap<FeedEntry, number>();
  feed: FeedEntry[] = [];
  noises: NoiseEvent[] = [];
  private noiseSeq = 0;
  private listeners = new Set<Listener>();
  private noiseListeners = new Set<(n: NoiseEvent) => void>();
  private session: string | undefined;
  private dirty = false;
  private spend = 0;
  /** Effective ticks per real second (paces movement glides) and whether in-world time is wall-clock time. */
  ticksPerRealSecond = 5;
  realtime = false;

  constructor(readonly conn: WorldConnection) {
    conn.subscribe((m) => this.onMessage(m));
  }

  get tick(): number {
    return this.world?.clock.tick ?? 0;
  }

  get catalog(): WorldCatalog | null {
    return this.conn.catalog();
  }

  private visitorListeners = new Set<() => void>();
  /** Called when a delta says airdrops or mail changed. */
  onVisitorDelta(l: () => void): () => void {
    this.visitorListeners.add(l);
    return () => this.visitorListeners.delete(l);
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onNoise(l: (n: NoiseEvent) => void): () => void {
    this.noiseListeners.add(l);
    return () => this.noiseListeners.delete(l);
  }

  /** Coalesce notifications to one per animation frame. */
  private notify() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      this.dirty = false;
      for (const l of this.listeners) l();
    });
  }

  character(id: string | null): CharacterView | undefined {
    if (!id || !this.world) return undefined;
    return this.world.characters.find((c) => c.id === id);
  }

  /** Display name for any entity: a character's name, or an object's label from its type. */
  nameOf(id: string | undefined): string {
    if (!id || !this.world) return '';
    const c = this.world.characters.find((x) => x.id === id);
    if (c) return c.name;
    const o = this.world.objects.find((x) => x.id === id);
    return o ? labelOf(o.type) : id;
  }

  objectLabel(type: string): string {
    return labelOf(type);
  }

  objectVerbs(type: string): string[] {
    return verbsOf(this.catalog, type);
  }

  /** Why steps were refused or failed, from the world's action deltas (the feed entry only has the status). */
  private outcomes = new WeakMap<FeedEntry, ({ status: 'rejected' | 'failed'; why: string } | undefined)[]>();

  /** The world's refusal or failure for each step of a decision, where one was seen. */
  stepOutcomes(e: FeedEntry): ({ status: 'rejected' | 'failed'; why: string } | undefined)[] {
    return this.outcomes.get(e) ?? [];
  }

  private noteOutcomes(tick: number, changes: Delta[]) {
    for (const c of changes) {
      if (c.kind !== 'action' || (c.status !== 'rejected' && c.status !== 'failed')) continue;
      const why = c.reason ?? c.observation ?? '';
      // The latest decision by this robot that holds this step and has no outcome for it yet.
      for (let i = this.feed.length - 1, n = 0; i >= 0 && n < 80; i--, n++) {
        const e = this.feed[i]!;
        if (e.characterId !== c.id || e.tick > tick) continue;
        const o = this.outcomes.get(e) ?? [];
        const k = e.actions.findIndex((a, j) => a.verb === c.action.verb && (a.targetId ?? '') === (c.action.targetId ?? '') && !o[j]);
        if (k < 0) continue;
        o[k] = { status: c.status, why };
        this.outcomes.set(e, o);
        break;
      }
    }
  }

  /** Older brain feed from the source, before a tick (newest `limit`, oldest first); [] when it has none or can't page. */
  async feedBefore(beforeTick: number, limit: number, characterId?: string): Promise<FeedEntry[]> {
    return this.conn.feedBefore ? this.conn.feedBefore(beforeTick, limit, characterId) : [];
  }

  /** Revision number of a feed entry: its 1-based position in the loaded feed. */
  rev(e: FeedEntry): number {
    let n = this.revs.get(e);
    if (n === undefined) {
      const off = this.conn.feedTrimmed?.() ?? 0;
      this.conn.feedUntil(this.conn.range().to).forEach((x, i) => this.revs.set(x, off + i + 1));
      n = this.revs.get(e) ?? 0;
    }
    return n;
  }

  static key(e: { tick: number; characterId: string }): string {
    return `${e.tick}:${e.characterId}`;
  }

  /** The row a robot's red-pen cloud refers to: its latest fallback / rejected / failed decision. */
  alertEntry(characterId: string): FeedEntry | undefined {
    for (let i = this.feed.length - 1; i >= 0 && i > this.feed.length - 400; i--) {
      const e = this.feed[i]!;
      if (e.characterId === characterId && isWarn(e)) return e;
    }
    return undefined;
  }

  /** Where beliefs changed: the ▼ markers on the timeline. */
  beliefMarks(characterId: string | null): BeliefMark[] {
    // One marker per robot per tick (a night's consolidation can report several belief changes).
    const seen = new Set<string>();
    return this.conn.beliefMarks().filter((m) => {
      const k = `${m.tick}:${m.characterId}`;
      if ((characterId && m.characterId !== characterId) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  setHighlight(key: string | null, fromOutside = false) {
    this.highlight = key;
    if (fromOutside) this.highlightSeq++;
    this.notify();
  }

  select(id: string | null) {
    this.selectedId = id;
    this.notify();
    // Beliefs come from the memories endpoint when the source has one (live only; replay uses the snapshot).
    const c = this.character(id);
    if (c && this.mode === 'live' && this.conn.memories) void this.refreshBeliefs(c.id);
  }

  private async refreshBeliefs(id: string) {
    try {
      const beliefs = await this.conn.memories!(id);
      const c = this.character(id);
      if (c && this.mode === 'live') {
        c.beliefs = beliefs;
        this.notify();
      }
    } catch {
      /* keep the snapshot's beliefs */
    }
  }

  seek(tick: number) {
    this.mode = 'replay';
    this.playing = false;
    this.conn.seek(tick);
    this.notify();
  }

  togglePlay() {
    if (this.mode === 'live') {
      this.mode = 'replay';
      this.playing = false;
      this.conn.pause();
    } else if (this.playing) {
      this.playing = false;
      this.conn.pause();
    } else {
      this.playing = true;
      this.conn.play(this.speed);
    }
    this.notify();
  }

  setSpeed(speed: number) {
    this.speed = speed;
    if (this.mode === 'replay' && this.playing) this.conn.play(speed);
    this.notify();
  }

  goLive() {
    this.conn.goLive();
  }

  reconnect() {
    this.conn.reconnect();
  }

  private onMessage(m: ViewerMessage) {
    switch (m.type) {
      case 'status':
        this.status = m.status;
        this.statusDetail = m.detail ?? '';
        break;
      case 'pace':
        this.ticksPerRealSecond = m.ticksPerRealSecond;
        this.realtime = m.realtime;
        if (this.world) this.world.clock.realtime = m.realtime;
        break;
      case 'spend':
        this.spend = m.spendTodayAud;
        if (this.world) this.world.spendTodayAud = m.spendTodayAud;
        break;
      case 'snapshot': {
        const prevTick = this.world?.clock.tick;
        const cat = this.catalog;
        this.world = viewFromState(m.state as WorldStateView, cat, cat?.ticksPerRealSecond ?? cat?.ticksPerSecond ?? 10);
        this.world.spendTodayAud = this.spend;
        this.world.clock.realtime = this.realtime;
        this.session = m.sessionId;
        this.mode = m.sessionId ? 'replay' : 'live';
        if (!m.sessionId) this.playing = true;
        this.feed = this.conn.feedUntil(m.tick);
        if (prevTick !== m.tick) this.noises = [];
        if (!m.sessionId && this.selectedId && this.conn.memories) void this.refreshBeliefs(this.selectedId);
        break;
      }
      case 'replay.ended':
        if (m.sessionId === this.session) this.playing = false;
        break;
      case 'deltas': {
        if (m.sessionId !== this.session || !this.world) return;
        const fx = applyDeltas(this.world, m.tick, m.changes, this.catalog);
        this.noteOutcomes(m.tick, m.changes);
        // Airdrops and mail are fetched over REST; these deltas just say "look again".
        if (m.changes.some((c) => c.kind === 'airdrop' || c.kind === 'mailbox' || c.kind === 'mail')) for (const l of this.visitorListeners) l();
        for (const n of fx.noises) this.addNoise(n.id, n.notes, n.pos);
        if (this.mode === 'replay') this.feed = this.conn.feedUntil(m.tick);
        if (this.mode === 'live' && this.selectedId && fx.beliefsChanged.includes(this.selectedId) && this.conn.memories) void this.refreshBeliefs(this.selectedId);
        break;
      }
      case 'feedStep': {
        // A step of a recorded decision resolved (done, failed, rejected or superseded): update it in place.
        if (m.sessionId && m.sessionId !== this.session) return;
        for (let i = this.feed.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
          const e = this.feed[i]!;
          if (e.tick < m.feedTick) break;
          if (e.tick !== m.feedTick || e.characterId !== m.characterId) continue;
          const a = e.actions[m.step];
          if (a) {
            a.status = m.status;
            if (m.result !== undefined) a.result = m.result;
          }
          break;
        }
        break;
      }
      case 'feed':
        if (this.mode !== 'live' || m.sessionId) return;
        if (this.feed[this.feed.length - 1] !== m.entry) this.feed.push(m.entry);
        // Bounded, like the source: the panel pages older history back in from the server.
        if (this.feed.length > 2500) this.feed.splice(0, this.feed.length - 2000);
        break;
      default:
        return;
    }
    this.notify();
  }

  private addNoise(characterId: string, notes: string[], pos: Vec2) {
    const n: NoiseEvent = { id: `n${++this.noiseSeq}`, characterId, notes, pos, at: performance.now() };
    this.noises.push(n);
    if (this.noises.length > 12) this.noises.shift();
    for (const l of this.noiseListeners) l(n);
  }
}

export function isWarn(e: FeedEntry): boolean {
  return e.tier === 'fallback' || e.actions.some((a) => a.status === 'rejected' || a.status === 'failed');
}

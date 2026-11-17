/**
 * SIMULATED DATA (`?source=sample`). An in-browser stand-in for `@uas/server`, for offline
 * demos and screenshots. It pre-simulates a few in-world days of history, then advances the
 * live world at 10 ticks/s, and speaks the real protocol: a snapshot `state` shaped like the
 * sim's `WorldState`, real `Delta`s and `FeedEntry`s, and a catalog shaped like
 * `GET /worlds/:id/catalog`.
 */
import type { Delta, FeedEntry, WorldCatalog, WorldStateView } from '@uas/client';
import type { BeliefMark, ConnectionStatus, ViewerMessage, WorldConnection } from '../types.ts';
import { cloneState, createSim, dayOf, step, SECONDS_PER_TICK, TICKS_PER_SECOND, type RobotState, type Scenario, type SimState, type StepOutput } from './sim.ts';
import { OBJECT_VERBS } from './map.ts';
import type { Change } from './types.ts';

const SNAPSHOT_EVERY = 200;
const TERRAIN_KEY = { floor: '.', path: ':', wall: '#', water: '~' } as const;

export interface SampleOptions {
  scenario: Scenario;
  /** Start the live world at this tick (history before it is pre-simulated). */
  startTick: number;
  /** Simulate a dropped connection for the "disconnected" state. */
  disconnectAfterMs?: number;
  seed: number;
}

/** What the sample world's packs would serve from `GET /worlds/:id/catalog`. */
function sampleCatalog(): WorldCatalog {
  const synth = (wave: 'sine' | 'triangle' | 'square' | 'sawtooth', ms: number, extra: Record<string, number> = {}) => ({ synth: { wave, ms, ...extra } });
  return {
    worldId: 'garden-01',
    name: 'Garden 01 (sample)',
    packs: ['basic@0.1.0'],
    ticksPerRealSecond: TICKS_PER_SECOND,
    ticksPerSecond: TICKS_PER_SECOND,
    secondsPerTick: SECONDS_PER_TICK,
    dailyCapAud: 2,
    energyFloor: 0.2,
    energyPerAud: 1.6,
    objects: Object.entries(OBJECT_VERBS).map(([type, verbs]) => ({ type, tags: [], portable: type === 'ball', solid: type !== 'ball' && type !== 'dock' && type !== 'solarPad', verbs })),
    archetypes: [
      {
        type: 'robot',
        tags: ['robot'],
        needs: { cool: { decayPerHour: 0.04, low: 0.25, critical: 0.1 }, signal: { decayPerHour: 0.03, low: 0.3 }, curiosity: { decayPerHour: 0.05, low: 0.3 } },
        energy: { label: 'battery', idleDrainPerHour: 0.02 },
        noises: {
          pitches: { C: 523.25, D: 587.33, E: 659.25, G: 783.99 },
          set: { beep: synth('sine', 120), chirp: synth('triangle', 160, { sweep: 1.5 }), trill: synth('square', 300, { vibratoHz: 18 }), buzz: synth('sawtooth', 250, { octave: -1, rough: 0.4 }) },
          maxChain: 4,
        },
        sightRange: 6,
        hearingRange: 8,
      },
    ],
  } as WorldCatalog;
}

/** The sample sim's state as the real snapshot `state`. */
export function stateOf(s: SimState): WorldStateView {
  const entities: WorldStateView['entities'] = {};
  for (const o of s.objects) entities[o.id] = { id: o.id, kind: 'object', type: o.type, pos: { ...o.pos }, tags: [...o.tags], state: { ...o.state } } as never;
  for (const r of s.robots) {
    entities[r.id] = {
      id: r.id,
      kind: 'character',
      type: 'robot',
      pos: { ...r.pos },
      tags: ['robot'],
      state: { name: r.name },
      needs: { ...r.needs },
      energy: r.energy,
      queue: [],
      ...(r.current && { current: { action: { verb: r.current.verb, ...(r.current.targetId && { targetId: r.current.targetId }), reason: r.current.reason }, startedTick: r.current.startedTick } }),
      mind: { mood: { valence: r.valence, arousal: r.arousal, word: moodWord(r), bias: 0 }, beliefs: r.beliefs.map(toCoreBelief), sleep: r.asleep ? 'asleep' : 'awake' },
    } as never;
  }
  return {
    config: {
      worldId: s.worldId,
      seed: 7,
      grid: {
        width: s.map.width,
        height: s.map.height,
        terrain: {
          '.': { walkable: true, blocksSight: false, soundDamping: 0 },
          ':': { walkable: true, blocksSight: false, soundDamping: 0 },
          '#': { walkable: false, blocksSight: true, soundDamping: 0.8 },
          '~': { walkable: false, blocksSight: false, soundDamping: 0.1 },
        },
        tiles: s.map.tiles.map((k) => TERRAIN_KEY[k]),
      },
      secondsPerTick: SECONDS_PER_TICK,
      dayLengthSeconds: 86400,
      startSecond: 0,
      moveTicksPerTile: 4,
    },
    packVersions: 'basic@0.1.0#sample',
    tick: s.tick,
    entities,
  };
}

/** Sample beliefs count days from 1; the server's day index starts at 0. */
function toCoreBelief(b: RobotState['beliefs'][number]) {
  const { formedTick: _f, revisedTick: _r, ...core } = b;
  return { ...core, lastSupportedDay: b.lastSupportedDay - 1 };
}

function moodWord(r: RobotState): string {
  const v = r.valence;
  const a = r.arousal;
  if (v > 0.35) return a > 0.55 ? 'excited' : 'content';
  if (v > -0.1) return a > 0.55 ? 'alert' : 'calm';
  if (v > -0.45) return a > 0.55 ? 'restless' : 'dull';
  return a > 0.55 ? 'agitated' : 'low';
}

/** Translate one step of sample changes into real deltas. */
function deltasOf(s: SimState, out: StepOutput, prev: Map<string, { x: number; y: number }>, lastAction: Map<string, Change & { kind: 'action' }>): Delta[] {
  const d: Delta[] = [];
  for (const c of out.changes) {
    switch (c.kind) {
      case 'move': {
        const from = prev.get(c.id) ?? c.pos;
        if (from.x !== c.pos.x || from.y !== c.pos.y) d.push({ kind: 'moved', id: c.id, from: { ...from }, to: { ...c.pos } });
        prev.set(c.id, { ...c.pos });
        break;
      }
      case 'mind':
        d.push({ kind: 'needs', id: c.id, values: { energy: c.mind.energy, ...c.mind.needs } });
        d.push({ kind: 'mood', id: c.id, valence: c.mind.valence, arousal: c.mind.arousal, word: c.mind.mood });
        d.push({ kind: 'sleep', id: c.id, phase: c.mind.asleep ? 'asleep' : 'awake' });
        break;
      case 'action': {
        const was = lastAction.get(c.id);
        if (was?.action) d.push({ kind: 'action', id: c.id, action: { verb: was.action.verb, ...(was.action.targetId && { targetId: was.action.targetId }), reason: was.action.reason }, status: 'done' });
        if (c.action) d.push({ kind: 'action', id: c.id, action: { verb: c.action.verb, ...(c.action.targetId && { targetId: c.action.targetId }), reason: c.action.reason }, status: 'started' });
        lastAction.set(c.id, c);
        break;
      }
      case 'noise':
        d.push({ kind: 'vocalize', id: c.id, pos: { ...c.pos }, notes: c.notes });
        break;
      case 'belief': {
        const r = s.robots.find((x) => x.id === c.id);
        if (r) d.push({ kind: 'beliefs', id: c.id, beliefs: r.beliefs.map(toCoreBelief) });
        break;
      }
      case 'alerts': {
        const rej = c.alerts.find((a) => a.kind === 'action-rejected' && a.tick === s.tick);
        if (rej) d.push({ kind: 'action', id: c.id, action: { verb: 'act', reason: '' }, status: 'rejected', reason: rej.text.replace(/^REJECTED:\s*/, '').toLowerCase() });
        break;
      }
      case 'object': {
        const from = prev.get(c.id);
        if (from && (from.x !== c.pos.x || from.y !== c.pos.y)) d.push({ kind: 'moved', id: c.id, from: { ...from }, to: { ...c.pos } });
        prev.set(c.id, { ...c.pos });
        d.push({ kind: 'state', id: c.id, set: { ...c.state } });
        break;
      }
      case 'spend':
        break;
    }
  }
  return d;
}

export class SampleServer implements WorldConnection {
  private live: SimState;
  private snapshots: SimState[] = [];
  private feed: FeedEntry[] = [];
  private feedIndex = new Map<string, FeedEntry>();
  private marks: BeliefMark[] = [];
  private listeners = new Set<(m: ViewerMessage) => void>();
  private timer: number | undefined;
  private replay: SimState | null = null;
  private replaySpeed = 1;
  private replayPlaying = false;
  private status: ConnectionStatus = 'connecting';
  private session = 0;
  private cat = sampleCatalog();
  private livePrev = new Map<string, { x: number; y: number }>();
  private liveAction = new Map<string, Change & { kind: 'action' }>();
  private replayPrev = new Map<string, { x: number; y: number }>();
  private replayAction = new Map<string, Change & { kind: 'action' }>();
  private opts: SampleOptions;

  constructor(opts: SampleOptions) {
    this.opts = opts;
    this.live = createSim(opts.seed, opts.scenario);
    this.snapshots.push(cloneState(this.live));
    while (this.live.tick < opts.startTick) this.advanceLive(false);
  }

  catalog(): WorldCatalog {
    return this.cat;
  }

  subscribe(onMessage: (m: ViewerMessage) => void): () => void {
    this.listeners.add(onMessage);
    onMessage({ type: 'status', status: this.status });
    if (this.listeners.size === 1) this.connect();
    return () => {
      this.listeners.delete(onMessage);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private emit(m: ViewerMessage) {
    for (const l of this.listeners) l(m);
  }

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    this.emit({ type: 'status', status: s });
  }

  private sendSnapshot(s: SimState, sessionId?: string) {
    const prev = sessionId ? this.replayPrev : this.livePrev;
    prev.clear();
    for (const r of s.robots) prev.set(r.id, { ...r.pos });
    for (const o of s.objects) prev.set(o.id, { ...o.pos });
    const acts = sessionId ? this.replayAction : this.liveAction;
    acts.clear();
    this.emit({ type: 'snapshot', worldId: s.worldId, ...(sessionId && { sessionId }), tick: s.tick, state: stateOf(s) });
    this.emitSpend(s);
  }

  private emitPace() {
    this.emit({ type: 'pace', realtime: false, ticksPerRealSecond: TICKS_PER_SECOND });
  }

  private emitSpend(s: SimState) {
    this.emit({ type: 'spend', spendTodayAud: s.spendDay === dayOf(s.tick) ? s.spendTodayAud : 0 });
  }

  private connect() {
    this.setStatus('connecting');
    window.setTimeout(() => {
      this.setStatus('live');
      this.emitPace();
      this.sendSnapshot(this.live);
      this.start();
      if (this.opts.disconnectAfterMs !== undefined) {
        window.setTimeout(() => {
          this.stop();
          this.setStatus('disconnected');
        }, this.opts.disconnectAfterMs);
      }
    }, 650);
  }

  reconnect(): void {
    delete this.opts.disconnectAfterMs;
    this.connect();
  }

  private start() {
    this.stop();
    this.timer = window.setInterval(() => this.loop(), 1000 / TICKS_PER_SECOND);
  }

  private stop() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private loop() {
    // The live world never stops for a viewer; replay runs beside it.
    this.advanceLive(this.replay === null);
    if (this.replay && this.replayPlaying) {
      for (let i = 0; i < this.replaySpeed; i++) {
        if (this.replay.tick >= this.live.tick) {
          this.replayPlaying = false;
          this.emit({ type: 'replay.ended', sessionId: `replay-${this.session}`, tick: this.replay.tick });
          return;
        }
        const out = step(this.replay);
        this.emitStep(this.replay, out, true);
      }
    }
  }

  private advanceLive(emit: boolean) {
    const out = step(this.live);
    for (const e of out.feed) {
      this.feed.push(e);
      this.feedIndex.set(`${e.tick}:${e.characterId}`, e);
    }
    for (const c of out.changes) if (c.kind === 'belief') this.marks.push({ tick: out.tick, characterId: c.id });
    for (const u of out.statusUpdates) {
      const e = this.feedIndex.get(`${u.tick}:${u.characterId}`);
      const a = e?.actions[u.idx];
      if (a) a.status = u.status;
    }
    if (this.live.tick % SNAPSHOT_EVERY === 0) this.snapshots.push(cloneState(this.live));
    const deltas = deltasOf(this.live, out, this.livePrev, this.liveAction);
    if (emit) this.emitStep(this.live, out, false, deltas);
  }

  private emitStep(s: SimState, out: StepOutput, replay: boolean, deltas?: Delta[]) {
    const sessionId = replay ? `replay-${this.session}` : undefined;
    const changes = deltas ?? deltasOf(s, out, this.replayPrev, this.replayAction);
    this.emit({ type: 'deltas', worldId: s.worldId, ...(sessionId && { sessionId }), tick: out.tick, changes });
    if (!replay) for (const e of out.feed) this.emit({ type: 'feed', worldId: s.worldId, entry: e });
    if (out.changes.some((c) => c.kind === 'spend')) this.emitSpend(s);
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
    return { from: 0, to: this.live.tick };
  }

  seek(tick: number): void {
    const t = Math.max(0, Math.min(Math.round(tick), this.live.tick));
    let base = this.snapshots[0]!;
    for (const s of this.snapshots) {
      if (s.tick <= t) base = s;
      else break;
    }
    // Snapshot plus re-simulation, as the real replay does (no model calls).
    const r = cloneState(base);
    while (r.tick < t) step(r);
    this.replay = r;
    this.replayPlaying = false;
    this.session++;
    this.sendSnapshot(r, `replay-${this.session}`);
    if (this.timer === undefined && this.status === 'live') this.start();
  }

  play(speed: number): void {
    this.replaySpeed = Math.max(1, Math.round(speed));
    if (!this.replay) this.seek(this.live.tick - 1);
    this.replayPlaying = true;
  }

  pause(): void {
    if (!this.replay) this.seek(this.live.tick);
    this.replayPlaying = false;
  }

  goLive(): void {
    this.replay = null;
    this.replayPlaying = false;
    this.sendSnapshot(this.live);
  }
}

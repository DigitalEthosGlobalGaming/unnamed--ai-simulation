import type { Character, Delta, InputEvent, JobName, Json, TickDeltas } from '@uas/core';
import { MindSystem } from '@uas/mind';
import { ModelGateway, ModelHost, parseModelsConfig, type GatewayOptions, type QueueStats, type UsageRow } from '@uas/models';
import { and, eq } from 'drizzle-orm';
import { World, type WorldState } from '@uas/sim';
import { Recorder, SqliteInputLog, SqliteReadModels, SqliteSnapshotStore, openDb, schema, type Db } from '@uas/store';
import { loadMap, loadPacks } from './catalog.ts';
import { tzOffsetMinutes, type WorldFile } from './config.ts';

export interface RuntimeOptions {
  dbPath: string;
  gateway?: GatewayOptions;
  /** Start from this state instead of the config or the database (forks). */
  initialState?: WorldState;
  parent?: { worldId: string; forkTick: number };
  log?: (msg: string) => void;
}

export interface WorldStatus {
  worldId: string;
  tick: number;
  day: number;
  timeOfDay: number;
  paused: boolean;
  timeScale: number;
  /** Rate while watched; `effectiveTicksPerRealSecond` is what runs now. */
  ticksPerRealSecond: number;
  idleTicksPerRealSecond: number;
  watched: boolean;
  effectiveTicksPerRealSecond: number;
  pendingJobs: number;
  visitorQueueDepth: number;
  costAudToday: number;
  modelLatencyMs: number;
  tickLagMs: number;
  clockMode: 'realtime' | 'scaled';
  timezone: string;
  /** In-world time as local wall-clock seconds since the epoch (realtime) or seconds from the start (scaled). */
  worldSeconds: number;
  /** How far a real-time world is from the wall clock (it re-aligns past clock.maxDriftSeconds). */
  driftSeconds: number;
  /** In-world seconds per tick, and the resulting in-world seconds per real second. */
  secondsPerTick: number;
  inWorldSecondsPerRealSecond: number;
  queue: QueueStats;
}

/**
 * One live world: sim + mind, recorded to the input log, snapshotted, with model jobs sent
 * through the gateway. Runs inside a worker thread; also usable in-process for tests.
 */
export class WorldRuntime {
  readonly config: WorldFile;
  readonly db: Db;
  readonly log: SqliteInputLog;
  readonly snapshots: SqliteSnapshotStore<WorldState>;
  readonly reads: SqliteReadModels;
  readonly minds = new MindSystem();
  readonly gateway: ModelGateway;
  readonly host: ModelHost;
  world!: World;
  recorder!: Recorder<WorldState, World>;
  paused = false;
  timeScale: number;
  /** A viewer is subscribed (set by the supervisor); the world runs faster while watched. */
  watched = false;
  private lastDay = -1;
  private modelsBusy = false;
  private latencies: number[] = [];
  private readonly opts: RuntimeOptions;

  constructor(config: WorldFile, opts: RuntimeOptions) {
    this.config = config;
    this.opts = opts;
    this.timeScale = config.timeScale;
    this.db = openDb(opts.dbPath);
    this.log = new SqliteInputLog(this.db);
    this.snapshots = new SqliteSnapshotStore<WorldState>(this.db);
    this.reads = new SqliteReadModels(this.db);
    this.gateway = new ModelGateway(parseModelsConfig(config.models), {
      ...opts.gateway,
      log: opts.log ?? (() => {}),
    });
    this.host = new ModelHost(this.gateway);
    // The daily AUD cap survives restarts: today's usage is reloaded and every call is persisted.
    const today = this.gateway.meter.currentDay();
    this.gateway.meter.seed(
      this.db
        .select()
        .from(schema.usageDaily)
        .where(and(eq(schema.usageDaily.worldId, config.id), eq(schema.usageDaily.day, today)))
        .all()
        .map(({ worldId: _w, ...r }) => ({ ...r, job: r.job as JobName })),
    );
    this.gateway.meter.onRecord = (r) => this.saveUsage(r);
  }

  /** Resume from the database if this world has history, else create it from config. */
  start(): void {
    const { registry, packs } = loadPacks(this.config.packs);
    const id = this.config.id;
    const latest = this.snapshots.latest(id);
    if (latest) {
      this.world = World.fromSnapshot(latest.state, registry, this.minds);
      const events = this.log.read(id, { fromTick: latest.tick });
      for (const e of events) this.world.enqueue(e);
      // Re-simulate to where the log ends, without calling models (their answers are logged).
      const end = events.length ? events[events.length - 1]!.tick + 1 : latest.tick;
      while (this.world.tick < end) {
        this.world.step();
        this.minds.drain();
      }
    } else {
      const mind = { energyPerAud: this.gateway.config.energyPerAud, ...this.config.mind } as Json;
      if (this.opts.initialState) {
        const state = structuredClone(this.opts.initialState);
        state.config.worldId = id;
        this.world = World.fromSnapshot(state, registry, this.minds);
      } else {
        this.world = World.create(
          { worldId: id, seed: this.config.seed, grid: loadMap(this.config.map), ...this.config.sim },
          registry,
          this.config.entities.map((e) => ({ type: e.type, pos: e.pos, ...(e.id && { id: e.id }), ...(e.state && { state: e.state as Record<string, Json> }) })),
          this.minds,
          { mind },
        );
      }
      this.db
        .insert(schema.worlds)
        .values({ id, config: this.config, parentWorldId: this.opts.parent?.worldId ?? null, forkTick: this.opts.parent?.forkTick ?? null, createdAt: new Date().toISOString() })
        .onConflictDoNothing()
        .run();
    }
    for (const p of packs) {
      this.db.insert(schema.packs).values({ name: p.manifest.name, version: p.manifest.version, contentHash: p.contentHash, licence: p.manifest.licence }).onConflictDoNothing().run();
    }
    this.recorder = new Recorder(this.world, this.log, this.snapshots, {
      worldId: id,
      packVersions: this.world.state.packVersions,
      snapshotEveryTicks: this.config.snapshotEveryTicks,
    });
    this.lastDay = this.world.day;
    if (this.config.clock.mode === 'realtime') {
      // A new world is anchored to the wall clock; a resumed one jumps over the downtime.
      // Both are logged inputs, so replays reproduce them without reading a clock.
      if (latest) this.submitClock('clock.jump', 'restart');
      else this.submitClock('clock.anchor');
    }
  }

  /** Wall-clock time in the world's timezone, as the sim's clock payload. Only the server reads clocks. */
  private clockPayload(reason?: 'restart' | 'resume' | 'realign' | 'sync') {
    const epochMs = Date.now();
    const timezone = this.config.clock.timezone;
    return { epochMs, tzOffsetMinutes: tzOffsetMinutes(timezone, epochMs), timezone, ...(reason && { reason }) };
  }

  private submitClock(type: 'clock.anchor' | 'clock.jump', reason?: 'restart' | 'resume' | 'realign' | 'sync'): void {
    this.recorder.submit(type, this.clockPayload(reason));
  }

  /** Re-align a real-time world with the wall clock (logged `clock.jump`). No-op for scaled worlds. */
  realign(reason: 'resume' | 'realign' | 'sync' = 'realign'): void {
    if (this.config.clock.mode === 'realtime') this.submitClock('clock.jump', reason);
  }

  /** Seconds the world is ahead (+) or behind (-) the wall clock; 0 for scaled worlds. */
  drift(): number {
    if (this.config.clock.mode !== 'realtime') return 0;
    const p = this.clockPayload();
    return this.world.seconds - (Math.round(p.epochMs / 1000) + p.tzOffsetMinutes * 60);
  }

  /** One tick: record arrived model answers, step, persist read models, dispatch new jobs. */
  tick(): TickDeltas {
    for (const answer of this.host.flush()) {
      if (answer.modelId !== 'queue') this.latencies = [...this.latencies, answer.usage.latencyMs].slice(-50);
      this.recorder.submit('model.answer', answer, { jobId: answer.jobId });
    }
    // Tell the minds when the model queue is backed up, so routine triggers use autopilot.
    if (this.host.busy !== this.modelsBusy) {
      this.modelsBusy = this.host.busy;
      this.recorder.submit('models.load', { busy: this.modelsBusy });
    }
    const out = this.recorder.step();
    this.reads.write(this.config.id, out.tick, out.changes);
    this.host.setTick(this.world.tick);
    this.host.dispatch(this.minds.drain());
    if (this.world.day !== this.lastDay) {
      this.lastDay = this.world.day;
      this.recorder.takeSnapshot(); // every in-world day boundary
    }
    return out;
  }

  submit(type: string, payload: unknown, causedBy?: InputEvent['causedBy']): InputEvent {
    return this.recorder.submit(type, payload, causedBy);
  }

  status(tickLagMs = 0): WorldStatus {
    const queue = this.world.characters().reduce((a, c) => a + (c.mind?.visitorQueue.length ?? 0), 0);
    return {
      worldId: this.config.id,
      tick: this.world.tick,
      day: this.world.day,
      timeOfDay: this.world.timeOfDay,
      paused: this.paused,
      timeScale: this.timeScale,
      ticksPerRealSecond: this.config.ticksPerRealSecond,
      idleTicksPerRealSecond: this.config.idleTicksPerRealSecond,
      watched: this.watched,
      effectiveTicksPerRealSecond: this.ticksPerRealSecond(),
      secondsPerTick: this.world.state.config.secondsPerTick,
      clockMode: this.config.clock.mode,
      timezone: this.config.clock.timezone,
      worldSeconds: this.world.seconds,
      driftSeconds: Math.round(this.drift()),
      inWorldSecondsPerRealSecond: this.world.state.config.secondsPerTick * this.ticksPerRealSecond() * this.timeScale,
      queue: this.host.stats(),
      pendingJobs: this.host.pending,
      visitorQueueDepth: queue,
      costAudToday: this.gateway.meter.spentTodayAud(),
      modelLatencyMs: this.latencies.length ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : 0,
      tickLagMs,
    };
  }

  /** Ticks per real second at timeScale 1: full speed while watched, slow when nobody is. */
  ticksPerRealSecond(): number {
    return this.watched ? this.config.ticksPerRealSecond : this.config.idleTicksPerRealSecond;
  }

  character(id: string): Character | undefined {
    const c = this.world.entity(id);
    return c?.kind === 'character' ? c : undefined;
  }

  mindView(id: string) {
    const c = this.character(id);
    if (!c?.mind) return undefined;
    const m = c.mind;
    return {
      id: c.id,
      needs: c.needs,
      energy: c.energy,
      mood: m.mood,
      sleep: m.sleep,
      openItems: m.openItems,
      queue: c.queue,
      current: c.current ?? null,
      pendingJobs: m.pendingJobs.map((j) => ({ jobId: j.jobId, job: j.job, tick: j.tick })),
      visitorQueue: m.visitorQueue,
    };
  }

  memoriesView(id: string) {
    const m = this.character(id)?.mind;
    if (!m) return undefined;
    return { stm: m.stm, ltm: m.ltm, beliefs: m.beliefs, sheet: m.sheet };
  }

  /** Persist usage totals and take a final snapshot. */
  private saveUsage(r: UsageRow): void {
    this.db
      .insert(schema.usageDaily)
      .values({ worldId: this.config.id, ...r })
      .onConflictDoUpdate({
        target: [schema.usageDaily.worldId, schema.usageDaily.day, schema.usageDaily.modelId, schema.usageDaily.job],
        set: { calls: r.calls, inputTokens: r.inputTokens, cachedInputTokens: r.cachedInputTokens, outputTokens: r.outputTokens, costAud: r.costAud, energy: r.energy },
      })
      .run();
  }

  /** Take a final snapshot (usage is already persisted per call). */
  shutdown(): void {
    this.recorder.takeSnapshot();
  }
}

export type { Delta };

import { randomBytes } from 'node:crypto';
import { cleanMailText, mailTextProblem, parseDurationSeconds, type ObjectDef2, type Character, type Delta, type InputEvent, type JobName, type Json, type Pos, type Sender, type TickDeltas } from '@uas/core';
import { MindSystem, allowedDepth, mindConfigOf } from '@uas/mind';
import { PERSISTED, SETTINGS_SCHEMA, SettingsPatchSchema, type SettingsPatch, type SettingsValues } from './settings.ts';
import { ModelGateway, ModelHost, parseModelsConfig, type GatewayOptions, type QueueStats, type UsageRow } from '@uas/models';
import { and, eq } from 'drizzle-orm';
import { World, type WorldState } from '@uas/sim';
import { Recorder, SqliteInputLog, SqliteReadModels, SqliteSnapshotStore, openDb, schema, type Db } from '@uas/store';
import { loadMap, loadPacks } from './catalog.ts';
import { resolve } from 'node:path';
import { latestEvalReport, noopRefine, type RefineHook } from './refine.ts';
import { tzOffsetMinutes, type WorldFile } from './config.ts';
import { DEFAULT_LIMITS, airdropView, beliefsAbout, mailStatus, refuse, type Airdrop, type MailStatus, type Refusal, type VisitorLimits } from './visitors.ts';

export interface RuntimeOptions {
  dbPath: string;
  gateway?: GatewayOptions;
  /** Start from this state instead of the config or the database (forks). */
  initialState?: WorldState;
  parent?: { worldId: string; forkTick: number };
  log?: (msg: string) => void;
  /** Called at the end of each sleep (default: does nothing). */
  refine?: RefineHook;
  /** Where the latest eval report for the refine hook is read from (default docs/benchmarks/evals). */
  evalReportsDir?: string;
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
  /** Messages waiting in the world's mailbox. */
  mailWaiting: number;
  /** Read-only: doesn't tick, refuses inputs. */
  archived: boolean;
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
  /** Visitor limits (world settings, persisted through `settings.change`). */
  limits: VisitorLimits = structuredClone(DEFAULT_LIMITS);
  /** Last drop / post per user (real ms): cooldowns are admission control, outside the sim. */
  private readonly lastDrop = new Map<string, number>();
  private readonly lastPost = new Map<string, number>();

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
      // Older pack versions load for an upgrade: the log replays as recorded, then `pack.loaded` (below).
      this.world = World.fromSnapshot(latest.state, registry, this.minds, { allowPackUpgrade: true });
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
        this.world = World.fromSnapshot(state, registry, this.minds, { allowPackUpgrade: true });
      } else {
        this.world = World.create(
          { worldId: id, seed: this.config.seed, grid: loadMap(this.config.map), ...simConfig(this.config) },
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
      packVersions: () => this.world.state.packVersions,
      snapshotEveryTicks: this.config.snapshotEveryTicks,
    });
    this.lastDay = this.world.day;
    // Archived: read-only. Nothing is logged, nothing runs; history stays readable.
    if (this.config.archived) return;
    // Content packs changed since the last snapshot (e.g. the airdrop and mailbox objects): logged.
    if (this.world.state.packVersions !== registry.packVersions) {
      this.opts.log?.(`content packs changed: ${this.world.state.packVersions} -> ${registry.packVersions}`);
      this.recorder.submit('pack.loaded', { packVersions: registry.packVersions });
    }
    // Visitor characters are gone (visitors drop items and post mail now): remove leftovers, logged.
    for (const e of this.world.entities()) if (e.kind === 'character' && e.state.visitor === true) this.recorder.submit('admin.despawn', { id: e.id });
    if (latest) this.spawnMissingConfigEntities();
    this.restoreSettings();
    if (this.config.clock.mode === 'realtime') {
      // A world switching to real time (e.g. from an older scaled config) gets the configured
      // timing first, so secondsPerTick × ticksPerRealSecond = 1. Logged, so replays follow.
      const sc = this.world.state.config;
      const want = this.config.sim;
      const change = {
        ...(sc.secondsPerTick !== want.secondsPerTick && { secondsPerTick: want.secondsPerTick }),
        ...(want.moveTicksPerTile !== undefined && sc.moveTicksPerTile !== want.moveTicksPerTile && { moveTicksPerTile: want.moveTicksPerTile }),
        ...((sc.durationScale ?? 1) !== want.durationScale && { durationScale: want.durationScale }),
      };
      if (Object.keys(change).length) this.recorder.submit('sim.config', change);
      // A world never anchored (new, or created before the real-time clock) is anchored to the
      // wall clock; an anchored one jumps over the downtime. Both are logged inputs.
      if (!this.world.state.clock?.anchored) this.submitClock('clock.anchor');
      else if (latest) this.submitClock('clock.jump', 'restart');
    }
  }

  /**
   * Config entities with a fixed id that a resumed world lacks (e.g. the mailbox, added to
   * garden.yaml after the world was created) are spawned once, logged as `admin.spawn`. One an
   * admin deleted (a logged `admin.despawn` of that id) stays deleted.
   */
  private spawnMissingConfigEntities(): void {
    const deleted = new Set<string>();
    for (const e of this.log.read(this.config.id)) {
      if (e.type === 'admin.despawn') deleted.add(String((e.payload as { id?: unknown }).id));
    }
    for (const e of this.config.entities) {
      if (!e.id || this.world.entity(e.id) || deleted.has(e.id)) continue;
      this.opts.log?.(`spawning ${e.id} (${e.type}) from the world config: it is missing from this world`);
      this.recorder.submit('admin.spawn', { id: e.id, type: e.type, pos: e.pos, ...(e.state && { state: e.state as Record<string, Json> }) });
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
    for (const d of out.changes) if (d.kind === 'sleepWork' && d.step === 'refine') this.runRefine(d.id);
    this.host.setTick(this.world.tick);
    this.host.dispatch(this.minds.drain());
    if (this.world.day !== this.lastDay) {
      this.lastDay = this.world.day;
      this.recorder.takeSnapshot(); // every in-world day boundary
    }
    return out;
  }

  private lastRefineTick = new Map<string, number>();

  /** The sleep pipeline's last step, host side: the refine hook gets the day's feed, outcomes and evals. */
  private runRefine(characterId: string): void {
    const c = this.character(characterId);
    const m = c?.mind;
    if (!m) return;
    const day = m.sleepWork?.day ?? this.world.day;
    const since = this.lastRefineTick.get(characterId) ?? -1;
    this.lastRefineTick.set(characterId, this.world.tick);
    const feed = this.reads.feed(this.config.id, characterId, 500).filter((e) => e.tick > since);
    const outcomes = [...m.stm, ...m.ltm].filter((x) => x.kind === 'outcome' && x.day === day);
    try {
      (this.opts.refine ?? noopRefine).refine({ worldId: this.config.id, characterId, day, feed, outcomes, evals: latestEvalReport(this.opts.evalReportsDir ?? resolve('docs/benchmarks/evals')) });
    } catch (e) {
      this.opts.log?.(`refine hook failed: ${(e as Error).message}`);
    }
  }

  /** Archived worlds don't tick and refuse every input. */
  get archived(): boolean {
    return this.config.archived;
  }

  submit(type: string, payload: unknown, causedBy?: InputEvent['causedBy']): InputEvent {
    if (this.config.archived) throw new Error('world archived');
    return this.recorder.submit(type, payload, causedBy);
  }

  status(tickLagMs = 0): WorldStatus {
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
      mailWaiting: this.world.state.mailbox?.queue.length ?? 0,
      archived: this.config.archived,
      costAudToday: this.gateway.meter.spentTodayAud(),
      modelLatencyMs: this.latencies.length ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : 0,
      tickLagMs,
    };
  }

  // ------------------------------------------------------------------ live settings

  /** Pause, speed and realign. Real-time worlds catch up with the wall clock after a pause or a speed-up (logged jumps). */
  setClock(c: { paused?: boolean; timeScale?: number; watched?: boolean; realign?: boolean }): void {
    const wasPaused = this.paused;
    const wasScale = this.timeScale;
    if (c.paused !== undefined) this.paused = c.paused;
    if (c.timeScale !== undefined) this.timeScale = c.timeScale;
    if (c.watched !== undefined) this.watched = c.watched;
    if (c.realign) this.realign('realign');
    else if (wasPaused && !this.paused) this.realign('resume');
    else if (wasScale !== 1 && this.timeScale === 1) this.realign('realign');
  }

  /**
   * Current settings. `pending` overlays a change that was just logged but is applied by the sim
   * and mind on the next tick, so a PATCH response already shows the new values.
   */
  settingsValues(pending: Pending = {}): SettingsValues {
    const mind = { ...mindConfigOf(this.world.state.ext), ...pending.mind };
    const sc = { ...this.world.state.config, ...pending.timing };
    return {
      ticksPerRealSecond: this.config.ticksPerRealSecond,
      moveSecondsPerTile: Math.round(sc.moveTicksPerTile * sc.secondsPerTick * 1000) / 1000,
      timeScale: this.timeScale,
      paused: this.paused,
      dailyCapAud: this.gateway.config.dailyCapAud,
      energyPerAud: mind.energyPerAud,
      hostedModels: this.gateway.hostedEnabled,
      needDecayMultiplier: mind.needDecayMultiplier,
      batteryPlanAbove: mind.batteryPlanAbove,
      batteryGutAbove: mind.batteryGutAbove,
      batteryHabitAbove: mind.batteryHabitAbove,
      batteryTopUp: 0,
      escalateBelow: this.gateway.config.escalateBelow,
      ...structuredClone(this.limits),
    };
  }

  /** Read-only values derived from the settings and today's usage. */
  settingsDerived(pending: Pending = {}) {
    const values = this.settingsValues(pending);
    const measured = this.gateway.averageDecisionCostAud();
    const avg = measured ?? this.gateway.estimateDecisionCostAud();
    const battery = avg * values.energyPerAud;
    const spent = this.gateway.meter.spentTodayAud();
    const sc = { ...this.world.state.config, ...pending.timing };
    return {
      averageDecisionCostAud: avg,
      averageDecisionCostEstimated: measured === undefined,
      batteryPerDecision: battery,
      decisionsPerFullBattery: battery > 0 ? Math.floor(1 / battery) : null,
      spentTodayAud: spent,
      dailyCapAud: values.dailyCapAud,
      capRemainingAud: Math.max(0, values.dailyCapAud - spent),
      hostedModelsAvailable: this.gateway.hostedAvailable(),
      secondsPerTick: sc.secondsPerTick,
      moveTicksPerTile: sc.moveTicksPerTile,
      inWorldSecondsPerRealSecond: sc.secondsPerTick * this.ticksPerRealSecond() * this.timeScale,
    };
  }

  settings() {
    return { values: this.settingsValues(), schema: SETTINGS_SCHEMA, derived: this.settingsDerived() };
  }

  /**
   * Validate and apply a settings change live. It is logged as a `settings.change` input (the
   * mind applies energy rate and need decay from it, so replays follow), plus a `sim.config`
   * input when tick rate or walking speed change the sim's timing.
   */
  applySettings(raw: unknown, userId?: string) {
    if (this.config.archived) throw new Error('world archived');
    const r = SettingsPatchSchema.safeParse(raw);
    if (!r.success) throw new Error(`settings: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const before = this.settingsValues();
    const { batteryTopUp, ...rest } = r.data;
    const patch = Object.fromEntries(Object.entries(rest).filter(([k, v]) => JSON.stringify(before[k as keyof SettingsValues]) !== JSON.stringify(v))) as SettingsPatch;
    const effects: string[] = [];
    // Admin top-up (decision 43): a logged edit of each robot's battery; only sleep recharges otherwise.
    if (batteryTopUp) {
      for (const c of this.world.characters()) {
        if (!c.mind) continue;
        const energy = Math.min(1, Math.round((c.energy + batteryTopUp) * 1000) / 1000);
        this.recorder.submit('admin.edit', { id: c.id, energy }, userId ? { userId } : undefined);
        effects.push(`${c.id} battery: ${Math.round(c.energy * 100)}% → ${Math.round(energy * 100)}%`);
      }
      if (Object.keys(patch).length === 0) return { values: before, derived: this.settingsDerived(), effects };
    }
    if (Object.keys(patch).length === 0) return { values: before, derived: this.settingsDerived(), effects: ['no change'] };
    this.recorder.submit('settings.change', { changes: patch }, userId ? { userId } : undefined);
    const timing = this.applyRuntimeSettings(patch);
    if (timing) {
      this.recorder.submit('sim.config', timing);
      effects.push(`sim timing: ${Object.entries(timing).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    if (patch.paused !== undefined || patch.timeScale !== undefined) {
      this.setClock({ ...(patch.paused !== undefined && { paused: patch.paused }), ...(patch.timeScale !== undefined && { timeScale: patch.timeScale }) });
      effects.push(`clock: ${this.paused ? 'paused' : 'running'} at ${this.timeScale}×`);
    }
    for (const k of Object.keys(patch) as (keyof SettingsPatch)[]) {
      if (k === 'paused' || k === 'timeScale') continue;
      effects.push(`${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(patch[k])}`);
    }
    const pending: Pending = {
      ...(timing && { timing }),
      mind: {
        ...(patch.energyPerAud !== undefined && { energyPerAud: patch.energyPerAud }),
        ...(patch.needDecayMultiplier !== undefined && { needDecayMultiplier: patch.needDecayMultiplier }),
        ...(patch.batteryPlanAbove !== undefined && { batteryPlanAbove: patch.batteryPlanAbove }),
        ...(patch.batteryGutAbove !== undefined && { batteryGutAbove: patch.batteryGutAbove }),
        ...(patch.batteryHabitAbove !== undefined && { batteryHabitAbove: patch.batteryHabitAbove }),
      },
    };
    return { values: this.settingsValues(pending), derived: this.settingsDerived(pending), effects };
  }

  /**
   * Apply the host-side part of a settings patch (tick rate, gateway). Returns the sim timing
   * change it implies, if any (real time keeps one in-world second per real second).
   */
  private applyRuntimeSettings(patch: SettingsPatch): { secondsPerTick?: number; moveTicksPerTile?: number; durationScale?: number } | undefined {
    if (patch.dailyCapAud !== undefined) this.gateway.config.dailyCapAud = patch.dailyCapAud;
    if (patch.escalateBelow !== undefined) this.gateway.config.escalateBelow = patch.escalateBelow;
    if (patch.energyPerAud !== undefined) this.gateway.config.energyPerAud = patch.energyPerAud;
    if (patch.hostedModels !== undefined) this.gateway.hostedEnabled = patch.hostedModels;
    for (const k of Object.keys(DEFAULT_LIMITS) as (keyof VisitorLimits)[]) {
      if (patch[k] !== undefined) (this.limits as unknown as Record<string, unknown>)[k] = structuredClone(patch[k]);
    }
    if (patch.ticksPerRealSecond === undefined && patch.moveSecondsPerTile === undefined) return undefined;
    const sc = this.world.state.config;
    const realtime = this.config.clock.mode === 'realtime';
    const moveSeconds = patch.moveSecondsPerTile ?? sc.moveTicksPerTile * sc.secondsPerTick;
    let spt = sc.secondsPerTick;
    if (patch.ticksPerRealSecond !== undefined) {
      this.config.ticksPerRealSecond = patch.ticksPerRealSecond;
      if (realtime) {
        this.config.idleTicksPerRealSecond = patch.ticksPerRealSecond;
        spt = 1 / patch.ticksPerRealSecond;
      }
    }
    const change = {
      ...(spt !== sc.secondsPerTick && { secondsPerTick: spt }),
      ...(realtime && 1 / spt !== (sc.durationScale ?? 1) && { durationScale: 1 / spt }),
    } as { secondsPerTick?: number; moveTicksPerTile?: number; durationScale?: number };
    const moveTicks = Math.max(1, Math.round(moveSeconds / spt));
    if (moveTicks !== sc.moveTicksPerTile) change.moveTicksPerTile = moveTicks;
    this.config.sim = { ...this.config.sim, secondsPerTick: spt, moveTicksPerTile: moveTicks, durationScale: realtime ? 1 / spt : 1 };
    return Object.keys(change).length ? change : undefined;
  }

  /** Re-apply persisted settings from the log after a restart (the sim/mind parts are already in the state). */
  private restoreSettings(): void {
    const merged: SettingsPatch = {};
    for (const e of this.log.read(this.config.id)) {
      if (e.type !== 'settings.change') continue;
      const changes = (e.payload as { changes?: SettingsPatch }).changes ?? {};
      for (const k of PERSISTED) if (changes[k] !== undefined) (merged as Record<string, unknown>)[k] = changes[k];
    }
    if (Object.keys(merged).length === 0) return;
    this.applyRuntimeSettings(merged);
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
      sleepPressure: m.sleepPressure ?? 0,
      fog: m.fog ?? 0,
      sleepWork: m.sleepWork ?? null,
      thinking: { allowed: allowedDepth(c.energy, mindConfigOf(this.world.state.ext), m.energyFloorLatched) },
    };
  }

  memoriesView(id: string) {
    const m = this.character(id)?.mind;
    if (!m) return undefined;
    return { stm: m.stm, ltm: m.ltm, beliefs: m.beliefs, sheet: m.sheet, sheetHistory: m.sheetHistory ?? [], goal: m.goal ?? null, habits: m.habits ?? [] };
  }

  // ------------------------------------------------------------------ visitors: airdrops and the mailbox

  airdrops(): Airdrop[] {
    return this.world.entities().filter((e) => e.type === 'airdrop').map((e) => airdropView(e));
  }

  /** One drop, with what the world's characters believe about things like it. */
  airdrop(dropId: string): (Airdrop & { beliefs: ReturnType<typeof beliefsAbout> }) | Refusal {
    const e = this.world.entities().find((x) => x.type === 'airdrop' && x.state.dropId === dropId);
    if (!e) return refuse(404, `no airdrop ${dropId}`);
    return { ...airdropView(e), beliefs: beliefsAbout(this.world.state, e) };
  }

  /**
   * Drop a catalogue item (already validated by the server). Limits apply to visitors, not admins.
   * Logged as `airdrop.drop` with a copy of the item JSON; the sim lands it on the nearest free tile.
   */
  dropItem(item: ObjectDef2, pos: Pos, by: Sender): Airdrop | Refusal {
    const L = this.limits;
    if (!L.catalogEnabled.includes('*') && !L.catalogEnabled.includes(item.id)) return refuse(403, `${item.name} is not enabled in this world`);
    if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) return refuse(400, 'pos must be { x, y }');
    const drops = this.airdrops();
    const at = this.world.nearestFreeTile(pos);
    if (!at) return refuse(409, 'there is no free tile to land on');
    if (!by.admin) {
      if (drops.length >= L.airdropWorldCap) return refuse(409, `the world already holds ${drops.length} dropped items (limit ${L.airdropWorldCap})`);
      const mine = this.world.entities().filter((e) => e.type === 'airdrop' && (e.state.droppedBy as { userKey?: string } | undefined)?.userKey === by.userKey).length;
      if (mine >= L.airdropMaxActivePerVisitor) return refuse(429, `you already have ${mine} items in this world (limit ${L.airdropMaxActivePerVisitor})`);
      const wait = this.cooldownLeft(this.lastDrop, by.userKey, L.airdropCooldownSeconds);
      if (wait > 0) return refuse(429, `please wait ${wait} s before dropping again`);
    }
    const expires = item.expiresAfter ? parseDurationSeconds(item.expiresAfter) : L.airdropDefaultExpiry;
    const dropId = randomBytes(6).toString('hex');
    const e = this.submit('airdrop.drop', { dropId, item: item as unknown as Json, pos: at, by, ...(expires > 0 && { expiresAfterSeconds: expires }) }, { userId: by.userKey });
    if (!by.admin) this.lastDrop.set(by.userKey, Date.now());
    const ticks = expires > 0 ? Math.max(1, Math.round(expires / this.world.state.config.secondsPerTick)) : 0;
    const uses = item.state.uses?.initial;
    return {
      id: dropId,
      entityId: `drop-${dropId}`,
      itemId: item.id,
      item,
      pos: at,
      droppedBy: { username: by.username, admin: by.admin },
      droppedTick: e.tick,
      ...(ticks && { expiresTick: e.tick + ticks }),
      ...(uses !== undefined && { usesLeft: uses }),
    };
  }

  removeAirdrop(dropId: string, userId?: string): { ok: true } | Refusal {
    if (!this.world.entities().some((x) => x.type === 'airdrop' && x.state.dropId === dropId)) return refuse(404, `no airdrop ${dropId}`);
    this.submit('airdrop.remove', { dropId, reason: 'deleted' }, userId ? { userId } : undefined);
    return { ok: true };
  }

  /** Post a note to the mailbox: cleaned, length-capped and filtered; limits for visitors only. */
  postMail(raw: unknown, by: Sender): MailStatus | Refusal {
    if (typeof raw !== 'string') return refuse(400, 'text must be a string');
    const problem = mailTextProblem(raw);
    if (problem) return refuse(400, problem);
    const text = cleanMailText(raw);
    const L = this.limits;
    const queue = this.world.state.mailbox?.queue ?? [];
    if (!by.admin) {
      if (queue.length >= L.mailCapacity) return refuse(429, 'the mailbox is full; try again later');
      const mine = queue.filter((m) => m.by.userKey === by.userKey).length;
      if (mine >= L.mailMaxWaitingPerVisitor) return refuse(429, `you already have ${mine} unread messages waiting (limit ${L.mailMaxWaitingPerVisitor})`);
      const wait = this.cooldownLeft(this.lastPost, by.userKey, L.mailCooldownSeconds);
      if (wait > 0) return refuse(429, `please wait ${wait} s before posting again`);
    }
    const mailId = randomBytes(6).toString('hex');
    const e = this.submit('mail.post', { mailId, text, by, ...(L.mailExpirySeconds > 0 && { expiresAfterSeconds: L.mailExpirySeconds }) }, { userId: by.userKey });
    if (!by.admin) this.lastPost.set(by.userKey, Date.now());
    const row = { worldId: this.config.id, mailId, text, username: by.username, admin: by.admin, userKey: by.userKey, postedTick: e.tick, postedAt: new Date().toISOString(), status: 'waiting', statusTick: null, readerId: null };
    this.reads.addMail(row);
    return mailStatus(row, { position: queue.length + 1, showText: true });
  }

  removeMail(mailId: string, userId?: string): { ok: true } | Refusal {
    if (!this.world.state.mailbox?.queue.some((m) => m.mailId === mailId)) return refuse(404, `no waiting message ${mailId}`);
    this.submit('mail.remove', { mailId }, userId ? { userId } : undefined);
    return { ok: true };
  }

  /** The mailbox for one viewer: the count for everyone, own messages for a sender, everything for admins. */
  mail(viewer: { userKey?: string; admin: boolean }): { waiting: number; mine?: MailStatus[]; all?: MailStatus[] } {
    const queue = this.world.state.mailbox?.queue ?? [];
    const view = (rows: ReturnType<SqliteReadModels['mail']>) =>
      rows.map((r) => {
        const i = queue.findIndex((m) => m.mailId === r.mailId);
        const status = i >= 0 ? { ...r, status: 'waiting' } : r;
        let reaction: MailStatus['reaction'];
        if (status.status === 'read' && status.readerId && status.statusTick !== null) {
          const f = this.reads.feedAfter(this.config.id, status.readerId, status.statusTick);
          if (f) reaction = { feedTick: f.tick, summary: f.actions.map((a) => `${a.verb}${a.reason ? `: ${a.reason}` : ''}`).join('; '), ...(f.notes && { notes: f.notes }) };
        }
        return mailStatus(status, { ...(i >= 0 && { position: i + 1 }), showText: true, ...(reaction && { reaction }) });
      });
    return {
      waiting: queue.length,
      ...(viewer.userKey && { mine: view(this.reads.mail(this.config.id, { userKey: viewer.userKey })) }),
      ...(viewer.admin && { all: view(this.reads.mail(this.config.id)) }),
    };
  }

  private cooldownLeft(map: Map<string, number>, key: string, seconds: number): number {
    const last = map.get(key);
    if (last === undefined || seconds <= 0) return 0;
    return Math.max(0, Math.ceil(seconds - (Date.now() - last) / 1000));
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

/** The sim's part of a world config (seconds-based keys are already resolved to ticks). */
function simConfig(c: WorldFile) {
  const { moveSecondsPerTile: _seconds, ...sim } = c.sim;
  return sim;
}

/** A just-logged settings change the sim and mind will apply on the next tick. */
interface Pending {
  timing?: { secondsPerTick?: number; moveTicksPerTile?: number; durationScale?: number };
  mind?: { energyPerAud?: number; needDecayMultiplier?: number; batteryPlanAbove?: number; batteryGutAbove?: number; batteryHabitAbove?: number };
}

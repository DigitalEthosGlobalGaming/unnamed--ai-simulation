import type { InputEvent, WorldId } from '@uas/core';
import type { InputLog } from './log.ts';
import type { Snapshot, SnapshotStore } from './snapshots.ts';

/** What the store needs from a simulation; `@uas/sim`'s World satisfies it. */
export interface Simulation<S> {
  readonly tick: number;
  enqueue(event: InputEvent): void;
  step(): unknown;
  snapshot(): S;
}

export interface RecorderOptions {
  worldId: WorldId;
  /** Stamped on every input; a function when it can change (after a `pack.loaded`). */
  packVersions: string | (() => string);
  /** Default 1,000. */
  snapshotEveryTicks?: number;
}

/**
 * Wraps a live world: every input is appended to the log before it is queued,
 * and snapshots are taken at tick 0 and every `snapshotEveryTicks`.
 */
export class Recorder<S, W extends Simulation<S>> {
  readonly world: W;
  private readonly log: InputLog;
  private readonly snapshots: SnapshotStore<S>;
  private readonly opts: Required<RecorderOptions>;

  constructor(world: W, log: InputLog, snapshots: SnapshotStore<S>, opts: RecorderOptions) {
    this.world = world;
    this.log = log;
    this.snapshots = snapshots;
    this.opts = { snapshotEveryTicks: 1_000, ...opts };
    if (!snapshots.nearest(opts.worldId, world.tick)) this.takeSnapshot();
  }

  private packVersions(): string {
    return typeof this.opts.packVersions === 'function' ? this.opts.packVersions() : this.opts.packVersions;
  }

  /** Stamp an input with the next seq and the current tick, log it, then queue it. */
  submit(type: string, payload: unknown, causedBy?: InputEvent['causedBy']): InputEvent {
    const event: InputEvent = {
      worldId: this.opts.worldId,
      seq: this.log.lastSeq(this.opts.worldId) + 1,
      tick: this.world.tick,
      type,
      payload,
      packVersions: this.packVersions(),
      ...(causedBy && { causedBy }),
    };
    this.log.append(event);
    this.world.enqueue(event);
    return event;
  }

  step(): ReturnType<W['step']> {
    const out = this.world.step() as ReturnType<W['step']>;
    if (this.world.tick % this.opts.snapshotEveryTicks === 0) this.takeSnapshot();
    return out;
  }

  takeSnapshot(): Snapshot<S> {
    const snap: Snapshot<S> = {
      worldId: this.opts.worldId,
      tick: this.world.tick,
      seq: this.log.lastSeq(this.opts.worldId),
      packVersions: this.packVersions(),
      state: this.world.snapshot(),
    };
    this.snapshots.put(snap);
    return snap;
  }
}

export interface ReplayOptions<S, W extends Simulation<S>> {
  worldId: WorldId;
  log: InputLog;
  snapshots: SnapshotStore<S>;
  /** Rebuild a world from a snapshot; should throw naming any missing content pack. */
  restore: (snapshot: Snapshot<S>) => W;
  /** Start from the nearest snapshot at or before this tick (default: `toTick`). */
  fromTick?: number;
  toTick: number;
  /** Called after each re-simulated tick. */
  onTick?: (world: W) => void;
}

/** Rebuild the world at `toTick` from a snapshot plus the input log. Never calls a model. */
export function replay<S, W extends Simulation<S>>(o: ReplayOptions<S, W>): W {
  const snap = o.snapshots.nearest(o.worldId, o.fromTick ?? o.toTick);
  if (!snap) throw new Error(`world ${o.worldId}: no snapshot at or before tick ${o.fromTick ?? o.toTick}`);
  const world = o.restore(snap);
  for (const e of o.log.read(o.worldId, { fromTick: snap.tick, toTick: o.toTick })) {
    world.enqueue(e);
  }
  while (world.tick < o.toTick) {
    world.step();
    o.onTick?.(world);
  }
  return world;
}

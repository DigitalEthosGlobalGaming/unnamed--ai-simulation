import type { Delta } from '@uas/core';
import { MindSystem } from '@uas/mind';
import { World, type WorldState } from '@uas/sim';
import { replay, type InputLog, type SnapshotStore } from '@uas/store';
import { loadPacks } from './catalog.ts';
import type { WorldFile } from './config.ts';

/**
 * A replay session: snapshot + input log, re-simulated with no model calls (answers are in
 * the log). Play steps at the world's tick rate; seek rebuilds from the nearest snapshot.
 */
export class ReplaySession {
  readonly id: string;
  world!: World;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly cfg: WorldFile;
  private readonly log: InputLog;
  private readonly snaps: SnapshotStore<WorldState>;
  private readonly onDeltas: (tick: number, changes: Delta[]) => void;
  private readonly onEnd: () => void;

  constructor(id: string, cfg: WorldFile, log: InputLog, snaps: SnapshotStore<WorldState>, onDeltas: (tick: number, changes: Delta[]) => void, onEnd: () => void) {
    this.id = id;
    this.cfg = cfg;
    this.log = log;
    this.snaps = snaps;
    this.onDeltas = onDeltas;
    this.onEnd = onEnd;
  }

  seek(tick: number): WorldState {
    this.pause();
    const { registry } = loadPacks(this.cfg.packs);
    const minds = new MindSystem();
    this.world = replay({
      worldId: this.cfg.id,
      log: this.log,
      snapshots: this.snaps,
      restore: (s) => World.fromSnapshot(s.state, registry, minds, { allowPackUpgrade: true }),
      toTick: tick,
      onTick: () => minds.drain(),
    });
    // Queue the rest of the log so playback applies recorded inputs at their ticks.
    for (const e of this.log.read(this.cfg.id, { fromTick: tick })) this.world.enqueue(e);
    this.minds = minds;
    return this.world.snapshot();
  }

  private minds: MindSystem | undefined;

  play(liveTick: () => number, speed = 1): void {
    this.pause();
    this.timer = setInterval(() => {
      if (this.world.tick >= liveTick()) {
        this.pause();
        this.onEnd();
        return;
      }
      const out = this.world.step();
      this.minds?.drain(); // replay never calls a model
      if (out.changes.length) this.onDeltas(out.tick, out.changes);
    }, 1000 / (this.cfg.ticksPerRealSecond * speed));
  }

  pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

import type { WorldId } from '@uas/core';

export interface Snapshot<S = unknown> {
  worldId: WorldId;
  /** The tick the world will process next; inputs stamped >= tick are not yet applied. */
  tick: number;
  /** Last input seq appended when the snapshot was taken. */
  seq: number;
  packVersions: string;
  state: S;
}

export interface SnapshotStore<S = unknown> {
  put(snapshot: Snapshot<S>): void;
  /** The latest snapshot at or before `tick`. */
  nearest(worldId: WorldId, tick: number): Snapshot<S> | undefined;
  list(worldId: WorldId): Snapshot<S>[];
}

/** In-memory store. Real stores add zstd compression and retention thinning. */
export class MemorySnapshotStore<S = unknown> implements SnapshotStore<S> {
  private readonly worlds = new Map<WorldId, Snapshot<S>[]>();

  put(snapshot: Snapshot<S>): void {
    const list = (this.worlds.get(snapshot.worldId) ?? []).filter((s) => s.tick !== snapshot.tick);
    list.push(structuredClone(snapshot));
    list.sort((a, b) => a.tick - b.tick);
    this.worlds.set(snapshot.worldId, list);
  }

  nearest(worldId: WorldId, tick: number): Snapshot<S> | undefined {
    const found = (this.worlds.get(worldId) ?? []).findLast((s) => s.tick <= tick);
    return found && structuredClone(found);
  }

  list(worldId: WorldId): Snapshot<S>[] {
    return structuredClone(this.worlds.get(worldId) ?? []);
  }
}

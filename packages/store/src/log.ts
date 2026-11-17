import type { InputEvent, WorldId } from '@uas/core';

/** Append-only input log: the source of truth for a world. */
export interface InputLog {
  /** Throws unless `event.seq` is exactly one past the world's last seq. */
  append(event: InputEvent): void;
  /** Events in seq order, optionally limited to ticks in [fromTick, toTick). */
  read(worldId: WorldId, range?: { fromTick?: number; toTick?: number }): InputEvent[];
  /** -1 when the world has no events. */
  lastSeq(worldId: WorldId): number;
}

export class MemoryInputLog implements InputLog {
  private readonly worlds = new Map<WorldId, InputEvent[]>();

  append(event: InputEvent): void {
    const events = this.worlds.get(event.worldId) ?? [];
    const expected = events.length === 0 ? 0 : events[events.length - 1]!.seq + 1;
    if (event.seq !== expected) throw new Error(`world ${event.worldId}: expected seq ${expected}, got ${event.seq}`);
    events.push(structuredClone(event));
    this.worlds.set(event.worldId, events);
  }

  read(worldId: WorldId, { fromTick = 0, toTick = Infinity } = {}): InputEvent[] {
    return (this.worlds.get(worldId) ?? [])
      .filter((e) => e.tick >= fromTick && e.tick < toTick)
      .map((e) => structuredClone(e));
  }

  lastSeq(worldId: WorldId): number {
    return this.worlds.get(worldId)?.at(-1)?.seq ?? -1;
  }
}

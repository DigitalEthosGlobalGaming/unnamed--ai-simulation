import Database from 'better-sqlite3';
import { and, asc, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Delta, FeedEntry, InputEvent, WorldId } from '@uas/core';
import type { InputLog } from './log.ts';
import type { Snapshot, SnapshotStore } from './snapshots.ts';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;
export type MailRow = typeof schema.mail.$inferSelect;

/** Open (and create) the SQLite database in WAL mode. Each worker opens its own connection. */
export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(schema.DDL);
  return drizzle(sqlite, { schema });
}

export class SqliteInputLog implements InputLog {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  append(e: InputEvent): void {
    const expected = this.lastSeq(e.worldId) + 1;
    if (e.seq !== expected) throw new Error(`world ${e.worldId}: expected seq ${expected}, got ${e.seq}`);
    this.db
      .insert(schema.inputEvents)
      .values({ worldId: e.worldId, seq: e.seq, tick: e.tick, type: e.type, payload: e.payload as object, packVersions: e.packVersions, causedBy: e.causedBy ?? null })
      .run();
  }

  read(worldId: WorldId, { fromTick = 0, toTick = Number.MAX_SAFE_INTEGER } = {}): InputEvent[] {
    return this.db
      .select()
      .from(schema.inputEvents)
      .where(and(eq(schema.inputEvents.worldId, worldId), gte(schema.inputEvents.tick, fromTick), lt(schema.inputEvents.tick, toTick)))
      .orderBy(asc(schema.inputEvents.seq))
      .all()
      .map(rowToEvent);
  }

  /** Every input of one type, oldest first (e.g. `prompts.activate` for the template history). */
  ofType(worldId: WorldId, type: string): InputEvent[] {
    return this.db
      .select()
      .from(schema.inputEvents)
      .where(and(eq(schema.inputEvents.worldId, worldId), eq(schema.inputEvents.type, type)))
      .orderBy(asc(schema.inputEvents.seq))
      .all()
      .map(rowToEvent);
  }

  page(worldId: WorldId, fromSeq: number, limit: number): InputEvent[] {
    return this.db
      .select()
      .from(schema.inputEvents)
      .where(and(eq(schema.inputEvents.worldId, worldId), gte(schema.inputEvents.seq, fromSeq)))
      .orderBy(asc(schema.inputEvents.seq))
      .limit(limit)
      .all()
      .map(rowToEvent);
  }

  lastSeq(worldId: WorldId): number {
    const row = this.db
      .select({ seq: sql<number | null>`max(${schema.inputEvents.seq})` })
      .from(schema.inputEvents)
      .where(eq(schema.inputEvents.worldId, worldId))
      .get();
    return row?.seq ?? -1;
  }
}

function rowToEvent(r: typeof schema.inputEvents.$inferSelect): InputEvent {
  return { worldId: r.worldId, seq: r.seq, tick: r.tick, type: r.type, payload: r.payload, packVersions: r.packVersions, ...(r.causedBy ? { causedBy: r.causedBy as InputEvent['causedBy'] } : {}) };
}

/** zstd-compressed snapshots. */
export class SqliteSnapshotStore<S = unknown> implements SnapshotStore<S> {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  put(s: Snapshot<S>): void {
    const data = zstdCompressSync(Buffer.from(JSON.stringify(s.state)));
    this.db
      .insert(schema.snapshots)
      .values({ worldId: s.worldId, tick: s.tick, seq: s.seq, packVersions: s.packVersions, data, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: [schema.snapshots.worldId, schema.snapshots.tick], set: { seq: s.seq, packVersions: s.packVersions, data } })
      .run();
  }

  nearest(worldId: WorldId, tick: number): Snapshot<S> | undefined {
    const r = this.db
      .select()
      .from(schema.snapshots)
      .where(and(eq(schema.snapshots.worldId, worldId), lte(schema.snapshots.tick, tick)))
      .orderBy(desc(schema.snapshots.tick))
      .limit(1)
      .get();
    return r && this.decode(r);
  }

  latest(worldId: WorldId): Snapshot<S> | undefined {
    return this.nearest(worldId, Number.MAX_SAFE_INTEGER);
  }

  list(worldId: WorldId): Snapshot<S>[] {
    return this.db.select().from(schema.snapshots).where(eq(schema.snapshots.worldId, worldId)).orderBy(asc(schema.snapshots.tick)).all().map((r) => this.decode(r));
  }

  private decode(r: typeof schema.snapshots.$inferSelect): Snapshot<S> {
    return { worldId: r.worldId, tick: r.tick, seq: r.seq, packVersions: r.packVersions, state: JSON.parse(zstdDecompressSync(r.data).toString()) as S };
  }
}

/** Read models derived from the delta stream: deltas per tick, brain feed and diary. */
export class SqliteReadModels {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  write(worldId: WorldId, tick: number, changes: readonly Delta[]): void {
    if (changes.length === 0) return;
    this.db.transaction((tx) => {
      tx.insert(schema.deltas).values({ worldId, tick, changes: changes as object[] }).onConflictDoNothing().run();
      for (const d of changes) {
        if (d.kind === 'feed') tx.insert(schema.feed).values({ worldId, tick, characterId: d.entry.characterId, entry: d.entry as object }).run();
        if (d.kind === 'feedStep') {
          // The newest entry of that character with that `entry.tick` whose step is still open.
          const rows = tx
            .select()
            .from(schema.feed)
            .where(and(eq(schema.feed.worldId, worldId), eq(schema.feed.characterId, d.characterId), gte(schema.feed.tick, d.feedTick), lte(schema.feed.tick, d.feedTick + 2), sql`json_extract(${schema.feed.entry}, '$.tick') = ${d.feedTick}`))
            .orderBy(desc(schema.feed.id))
            .all();
          const row = rows.find((r) => (r.entry as FeedEntry).actions[d.step]?.status === 'queued');
          if (row) {
            const entry = structuredClone(row.entry as FeedEntry);
            entry.actions[d.step] = { ...entry.actions[d.step]!, status: d.status, ...(d.result && { result: d.result }) };
            tx.update(schema.feed).set({ entry: entry as object }).where(eq(schema.feed.id, row.id)).run();
          }
        }
        if (d.kind === 'diary') tx.insert(schema.diary).values({ worldId, characterId: d.id, day: d.day, tick, text: d.text }).run();
        if (d.kind === 'mail' && d.status !== 'waiting') {
          tx.update(schema.mail)
            .set({ status: d.status, statusTick: tick, ...(d.readerId && { readerId: d.readerId }) })
            .where(and(eq(schema.mail.worldId, worldId), eq(schema.mail.mailId, d.mailId)))
            .run();
        }
      }
    });
  }

  deltas(worldId: WorldId, fromTick: number, toTick: number): { tick: number; changes: Delta[] }[] {
    return this.db
      .select()
      .from(schema.deltas)
      .where(and(eq(schema.deltas.worldId, worldId), gte(schema.deltas.tick, fromTick), lt(schema.deltas.tick, toTick)))
      .orderBy(asc(schema.deltas.tick))
      .all()
      .map((r) => ({ tick: r.tick, changes: r.changes as Delta[] }));
  }

  /**
   * One entity's `state` deltas, oldest first: `{ tick, set }` for each tick that changed it, from
   * `fromTick` (inclusive). With `before`, the newest changes before `fromTick` instead (newest first).
   */
  stateChanges(worldId: WorldId, id: string, fromTick: number, before = false, limit = 100_000): { tick: number; set: Record<string, unknown> }[] {
    const rows = this.db.all<{ tick: number; v: string }>(sql`
      SELECT d.tick AS tick, j.value AS v FROM deltas d, json_each(d.changes) j
      WHERE d.world_id = ${worldId} AND ${before ? sql`d.tick < ${fromTick}` : sql`d.tick >= ${fromTick}`}
        AND instr(d.changes, ${JSON.stringify(id)}) > 0
        AND json_extract(j.value, '$.kind') = 'state' AND json_extract(j.value, '$.id') = ${id}
      ORDER BY d.tick ${before ? sql`DESC` : sql`ASC`} LIMIT ${limit}`);
    return rows.map((r) => ({ tick: r.tick, set: (JSON.parse(r.v) as { set: Record<string, unknown> }).set }));
  }

  feed(worldId: WorldId, characterId: string | undefined, limit = 100, beforeTick = Number.MAX_SAFE_INTEGER): FeedEntry[] {
    const where = characterId
      ? and(eq(schema.feed.worldId, worldId), eq(schema.feed.characterId, characterId), lt(schema.feed.tick, beforeTick))
      : and(eq(schema.feed.worldId, worldId), lt(schema.feed.tick, beforeTick));
    return this.db.select().from(schema.feed).where(where).orderBy(desc(schema.feed.id)).limit(limit).all().map((r) => r.entry as FeedEntry).reverse();
  }

  /** The first feed entry for a character at or after `tick` (e.g. its reaction to a note). */
  feedAfter(worldId: WorldId, characterId: string, tick: number): FeedEntry | undefined {
    const r = this.db
      .select()
      .from(schema.feed)
      .where(and(eq(schema.feed.worldId, worldId), eq(schema.feed.characterId, characterId), gte(schema.feed.tick, tick)))
      .orderBy(asc(schema.feed.id))
      .limit(1)
      .get();
    return r?.entry as FeedEntry | undefined;
  }

  /** Record a posted message (its text stays here; the world log has it too). */
  addMail(row: MailRow): void {
    this.db.insert(schema.mail).values(row).onConflictDoNothing().run();
  }

  mail(worldId: WorldId, filter: { userKey?: string } = {}): MailRow[] {
    const where = filter.userKey ? and(eq(schema.mail.worldId, worldId), eq(schema.mail.userKey, filter.userKey)) : eq(schema.mail.worldId, worldId);
    return this.db.select().from(schema.mail).where(where).orderBy(asc(schema.mail.postedTick), asc(schema.mail.mailId)).all();
  }

  diary(worldId: WorldId, characterId: string, day: number): { tick: number; text: string }[] {
    return this.db
      .select({ tick: schema.diary.tick, text: schema.diary.text })
      .from(schema.diary)
      .where(and(eq(schema.diary.worldId, worldId), eq(schema.diary.characterId, characterId), eq(schema.diary.day, day)))
      .orderBy(asc(schema.diary.id))
      .all();
  }
}

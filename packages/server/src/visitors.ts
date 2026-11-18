import { CATALOG_SEED, migrateToSchema2, perceivedType, validateCatalogItem2, type InputEvent, type Json, type ObjectDef2, type Registry } from '@uas/core';
import type { WorldState } from '@uas/sim';
import { eq } from 'drizzle-orm';
import { schema, type Db, type MailRow } from '@uas/store';

/**
 * Visitors: the server-wide airdrop catalogue, world limits, and what non-admins may see.
 * The sim side (drops, use, expiry, the mailbox queue) is in `@uas/sim`; this is the host side.
 */

// ------------------------------------------------------------------ limits (world settings)

/** "Effectively unlimited" defaults; admins are never limited. */
export const UNLIMITED = 1_000_000;
export interface VisitorLimits {
  /** Item ids enabled in this world; `*` enables every catalogue item. */
  catalogEnabled: string[];
  airdropMaxActivePerVisitor: number;
  airdropCooldownSeconds: number;
  airdropWorldCap: number;
  /** In-world seconds before a drop without its own `expiresAfter` disappears; 0 = never. */
  airdropDefaultExpiry: number;
  mailCapacity: number;
  /** In-world seconds a message may wait unread; 0 = no limit. */
  mailExpirySeconds: number;
  mailMaxWaitingPerVisitor: number;
  mailCooldownSeconds: number;
}
export const DEFAULT_LIMITS: VisitorLimits = {
  catalogEnabled: ['*'],
  airdropMaxActivePerVisitor: UNLIMITED,
  airdropCooldownSeconds: 0,
  airdropWorldCap: UNLIMITED,
  airdropDefaultExpiry: 0,
  mailCapacity: UNLIMITED,
  mailExpirySeconds: 0,
  mailMaxWaitingPerVisitor: UNLIMITED,
  mailCooldownSeconds: 0,
};

/** A refusal the REST layer turns into an HTTP status. */
export interface Refusal {
  refused: true;
  status: 400 | 403 | 404 | 409 | 429;
  error: string;
}
export const refuse = (status: Refusal['status'], error: string): Refusal => ({ refused: true, status, error });
export const isRefusal = (v: unknown): v is Refusal => !!v && typeof v === 'object' && (v as Refusal).refused === true;

// ------------------------------------------------------------------ views (the REST contract)

export interface Airdrop {
  id: string;
  entityId: string;
  itemId: string;
  item: ObjectDef2;
  pos: { x: number; y: number };
  droppedBy: { username: string; admin: boolean };
  droppedTick: number;
  expiresTick?: number;
  usesLeft?: number;
}
export interface MailStatus {
  id: string;
  status: 'waiting' | 'read' | 'expired' | 'deleted';
  position?: number;
  text?: string;
  from: { username: string; admin: boolean };
  postedTick: number;
  readTick?: number;
  reaction?: { feedTick: number; summary: string; notes?: string[] };
}

export function airdropView(e: { id: string; pos: { x: number; y: number }; state: Record<string, Json> }): Airdrop {
  const s = e.state;
  const by = s.droppedBy as { username: string; admin: boolean };
  return {
    id: String(s.dropId),
    entityId: e.id,
    itemId: String(s.itemId),
    item: migrateToSchema2(s.item as Record<string, unknown>) as unknown as ObjectDef2,
    pos: { x: e.pos.x, y: e.pos.y },
    droppedBy: { username: by.username, admin: by.admin },
    droppedTick: Number(s.droppedTick),
    ...(typeof s.expiresTick === 'number' && { expiresTick: s.expiresTick }),
    ...(typeof s.usesLeft === 'number' ? { usesLeft: s.usesLeft } : typeof s.uses === 'number' && { usesLeft: s.uses }),
  };
}

/** Beliefs any character holds about a thing that looks like this drop (beliefs are by perceived type). */
export function beliefsAbout(state: WorldState, e: { type: string; tags: string[] }): { characterId: string; text: string; firmness: number }[] {
  const type = perceivedType(e);
  const out: { characterId: string; text: string; firmness: number }[] = [];
  for (const c of Object.values(state.entities)) {
    if (c.kind !== 'character' || !c.mind) continue;
    for (const b of c.mind.beliefs) if (b.key.split('@')[0]!.split(':')[1] === type) out.push({ characterId: c.id, text: b.text, firmness: b.firmness });
  }
  return out;
}

export function mailStatus(row: MailRow, opts: { position?: number; showText: boolean; reaction?: MailStatus['reaction'] }): MailStatus {
  const status = row.status as MailStatus['status'];
  return {
    id: row.mailId,
    status,
    ...(opts.position !== undefined && { position: opts.position }),
    ...((opts.showText || status === 'read') && { text: row.text }),
    from: { username: row.username, admin: row.admin },
    postedTick: row.postedTick,
    ...(status === 'read' && row.statusTick !== null && { readTick: row.statusTick }),
    ...(opts.reaction && { reaction: opts.reaction }),
  };
}

// ------------------------------------------------------------------ privacy

/** Waiting mail text is for the sender and admins only: strip it from world state for everyone else. */
export function redactState(state: WorldState, admin: boolean): WorldState {
  if (admin || !state.mailbox?.queue.length) return state;
  return { ...state, mailbox: { queue: state.mailbox.queue.map((m) => ({ ...m, text: '' })) } };
}

/** The same for the input log: `mail.post` text is admin-only there (read notes reach everyone through the robot). */
export function redactEvent(e: InputEvent, admin: boolean): InputEvent {
  if (admin || e.type !== 'mail.post') return e;
  const { text: _text, ...payload } = e.payload as { text: string };
  return { ...e, payload };
}

// ------------------------------------------------------------------ the catalogue (server-wide, SQLite)

export interface CatalogRow {
  /** Schema 2 (stored schema-1 items are migrated on read). */
  item: ObjectDef2;
  disabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export class Catalog {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    this.seed();
  }

  /** First run only: the seed items (a flag remembers it, so deleting them all doesn't bring them back). */
  private seed(): void {
    if (this.db.select().from(schema.serverMeta).where(eq(schema.serverMeta.key, 'catalogSeeded')).get()) return;
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const item of CATALOG_SEED) tx.insert(schema.catalogItems).values({ id: item.id, item, disabled: false, updatedAt: now, updatedBy: 'seed' }).onConflictDoNothing().run();
      tx.insert(schema.serverMeta).values({ key: 'catalogSeeded', value: now }).onConflictDoNothing().run();
    });
  }

  list(): CatalogRow[] {
    return this.db
      .select()
      .from(schema.catalogItems)
      .all()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((r) => ({ item: migrateToSchema2(r.item as Record<string, unknown>) as unknown as ObjectDef2, disabled: r.disabled, updatedAt: r.updatedAt, updatedBy: r.updatedBy }));
  }

  get(id: string): CatalogRow | undefined {
    return this.list().find((r) => r.item.id === id);
  }

  put(item: ObjectDef2, disabled: boolean, by: string | undefined): CatalogRow {
    const row = { id: item.id, item, disabled, updatedAt: new Date().toISOString(), updatedBy: by ?? null };
    this.db.insert(schema.catalogItems).values(row).onConflictDoUpdate({ target: schema.catalogItems.id, set: { item, disabled, updatedAt: row.updatedAt, updatedBy: row.updatedBy } }).run();
    return { item, disabled, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  }

  delete(id: string): boolean {
    return this.db.delete(schema.catalogItems).where(eq(schema.catalogItems.id, id)).run().changes > 0;
  }
}

/** Need keys, noise names and object types an item may use, from the loaded packs (archetype needs; never energy). */
export function itemRules(registry: Registry): { needKeys: string[]; noiseNames: string[]; packTypes: string[]; knownTypes: string[] } {
  const needs = new Set<string>(); // never `energy`: items can't change the battery
  const noises = new Set<string>();
  for (const a of registry.archetypes.values()) {
    for (const n of Object.keys(a.needs)) needs.add(n);
    for (const n of Object.keys(a.noises?.set ?? {})) noises.add(n);
  }
  const types = [...registry.objects.keys()].sort();
  return { needKeys: [...needs].sort(), noiseNames: [...noises].sort(), packTypes: types, knownTypes: types };
}

export { validateCatalogItem2 };

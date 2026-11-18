import { blob, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const worlds = sqliteTable('worlds', {
  id: text('id').primaryKey(),
  config: text('config', { mode: 'json' }).notNull(),
  parentWorldId: text('parent_world_id'),
  forkTick: integer('fork_tick'),
  createdAt: text('created_at').notNull(),
});

export const inputEvents = sqliteTable(
  'input_events',
  {
    worldId: text('world_id').notNull(),
    seq: integer('seq').notNull(),
    tick: integer('tick').notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    packVersions: text('pack_versions').notNull(),
    causedBy: text('caused_by', { mode: 'json' }),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.seq] })],
);

export const snapshots = sqliteTable(
  'snapshots',
  {
    worldId: text('world_id').notNull(),
    tick: integer('tick').notNull(),
    seq: integer('seq').notNull(),
    packVersions: text('pack_versions').notNull(),
    /** zstd-compressed JSON. */
    data: blob('data', { mode: 'buffer' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.tick] })],
);

export const deltas = sqliteTable(
  'deltas',
  {
    worldId: text('world_id').notNull(),
    tick: integer('tick').notNull(),
    changes: text('changes', { mode: 'json' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.tick] })],
);

export const feed = sqliteTable('feed', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worldId: text('world_id').notNull(),
  tick: integer('tick').notNull(),
  characterId: text('character_id').notNull(),
  entry: text('entry', { mode: 'json' }).notNull(),
});

export const diary = sqliteTable('diary', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worldId: text('world_id').notNull(),
  characterId: text('character_id').notNull(),
  day: integer('day').notNull(),
  tick: integer('tick').notNull(),
  text: text('text').notNull(),
});

export const packs = sqliteTable('packs', {
  name: text('name').notNull(),
  version: text('version').notNull(),
  contentHash: text('content_hash').primaryKey(),
  licence: text('licence').notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  keyHash: text('key_hash').primaryKey(),
  role: text('role').notNull(),
  worldId: text('world_id'),
});

export const usageDaily = sqliteTable(
  'usage_daily',
  {
    worldId: text('world_id').notNull(),
    day: text('day').notNull(),
    modelId: text('model_id').notNull(),
    job: text('job').notNull(),
    calls: integer('calls').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costAud: real('cost_aud').notNull(),
    energy: real('energy').notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.day, t.modelId, t.job] })],
);

/** Signed-in users (Sign in with Vercel). The cookie carries only the signed session id. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  username: text('username'),
  name: text('name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  role: text('role').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

/** The server-wide airdrop catalogue (admin-edited; worlds copy an item's JSON when it is dropped). */
export const catalogItems = sqliteTable('catalog_items', {
  id: text('id').primaryKey(),
  item: text('item', { mode: 'json' }).notNull(),
  disabled: integer('disabled', { mode: 'boolean' }).notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by'),
});

/** Mailbox messages per world, for statuses (the queue itself lives in world state). Text is private while waiting. */
export const mail = sqliteTable(
  'mail',
  {
    worldId: text('world_id').notNull(),
    mailId: text('mail_id').notNull(),
    text: text('text').notNull(),
    username: text('username').notNull(),
    admin: integer('admin', { mode: 'boolean' }).notNull(),
    userKey: text('user_key').notNull(),
    postedTick: integer('posted_tick').notNull(),
    postedAt: text('posted_at').notNull(),
    status: text('status').notNull(),
    statusTick: integer('status_tick'),
    readerId: text('reader_id'),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.mailId] })],
);

/** Prompt template versions (server-wide, immutable; docs/architecture/prompts.md). */
export const promptVersions = sqliteTable(
  'prompt_versions',
  {
    templateId: text('template_id').notNull(),
    version: integer('version').notNull(),
    body: text('body', { mode: 'json' }).notNull(),
    note: text('note').notNull(),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').notNull(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.version] })],
);

/** Server-wide flags, e.g. that the catalogue was seeded once. */
export const serverMeta = sqliteTable('server_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** Bootstrap DDL, kept next to the Drizzle schema it mirrors. */
export const DDL = `
CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, config TEXT NOT NULL, parent_world_id TEXT, fork_tick INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS input_events (world_id TEXT NOT NULL, seq INTEGER NOT NULL, tick INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, pack_versions TEXT NOT NULL, caused_by TEXT, PRIMARY KEY (world_id, seq));
CREATE INDEX IF NOT EXISTS input_events_tick ON input_events (world_id, tick);
CREATE TABLE IF NOT EXISTS snapshots (world_id TEXT NOT NULL, tick INTEGER NOT NULL, seq INTEGER NOT NULL, pack_versions TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (world_id, tick));
CREATE TABLE IF NOT EXISTS deltas (world_id TEXT NOT NULL, tick INTEGER NOT NULL, changes TEXT NOT NULL, PRIMARY KEY (world_id, tick));
CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY AUTOINCREMENT, world_id TEXT NOT NULL, tick INTEGER NOT NULL, character_id TEXT NOT NULL, entry TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS feed_world ON feed (world_id, character_id, tick);
CREATE TABLE IF NOT EXISTS diary (id INTEGER PRIMARY KEY AUTOINCREMENT, world_id TEXT NOT NULL, character_id TEXT NOT NULL, day INTEGER NOT NULL, tick INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS diary_world ON diary (world_id, character_id, day);
CREATE TABLE IF NOT EXISTS packs (name TEXT NOT NULL, version TEXT NOT NULL, content_hash TEXT PRIMARY KEY, licence TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT, name TEXT, email TEXT, avatar_url TEXT, role TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, role TEXT NOT NULL, world_id TEXT);
CREATE TABLE IF NOT EXISTS catalog_items (id TEXT PRIMARY KEY, item TEXT NOT NULL, disabled INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS mail (world_id TEXT NOT NULL, mail_id TEXT NOT NULL, text TEXT NOT NULL, username TEXT NOT NULL, admin INTEGER NOT NULL, user_key TEXT NOT NULL, posted_tick INTEGER NOT NULL, posted_at TEXT NOT NULL, status TEXT NOT NULL, status_tick INTEGER, reader_id TEXT, PRIMARY KEY (world_id, mail_id));
CREATE TABLE IF NOT EXISTS prompt_versions (template_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, PRIMARY KEY (template_id, version));
CREATE TABLE IF NOT EXISTS server_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_daily (world_id TEXT NOT NULL, day TEXT NOT NULL, model_id TEXT NOT NULL, job TEXT NOT NULL, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_aud REAL NOT NULL, energy REAL NOT NULL, PRIMARY KEY (world_id, day, model_id, job));
`;

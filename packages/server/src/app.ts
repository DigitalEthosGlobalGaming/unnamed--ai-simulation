import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { CATALOG_TEMPLATES, type CatalogItem, type EntityDef, type InputEvent, type Pos, type Sender } from '@uas/core';
import { MindSystem } from '@uas/mind';
import { World, type WorldState } from '@uas/sim';
import { SqliteInputLog, SqliteReadModels, SqliteSnapshotStore, openDb, replay } from '@uas/store';
import { KeyRing, allows, type Principal, type Role } from './auth.ts';
import { listPacks, loadPacks } from './catalog.ts';
import { parseWorldFile, type WorldFile } from './config.ts';
import { Hub } from './hub.ts';
import { VercelAuth, type AuthEnv } from './session.ts';
import type { WorldStatus } from './runtime.ts';
import { Supervisor, type WorldHandle } from './supervisor.ts';
import { Catalog, isRefusal, itemRules, redactEvent, redactState, validateCatalogItem } from './visitors.ts';

export interface AppOptions {
  dbPath: string;
  keys: KeyRing;
  /** Sign in with Vercel settings (client id/secret, session secret, public URL, admin users). */
  authEnv?: AuthEnv;
  /** For tests: the fetch used to talk to Vercel's OAuth endpoints. */
  authFetch?: typeof fetch;
  log?: (m: string) => void;
}

export interface App {
  server: Server;
  supervisor: Supervisor;
  hub: Hub;
  startWorld(config: WorldFile, extra?: { initialState?: WorldState; parent?: { worldId: string; forkTick: number } }): Promise<WorldHandle>;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Express REST + WebSocket hub over a supervisor of world workers. */
export function createApp(opts: AppOptions): App {
  const log = opts.log ?? console.log;
  const supervisor = new Supervisor(opts.dbPath, log);
  const db = openDb(opts.dbPath);
  const inputLog = new SqliteInputLog(db);
  const snaps = new SqliteSnapshotStore<WorldState>(db);
  const reads = new SqliteReadModels(db);
  const auth = new VercelAuth(db, opts.authEnv ?? {}, opts.authFetch);
  const hub = new Hub(supervisor, inputLog, snaps, opts.keys, (cookie) => auth.principalFor(cookie));
  const catalog = new Catalog(db);

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => {
    const header = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.get('x-api-key');
    const p = opts.keys.identify(header);
    if (p === null) return next(new HttpError(401, 'unknown API key'));
    // No API key: a Sign in with Vercel session cookie, if any.
    const session = p ? undefined : auth.principalFor(req.get('cookie'));
    // CSRF: cookie-authenticated mutations must come from our own origin (SameSite=Lax as well).
    if (session && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !auth.sameOrigin(req)) {
      return next(new HttpError(403, 'cross-site request refused'));
    }
    (req as Request & { principal?: Principal }).principal = p ?? session;
    next();
  });
  // An API key answers /auth/me too (no user, the key's role), so a key-authenticated viewer knows what it may do.
  app.get('/auth/me', (req, res, next) => {
    const p = (req as Request & { principal?: Principal & { viaCookie?: true } }).principal;
    if (p && !p.viaCookie) return void res.json({ user: null, role: p.role, loginAvailable: auth.loginAvailable });
    next();
  });
  auth.routes(app);

  const principal = (req: Request) => (req as Request & { principal?: Principal }).principal;
  const world = (req: Request): WorldHandle => {
    const w = supervisor.get(String(req.params.id));
    if (!w) throw new HttpError(404, `no world ${req.params.id}`);
    return w;
  };
  const need = (role: Role) => (req: Request, _res: Response, next: NextFunction) => {
    const w = req.params.id ? supervisor.get(String(req.params.id)) : undefined;
    if (!allows(principal(req), role, w?.config.publicRead ?? true)) return next(new HttpError(principal(req) ? 403 : 401, `needs ${role}`));
    next();
  };
  const submit = (w: WorldHandle, type: string, payload: unknown, causedBy?: InputEvent['causedBy']) =>
    w.call<InputEvent>({ method: 'submit', type, payload, ...(causedBy && { causedBy }) });
  const route = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };
  const isAdmin = (req: Request) => principal(req)?.role === 'admin';
  /** Who a visitor action is from: public username, admin flag, and the key that limits apply to. */
  const sender = (req: Request): Sender => {
    const p = principal(req)!;
    const userKey = p.keyId ?? 'anonymous';
    return { username: p.username ?? (p.role === 'admin' ? 'admin' : `visitor-${userKey.slice(0, 6)}`), admin: p.role === 'admin', userKey };
  };
  /** Worker results that are refusals become HTTP errors. */
  const settle = <T>(v: T) => {
    if (isRefusal(v)) throw new HttpError(v.status, v.error);
    return v;
  };
  /** Need keys and noises an item may use: from every pack the server knows (validation is server-wide). */
  const rules = () => itemRules(loadPacks(listPacks().map((p) => p.name)).registry);
  const summary = (w: WorldHandle) => ({ id: w.config.id, name: w.config.name, packs: w.config.packs, map: w.config.map, publicRead: w.config.publicRead, status: w.status });

  async function startWorld(config: WorldFile, extra: { initialState?: WorldState; parent?: { worldId: string; forkTick: number } } = {}) {
    const h = await supervisor.start({ config, ...extra });
    hub.attach(config.id);
    return h;
  }

  // ---- health and metrics
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, worlds: [...supervisor.worlds.keys()] });
  });
  app.get('/metrics', (_req, res) => {
    const lines: string[] = [];
    const metric = (name: string, help: string, get: (s: WorldStatus) => number) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const w of supervisor.worlds.values()) if (w.status) lines.push(`${name}{world="${w.config.id}"} ${get(w.status)}`);
    };
    metric('uas_tick', 'Current tick', (s) => s.tick);
    metric('uas_tick_lag_ms', 'How far the tick loop runs behind schedule', (s) => s.tickLagMs);
    metric('uas_model_latency_ms', 'Mean latency of recent model answers', (s) => s.modelLatencyMs);
    metric('uas_cost_aud_today', 'Model spend today in AUD', (s) => s.costAudToday);
    metric('uas_cost_aud_per_hour', 'Average model spend per real hour today, AUD', (s) => s.costAudToday / Math.max(1 / 60, new Date().getUTCHours() + new Date().getUTCMinutes() / 60));
    metric('uas_pending_jobs', 'Model jobs waiting or running', (s) => s.pendingJobs);
    metric('uas_model_queue_depth', 'Model jobs waiting in the queue', (s) => s.queue.waiting);
    metric('uas_model_queue_wait_p50_ms', 'Median time jobs waited in the model queue', (s) => s.queue.waitMs.p50);
    metric('uas_model_queue_wait_p95_ms', '95th percentile model queue wait', (s) => s.queue.waitMs.p95);
    metric('uas_model_run_p50_ms', 'Median model call run time', (s) => s.queue.runMs.p50);
    metric('uas_model_run_p95_ms', '95th percentile model call run time', (s) => s.queue.runMs.p95);
    metric('uas_model_jobs_completed', 'Model jobs answered', (s) => s.queue.completed);
    metric('uas_model_jobs_dropped_stale', 'Jobs dropped as queued too long', (s) => s.queue.dropped.stale);
    metric('uas_model_jobs_dropped_superseded', 'Queued decisions replaced by newer ones', (s) => s.queue.dropped.superseded);
    metric('uas_model_jobs_failed', 'Jobs no model answered', (s) => s.queue.dropped.failed);
    metric('uas_model_timeouts', 'Model calls that hit their timeout (from start)', (s) => s.queue.timeouts);
    metric('uas_mail_waiting', 'Messages waiting in the mailbox', (s) => s.mailWaiting);
    res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });

  // ---- worlds
  app.get('/worlds', need('spectator'), route(() => [...supervisor.worlds.values()].map(summary)));
  app.post('/worlds', need('admin'), route(async (req) => summary(await startWorld(parseWorldFile(req.body)))));
  app.get('/worlds/:id', need('spectator'), route((req) => summary(world(req))));
  app.get('/worlds/:id/settings', need('spectator'), route((req) => world(req).call({ method: 'settings' })));
  app.patch('/worlds/:id/settings', need('admin'), route((req) => world(req).call({ method: 'setSettings', patch: req.body, ...(principal(req)?.keyId && { userId: principal(req)!.keyId }) })));
  app.patch('/worlds/:id/clock', need('admin'), route((req) => world(req).call({ method: 'clock', ...(req.body as { paused?: boolean; timeScale?: number; realign?: boolean }) })));

  // ---- entities (admin edits are logged input events)
  app.post('/worlds/:id/entities', need('admin'), route((req) => submit(world(req), 'admin.spawn', req.body as EntityDef, { userId: principal(req)?.keyId })));
  app.patch('/worlds/:id/entities/:eid', need('admin'), route((req) => submit(world(req), 'admin.edit', { ...req.body, id: req.params.eid }, { userId: principal(req)?.keyId })));
  app.delete('/worlds/:id/entities/:eid', need('admin'), route((req) => submit(world(req), 'admin.despawn', { id: req.params.eid }, { userId: principal(req)?.keyId })));

  // ---- display catalog: what a frontend needs to draw and label this world, from its packs and config
  app.get('/worlds/:id/catalog', need('spectator'), route((req) => {
    const w = world(req);
    const { packs, registry } = loadPacks(w.config.packs);
    const models = w.config.models as { dailyCapAud?: number; energyFloor?: number; energyPerAud?: number };
    return {
      worldId: w.config.id,
      name: w.config.name,
      packs: packs.map((p) => `${p.manifest.name}@${p.manifest.version}`),
      ticksPerRealSecond: w.config.ticksPerRealSecond,
      /** @deprecated alias of ticksPerRealSecond */
      ticksPerSecond: w.config.ticksPerRealSecond,
      secondsPerTick: w.status?.secondsPerTick ?? w.config.sim.secondsPerTick ?? null,
      dailyCapAud: models.dailyCapAud ?? null,
      energyFloor: models.energyFloor ?? null,
      energyPerAud: models.energyPerAud ?? null,
      models: modelInfo(w.config.models),
      objects: [...registry.objects.values()].map((o) => ({ type: o.type, tags: o.tags, portable: o.portable, solid: o.solid, verbs: Object.keys(o.verbs) })),
      archetypes: [...registry.archetypes.values()].map((a) => ({
        type: a.type,
        tags: a.tags,
        needs: a.needs,
        energy: a.energy,
        noises: a.noises ?? null,
        sightRange: a.sightRange,
        hearingRange: a.hearingRange,
      })),
    };
  }));

  // ---- characters
  const found = <T>(v: T | null) => {
    if (v === null) throw new HttpError(404, 'no such character');
    return v;
  };
  app.get('/worlds/:id/characters/:cid/mind', need('spectator'), route(async (req) => found(await world(req).call({ method: 'mind', characterId: String(req.params.cid) }))));
  app.get('/worlds/:id/characters/:cid/memories', need('spectator'), route(async (req) => found(await world(req).call({ method: 'memories', characterId: String(req.params.cid) }))));
  app.get('/worlds/:id/characters/:cid/diary', need('spectator'), route((req) => {
    const day = Number(req.query.day ?? world(req).status?.day ?? 0);
    return { day, entries: reads.diary(world(req).config.id, String(req.params.cid), day) };
  }));
  app.post('/worlds/:id/characters/:cid/poke', need('admin'), route((req) => submit(world(req), 'admin.poke', { characterId: req.params.cid }, { userId: principal(req)?.keyId })));

  // ---- log, feed, replay, fork
  app.get('/worlds/:id/events', need('spectator'), route((req) => {
    const page = inputLog.page(world(req).config.id, Number(req.query.fromSeq ?? 0), Math.min(1000, Number(req.query.limit ?? 100)));
    const admin = isAdmin(req);
    return page.map((e) => redactEvent(e, admin));
  }));
  app.get('/worlds/:id/feed', need('spectator'), route((req) =>
    // Newest `limit` entries (oldest first); `beforeTick` pages back through older history.
    reads.feed(world(req).config.id, req.query.characterId ? String(req.query.characterId) : undefined, Math.min(500, Number(req.query.limit ?? 100)), req.query.beforeTick !== undefined && Number.isFinite(Number(req.query.beforeTick)) ? Number(req.query.beforeTick) : undefined),
  ));
  app.get('/worlds/:id/deltas', need('spectator'), route((req) => {
    const rows = reads.deltas(world(req).config.id, Number(req.query.fromTick ?? 0), Number(req.query.toTick ?? Number.MAX_SAFE_INTEGER));
    // `kinds=beliefs,sleep` keeps only those delta kinds (e.g. a viewer's belief markers on the timeline).
    if (!req.query.kinds) return rows;
    const kinds = new Set(String(req.query.kinds).split(','));
    return rows.map((r) => ({ tick: r.tick, changes: r.changes.filter((c) => kinds.has(c.kind)) })).filter((r) => r.changes.length);
  }));
  app.post('/worlds/:id/seek', need('spectator'), route((req) => {
    const { id, state } = hub.openSession(world(req).config.id, Number((req.body as { tick: number }).tick));
    return { sessionId: id, tick: state.tick, state: redactState(state, isAdmin(req)) };
  }));
  app.post('/worlds/:id/fork', need('admin'), route(async (req) => {
    const parent = world(req);
    const body = req.body as { tick: number; id?: string; config?: Partial<WorldFile> };
    const { registry } = loadPacks(parent.config.packs);
    const minds = new MindSystem();
    const at = replay({
      worldId: parent.config.id,
      log: inputLog,
      snapshots: snaps,
      restore: (s) => World.fromSnapshot(s.state, registry, minds, { allowPackUpgrade: true }),
      toTick: Number(body.tick),
      onTick: () => minds.drain(),
    });
    const id = body.id ?? `${parent.config.id}-fork-${body.tick}`;
    const config = parseWorldFile({ ...parent.config, ...body.config, id, entities: [] });
    return summary(await startWorld(config, { initialState: at.snapshot(), parent: { worldId: parent.config.id, forkTick: Number(body.tick) } }));
  }));

  // ---- the airdrop catalogue (server-wide)
  app.get('/catalog', need('spectator'), route((req) => {
    const rows = catalog.list();
    if (isAdmin(req)) return rows.map((r) => ({ ...r.item, disabled: r.disabled, updatedAt: r.updatedAt, updatedBy: r.updatedBy }));
    return rows.filter((r) => !r.disabled).map((r) => r.item);
  }));
  app.get('/catalog/templates', need('admin'), route(() => CATALOG_TEMPLATES));
  app.post('/catalog/validate', need('admin'), route((req) => validateCatalogItem((req.body as { item?: unknown })?.item, rules())));
  app.put('/catalog/:itemId', need('admin'), route((req) => {
    const body = (req.body ?? {}) as { item?: unknown; disabled?: unknown };
    const r = validateCatalogItem(body.item, rules());
    if (!r.ok) throw Object.assign(new HttpError(400, `invalid item: ${r.errors.map((e) => `${e.path || 'item'}: ${e.message}`).join('; ')}`), { errors: r.errors });
    if (r.item.id !== req.params.itemId) throw new HttpError(400, `item id ${r.item.id} does not match the URL (${req.params.itemId})`);
    const row = catalog.put(r.item, body.disabled === true, sender(req).username);
    return { ...row.item, disabled: row.disabled, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  }));
  app.delete('/catalog/:itemId', need('admin'), route((req) => {
    if (!catalog.delete(String(req.params.itemId))) throw new HttpError(404, `no catalogue item ${req.params.itemId}`);
    return { ok: true };
  }));

  // ---- airdrops
  app.get('/worlds/:id/airdrops', need('spectator'), route((req) => world(req).call({ method: 'airdrops' })));
  app.get('/worlds/:id/airdrops/:dropId', need('spectator'), route(async (req) => settle(await world(req).call({ method: 'airdrop', dropId: String(req.params.dropId) }))));
  app.post('/worlds/:id/airdrops', need('visitor'), route(async (req) => {
    const w = world(req);
    const body = (req.body ?? {}) as { itemId?: unknown; pos?: Pos };
    const row = typeof body.itemId === 'string' ? catalog.get(body.itemId) : undefined;
    if (!row || (row.disabled && !isAdmin(req))) throw new HttpError(404, `no catalogue item ${String(body.itemId)}`);
    if (!body.pos || typeof body.pos.x !== 'number' || typeof body.pos.y !== 'number') throw new HttpError(400, 'pos must be { x, y }');
    return settle(await w.call({ method: 'drop', item: row.item as CatalogItem, pos: { x: body.pos.x, y: body.pos.y }, by: sender(req) }));
  }));
  app.delete('/worlds/:id/airdrops/:dropId', need('admin'), route(async (req) =>
    settle(await world(req).call({ method: 'removeAirdrop', dropId: String(req.params.dropId), ...(principal(req)?.keyId && { userId: principal(req)!.keyId }) })),
  ));

  // ---- the mailbox
  app.get('/worlds/:id/mail', need('spectator'), route((req) => {
    const p = principal(req);
    return world(req).call({ method: 'mail', admin: p?.role === 'admin', ...(p && p.role !== 'spectator' && p.keyId && { userKey: p.keyId }) });
  }));
  app.post('/worlds/:id/mail', need('visitor'), route(async (req) => settle(await world(req).call({ method: 'postMail', text: (req.body as { text?: unknown })?.text, by: sender(req) }))));
  app.delete('/worlds/:id/mail/:mailId', need('admin'), route(async (req) =>
    settle(await world(req).call({ method: 'removeMail', mailId: String(req.params.mailId), ...(principal(req)?.keyId && { userId: principal(req)!.keyId }) })),
  ));

  // ---- packs and usage
  app.get('/packs', need('admin'), route(() => listPacks()));
  app.post('/packs', need('admin'), route(() => {
    throw new HttpError(501, 'installing packs at runtime is not implemented; add the npm package and register it in catalog.ts');
  }));
  app.get('/packs/:name/sounds/:file', (_req, res) => {
    res.status(404).json({ error: 'this pack has no recorded sounds (robot noises are synthesised)' });
  });
  app.get('/usage', need('admin'), route(async (req) => {
    const ids = req.query.worldId ? [String(req.query.worldId)] : [...supervisor.worlds.keys()];
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const w = supervisor.get(id);
      if (w) out[id] = await w.call({ method: 'usage', ...(req.query.day && { day: String(req.query.day) }) });
    }
    return out;
  }));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 400;
    const errors = (err as { errors?: unknown }).errors;
    res.status(status).json({ error: err.message, ...(errors !== undefined && { errors }) });
  });

  const server = createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) return socket.destroy();
    hub.wss.handleUpgrade(req, socket, head, (ws) => hub.wss.emit('connection', ws, req));
  });

  return {
    server,
    supervisor,
    hub,
    startWorld,
    async close() {
      hub.close();
      await supervisor.stopAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** The world's model entries for display (alias, adapter, real model, provider); never keys. */
function modelInfo(cfg: unknown): { id: string; adapter: string; model?: string; provider?: string; local: boolean }[] {
  const models = ((cfg as { models?: Record<string, { adapter?: string; model?: string; providerOrder?: string[] }> }).models ?? {}) as Record<
    string,
    { adapter?: string; model?: string; providerOrder?: string[] }
  >;
  const LOCAL = new Set(['local', 'ollama-decision', 'fake-decision', 'fake-chat']);
  return Object.entries(models)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, m]) => {
      const adapter = String(m.adapter ?? 'unknown');
      const local = LOCAL.has(adapter);
      const provider = local ? (adapter.startsWith('fake') ? 'offline' : 'ollama') : m.model?.includes('/') ? m.model.split('/')[0] : undefined;
      return { id, adapter, ...(m.model && { model: m.model }), ...(provider && { provider }), local };
    });
}

import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Action, EntityDef, InputEvent } from '@uas/core';
import { MindSystem } from '@uas/mind';
import { World, type WorldState } from '@uas/sim';
import { SqliteInputLog, SqliteReadModels, SqliteSnapshotStore, openDb, replay } from '@uas/store';
import { KeyRing, allows, type Principal, type Role } from './auth.ts';
import { listPacks, loadPacks } from './catalog.ts';
import { parseWorldFile, type WorldFile } from './config.ts';
import { Hub } from './hub.ts';
import type { WorldStatus } from './runtime.ts';
import { Supervisor, type WorldHandle } from './supervisor.ts';

export interface AppOptions {
  dbPath: string;
  keys: KeyRing;
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
  const hub = new Hub(supervisor, inputLog, snaps, opts.keys);
  /** visitor key → visitor entity, per world: one visitor per key per world. */
  const visitors = new Map<string, string>();

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => {
    const header = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.get('x-api-key');
    const p = opts.keys.identify(header);
    if (p === null) return next(new HttpError(401, 'unknown API key'));
    (req as Request & { principal?: Principal }).principal = p;
    next();
  });

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
    metric('uas_visitor_queue_depth', 'Visitor requests waiting across characters', (s) => s.visitorQueueDepth);
    res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });

  // ---- worlds
  app.get('/worlds', need('spectator'), route(() => [...supervisor.worlds.values()].map(summary)));
  app.post('/worlds', need('admin'), route(async (req) => summary(await startWorld(parseWorldFile(req.body)))));
  app.get('/worlds/:id', need('spectator'), route((req) => summary(world(req))));
  app.patch('/worlds/:id/clock', need('admin'), route((req) => world(req).call({ method: 'clock', ...(req.body as { paused?: boolean; timeScale?: number }) })));

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

  // ---- visitors
  app.post('/worlds/:id/visitors', need('visitor'), route(async (req) => {
    const w = world(req);
    const p = principal(req)!;
    const key = `${w.config.id}|${p.keyId}`;
    const existing = visitors.get(key);
    if (existing) return { visitorId: existing };
    const visitorId = `visitor-${p.keyId!.slice(0, 8)}`;
    const pos = (req.body as { pos?: { x: number; y: number } })?.pos ?? { x: 0, y: 0 };
    await submit(w, 'admin.spawn', { id: visitorId, type: w.config.visitorArchetype, pos, state: { visitor: true } }, { userId: p.keyId });
    visitors.set(key, visitorId);
    return { visitorId };
  }));
  app.post('/worlds/:id/visitors/:vid/actions', need('visitor'), route((req) => {
    const w = world(req);
    const p = principal(req)!;
    if (p.role !== 'admin' && visitors.get(`${w.config.id}|${p.keyId}`) !== req.params.vid) throw new HttpError(403, 'not your visitor');
    const actions = (req.body as { actions?: Action[] }).actions;
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > 3) throw new HttpError(400, 'actions: 1 to 3 actions');
    return submit(w, 'visitor.command', { visitorId: req.params.vid, actions }, { userId: p.keyId });
  }));

  // ---- log, feed, replay, fork
  app.get('/worlds/:id/events', need('spectator'), route((req) => inputLog.page(world(req).config.id, Number(req.query.fromSeq ?? 0), Math.min(1000, Number(req.query.limit ?? 100)))));
  app.get('/worlds/:id/feed', need('spectator'), route((req) => reads.feed(world(req).config.id, req.query.characterId ? String(req.query.characterId) : undefined, Math.min(500, Number(req.query.limit ?? 100)))));
  app.get('/worlds/:id/deltas', need('spectator'), route((req) => {
    const rows = reads.deltas(world(req).config.id, Number(req.query.fromTick ?? 0), Number(req.query.toTick ?? Number.MAX_SAFE_INTEGER));
    // `kinds=beliefs,sleep` keeps only those delta kinds (e.g. a viewer's belief markers on the timeline).
    if (!req.query.kinds) return rows;
    const kinds = new Set(String(req.query.kinds).split(','));
    return rows.map((r) => ({ tick: r.tick, changes: r.changes.filter((c) => kinds.has(c.kind)) })).filter((r) => r.changes.length);
  }));
  app.post('/worlds/:id/seek', need('spectator'), route((req) => {
    const { id, state } = hub.openSession(world(req).config.id, Number((req.body as { tick: number }).tick));
    return { sessionId: id, tick: state.tick, state };
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
      restore: (s) => World.fromSnapshot(s.state, registry, minds),
      toTick: Number(body.tick),
      onTick: () => minds.drain(),
    });
    const id = body.id ?? `${parent.config.id}-fork-${body.tick}`;
    const config = parseWorldFile({ ...parent.config, ...body.config, id, entities: [] });
    return summary(await startWorld(config, { initialState: at.snapshot(), parent: { worldId: parent.config.id, forkTick: Number(body.tick) } }));
  }));

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
    res.status(status).json({ error: err.message });
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

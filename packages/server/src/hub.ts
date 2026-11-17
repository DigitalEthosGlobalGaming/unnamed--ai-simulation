import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Channel, ClientMessage, Region, ServerMessage } from '@uas/core';
import type { WorldState } from '@uas/sim';
import type { SqliteInputLog, SqliteSnapshotStore } from '@uas/store';
import { allows, type KeyRing } from './auth.ts';
import { filterRegion, splitChannels } from './region.ts';
import { ReplaySession } from './replay-session.ts';
import type { Supervisor } from './supervisor.ts';

interface Sub {
  worldId: string;
  channels: Set<Channel>;
  region?: Region;
}

/** Streams world deltas, the brain feed and noises; also hosts replay sessions. */
export class Hub {
  readonly wss: WebSocketServer;
  private readonly subs = new Map<WebSocket, Map<string, Sub>>();
  readonly sessions = new Map<string, { session: ReplaySession; socket?: WebSocket }>();
  private nextSession = 1;
  private readonly sup: Supervisor;
  private readonly log: SqliteInputLog;
  private readonly snaps: SqliteSnapshotStore<WorldState>;
  private readonly keys: KeyRing;

  constructor(sup: Supervisor, log: SqliteInputLog, snaps: SqliteSnapshotStore<WorldState>, keys: KeyRing) {
    this.sup = sup;
    this.log = log;
    this.snaps = snaps;
    this.keys = keys;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.connect(ws, req));
  }

  /** Wire a world's worker output to subscribers. */
  attach(worldId: string): void {
    const handle = this.sup.get(worldId)!;
    handle.on('deltas', (tick, changes) => {
      for (const [ws, subs] of this.subs) {
        const sub = subs.get(worldId);
        if (sub) this.sendTick(ws, sub, tick, changes);
      }
    });
  }

  private sendTick(ws: WebSocket, sub: Sub, tick: number, changes: Parameters<typeof filterRegion>[0], sessionId?: string) {
    const ch = splitChannels(filterRegion(changes, sub.region));
    const base = { worldId: sub.worldId, ...(sessionId && { sessionId }) };
    if (sub.channels.has('deltas') && ch.deltas.length) send(ws, { type: 'deltas', ...base, tick, changes: ch.deltas });
    if (sub.channels.has('feed')) for (const entry of ch.feed) send(ws, { type: 'feed', ...base, entry });
    if (sub.channels.has('noises') && ch.noises.length) send(ws, { type: 'noises', ...base, tick, noises: ch.noises as never });
  }

  private connect(ws: WebSocket, req: IncomingMessage) {
    const key = new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? undefined;
    const principal = this.keys.identify(key);
    if (principal === null) {
      ws.close(4401, 'unknown key');
      return;
    }
    this.subs.set(ws, new Map());
    ws.on('close', () => {
      const worlds = [...(this.subs.get(ws)?.keys() ?? [])];
      this.subs.delete(ws);
      for (const id of worlds) this.updateWatched(id);
      for (const [id, s] of this.sessions) if (s.socket === ws) this.closeSession(id);
    });
    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(ws, { type: 'error', message: 'invalid JSON' });
      }
      try {
        await this.handle(ws, msg, principal);
      } catch (e) {
        send(ws, { type: 'error', message: (e as Error).message });
      }
    });
  }

  private async handle(ws: WebSocket, msg: ClientMessage, principal: ReturnType<KeyRing['identify']>) {
    const world = 'worldId' in msg ? this.sup.get(msg.worldId) : undefined;
    if ('worldId' in msg && !world) throw new Error(`no world ${msg.worldId}`);
    if (world && !allows(principal ?? undefined, 'spectator', world.config.publicRead)) throw new Error('not allowed');
    switch (msg.type) {
      case 'subscribe': {
        const sub: Sub = { worldId: msg.worldId, channels: new Set(msg.channels ?? ['deltas', 'feed', 'noises']), ...(msg.region && { region: msg.region }) };
        const state = await world!.call<WorldState>({ method: 'state' });
        send(ws, { type: 'snapshot', worldId: msg.worldId, tick: state.tick, state });
        this.subs.get(ws)!.set(msg.worldId, sub);
        this.updateWatched(msg.worldId);
        return;
      }
      case 'unsubscribe':
        this.subs.get(ws)!.delete(msg.worldId);
        this.updateWatched(msg.worldId);
        return;
      case 'replay.open': {
        const { id, state } = this.openSession(msg.worldId, msg.tick, ws);
        send(ws, { type: 'replay.opened', worldId: msg.worldId, sessionId: id, tick: state.tick });
        send(ws, { type: 'snapshot', worldId: msg.worldId, sessionId: id, tick: state.tick, state });
        return;
      }
      case 'play':
      case 'pause':
      case 'seek':
      case 'replay.close': {
        const s = this.sessions.get(msg.sessionId);
        if (!s) throw new Error(`no replay session ${msg.sessionId}`);
        s.socket = ws;
        if (msg.type === 'replay.close') return this.closeSession(msg.sessionId);
        if (msg.type === 'pause') return s.session.pause();
        if (msg.type === 'seek') {
          const state = s.session.seek(msg.tick);
          return send(ws, { type: 'snapshot', worldId: state.config.worldId, sessionId: msg.sessionId, tick: state.tick, state });
        }
        const live = this.sup.get(s.session.world.state.config.worldId);
        return s.session.play(() => live?.status?.tick ?? s.session.world.tick, msg.speed ?? 1);
      }
    }
  }

  /** Tell a world whether anyone is watching, so it can run fast or slow. */
  private updateWatched(worldId: string): void {
    const watched = [...this.subs.values()].some((m) => m.has(worldId));
    void this.sup.get(worldId)?.call({ method: 'clock', watched }).catch(() => undefined);
  }

  /** Used by `POST /worlds/:id/seek` and `replay.open`. */
  openSession(worldId: string, tick: number, socket?: WebSocket): { id: string; state: WorldState } {
    const world = this.sup.get(worldId);
    if (!world) throw new Error(`no world ${worldId}`);
    const id = `r${this.nextSession++}`;
    const sub: Sub = { worldId, channels: new Set(['deltas', 'feed', 'noises']) };
    const session = new ReplaySession(
      id,
      world.config,
      this.log,
      this.snaps,
      (t, changes) => {
        const s = this.sessions.get(id);
        if (s?.socket) this.sendTick(s.socket, sub, t, changes, id);
      },
      () => {
        const s = this.sessions.get(id);
        if (s?.socket) send(s.socket, { type: 'replay.ended', sessionId: id, tick: session.world.tick });
      },
    );
    const state = session.seek(tick);
    this.sessions.set(id, { session, ...(socket && { socket }) });
    return { id, state };
  }

  private closeSession(id: string) {
    this.sessions.get(id)?.session.pause();
    this.sessions.delete(id);
  }

  close() {
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    for (const ws of this.subs.keys()) ws.close();
    this.wss.close();
  }
}

function send(ws: WebSocket, m: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
}

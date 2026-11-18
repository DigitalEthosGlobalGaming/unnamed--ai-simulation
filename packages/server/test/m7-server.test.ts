import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UasClient, type WorldStream } from '@uas/client';
import { KeyRing, createApp, loadWorldYaml, type App } from '../src/index.ts';

const ADMIN = 'admin-test-key';
const VISITOR = 'visitor-test-key';
let app: App;
let base: string;

beforeAll(async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-server-')), 'uas.db');
  app = createApp({ dbPath, keys: new KeyRing([{ key: ADMIN, role: 'admin' }, { key: VISITOR, role: 'visitor' }]), log: () => {} });
  // The shipped garden world, run fast, with offline fake models (no network).
  const yaml = readFileSync(join(import.meta.dirname, '../../../worlds/garden.yaml'), 'utf8');
  const config = loadWorldYaml(yaml, { UAS_BRAIN: 'models', UAS_DECIDER: 'fake', UAS_SCORER: 'fake', UAS_PLANNER: 'fakeChat', UAS_REFLECTOR: 'fakeChat' });
  // A fast scaled copy of the shipped garden (real time would make the test take real minutes).
  config.clock.mode = 'scaled';
  config.ticksPerRealSecond = 100;
  config.idleTicksPerRealSecond = 100;
  config.sim.secondsPerTick = 6;
  (config.models as { jobs: Record<string, unknown> }).jobs.reflect = ['fakeChat'];
  await app.startWorld(config);
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
});

describe('M7: server', () => {
  const admin = () => new UasClient(base, ADMIN);
  const anon = () => new UasClient(base);

  it('health, metrics and world list', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true, worlds: ['garden'] });
    const worlds = await anon().worlds();
    expect(worlds[0]).toMatchObject({ id: 'garden', packs: ['basic'] });
    await new Promise((r) => setTimeout(r, 1200));
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/uas_tick\{world="garden"\} \d+/);
    expect(metrics).toContain('uas_cost_aud_per_hour');
    expect(metrics).toMatch(/uas_model_queue_wait_p95_ms\{world="garden"\} \d+/);
  });

  it('enforces roles', async () => {
    await expect(anon().poke('garden', 'robot')).rejects.toMatchObject({ status: 401 });
    await expect(new UasClient(base, VISITOR).poke('garden', 'robot')).rejects.toMatchObject({ status: 403 });
    await expect(new UasClient(base, 'nope').worlds()).rejects.toMatchObject({ status: 401 });
    await expect(anon().usage()).rejects.toMatchObject({ status: 401 });
  });

  it('streams a snapshot then per-tick deltas and the brain feed over WebSocket', async () => {
    const ws: WorldStream = anon().connect();
    await ws.open;
    const snapshot = ws.next('snapshot');
    const deltas = ws.next('deltas');
    const feed = ws.next('feed');
    ws.subscribe('garden');
    const s = await snapshot;
    expect((s.state as { entities: Record<string, unknown> }).entities.robot).toBeDefined();
    expect((await deltas).tick).toBeGreaterThanOrEqual(s.tick);
    expect((await feed).entry.characterId).toBe('robot');
    // A subscribed viewer switches the world to its watched pacing.
    await new Promise((r) => setTimeout(r, 1200));
    expect((await anon().world('garden')).status!.watched).toBe(true);
    ws.close();
  });

  it('mind, memories, diary, feed and the input log over REST', async () => {
    const c = admin();
    await c.poke('garden', 'robot');
    await new Promise((r) => setTimeout(r, 500));
    const mind = await c.mind('garden', 'robot');
    expect(mind.mood.word).toBeTypeOf('string');
    expect(Object.keys(mind.needs)).toEqual(['cool', 'signal', 'curiosity']);
    const mem = await c.memories('garden', 'robot');
    expect(mem.sheet[0]!.text).toContain('small robot');
    expect((await c.diary('garden', 'robot')).entries.length).toBeGreaterThan(0);
    expect((await c.feed('garden', 'robot')).length).toBeGreaterThan(0);
    const events = await c.events('garden');
    expect(events.some((e) => e.type === 'admin.poke')).toBe(true);
    expect(events.some((e) => e.type === 'model.answer')).toBe(true);
    const usage = await c.usage('garden');
    expect(usage.garden!.rows.some((r) => r.job === 'decide' && r.calls > 0)).toBe(true);
    expect(usage.garden!.queue.completed).toBeGreaterThan(0);
  });

  it('serves a display catalog and filters recorded deltas by kind (for the viewer)', async () => {
    const c = anon();
    const cat = await c.catalog('garden');
    expect(cat.objects.find((o) => o.type === 'fountain')?.verbs).toEqual(['rinse', 'splash', 'fill', 'scan']);
    expect(cat.models.find((m) => m.id === 'hostedText')).toMatchObject({ adapter: 'openai-compatible', model: 'meta/llama-3.1-8b', provider: 'meta', local: false });
    expect(cat.models.find((m) => m.id === 'localDm')).toMatchObject({ adapter: 'ollama-decision', provider: 'ollama', local: true });
    expect(JSON.stringify(cat.models)).not.toMatch(/apiKey/);
    const robot = cat.archetypes.find((a) => a.type === 'robot')!;
    expect(robot.needs.cool?.low).toBe(0.25);
    expect(robot.noises?.pitches.C).toBe(523.25);
    expect(robot.sightRange).toBe(6);
    expect(cat.dailyCapAud).toBe(0.5);
    const rows = await c.deltas('garden', 0, undefined, ['needs']);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.changes.every((d) => d.kind === 'needs'))).toBe(true);
  });

  it('admin edits are logged input events', async () => {
    const c = admin();
    const e = await c.editEntity('garden', 'ball', { pos: { x: 5, y: 12 } });
    expect(e).toMatchObject({ type: 'admin.edit', payload: { id: 'ball', pos: { x: 5, y: 12 } } });
    const s = await c.clock('garden', { timeScale: 2 });
    expect(s.timeScale).toBe(2);
  });

  it('replays: seek over REST, then play over WebSocket with the same session', async () => {
    const c = admin();
    const { sessionId, tick } = await c.seek('garden', 150);
    expect(tick).toBe(150);
    const ws = c.connect();
    await ws.open;
    const d = ws.next('deltas', (m) => m.sessionId === sessionId);
    ws.play(sessionId, 4);
    expect((await d).tick).toBeGreaterThanOrEqual(150);
    ws.close();
  });

  it('forks a world at a tick and runs it side by side', async () => {
    const c = admin();
    const fork = await c.fork('garden', 200, { id: 'garden-b' });
    expect(fork.id).toBe('garden-b');
    await new Promise((r) => setTimeout(r, 300));
    expect((await c.worlds()).map((w) => w.id).sort()).toEqual(['garden', 'garden-b']);
    expect((await c.world('garden-b')).status!.tick).toBeGreaterThanOrEqual(200);
  });
});

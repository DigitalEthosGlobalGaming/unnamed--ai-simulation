import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyRing, createApp, parseWorldFile, type App } from '../src/index.ts';

/** GET /worlds/:id/objects/:oid/history: a plant's growth line, from the stored state deltas. */
let app: App;
let base: string;
const get = async (path: string) => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, json: (await r.json()) as any };
};

beforeAll(async () => {
  app = createApp({ dbPath: join(mkdtempSync(join(tmpdir(), 'uas-history-')), 'uas.db'), keys: new KeyRing([]), log: () => {} });
  await app.startWorld(
    parseWorldFile({
      id: 'hg',
      seed: 1,
      map: 'basic:garden-2',
      clock: { mode: 'scaled' },
      // An in-world hour every 0.6 s.
      ticksPerRealSecond: 100,
      idleTicksPerRealSecond: 100,
      sim: { secondsPerTick: 60 },
      mind: { brain: 'autopilot' },
      entities: [
        { id: 'bed', type: 'garden-bed', pos: [5, 11] },
        { id: 'plant', type: 'plant', pos: [6, 11], state: { growth: 0, water: 0.6 } },
      ],
      models: { models: {}, jobs: {} },
    }),
  );
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  // Wait for a few in-world hours of plant rules (an hour every 0.6 s; slower on a loaded machine).
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${base}/worlds/hg/objects/plant/history?keys=growth`);
    if (r.ok && ((await r.json()) as { points: unknown[] }).points.length >= 5) break;
    await new Promise((res) => setTimeout(res, 250));
  }
}, 40_000);

afterAll(async () => {
  await app.close();
});

describe('object state history', () => {
  it('returns hourly changes, oldest first, with the values now as the last point', async () => {
    const h = (await get('/worlds/hg/objects/plant/history?keys=growth,water')).json;
    expect(h.keys).toEqual(['growth', 'water']);
    expect(h.points.length).toBeGreaterThanOrEqual(4);
    const ticks = h.points.map((p: { tick: number }) => p.tick);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    const growth = h.points.map((p: { values: { growth: number } }) => p.values.growth);
    expect(growth.at(-1)).toBeGreaterThan(growth[0]);
    expect(h.points.at(-1).values.water).toBeLessThan(0.6);
  });

  it('starts at sinceTick with the values then, thins to maxPoints, and leaves unknown keys out', async () => {
    const all = (await get('/worlds/hg/objects/plant/history?keys=growth')).json.points as { tick: number; values: { growth: number } }[];
    const mid = all[Math.floor(all.length / 2)]!.tick + 1;
    const from = (await get(`/worlds/hg/objects/plant/history?keys=growth,nope&sinceTick=${mid}`)).json;
    expect(from.points[0]).toEqual({ tick: mid, values: { growth: all[Math.floor(all.length / 2)]!.values.growth } });
    expect(from.points.every((p: { values: Record<string, number> }) => !('nope' in p.values))).toBe(true);
    const thin = (await get('/worlds/hg/objects/plant/history?maxPoints=3')).json;
    expect(thin.points).toHaveLength(3);
    expect(thin.points[0].tick).toBeLessThanOrEqual(all[0]!.tick); // first and last are kept
    expect(thin.points[2].tick).toBeGreaterThanOrEqual(all.at(-1)!.tick);
    expect(thin.keys).toEqual(expect.arrayContaining(['growth', 'water']));
  });

  it('404 for an unknown object', async () => {
    expect((await get('/worlds/hg/objects/nope/history')).status).toBe(404);
  });
});

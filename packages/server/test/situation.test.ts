import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSituation, situationRequest } from '@uas/evals';
import { KeyRing, createApp, parseWorldFile, type App } from '../src/index.ts';

let app: App;
let base: string;
const dir = join(mkdtempSync(join(tmpdir(), 'uas-sit-')), 'captured');
beforeAll(async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-sitdb-')), 'uas.db');
  app = createApp({ dbPath, keys: new KeyRing([{ key: 'adm', role: 'admin' }, { key: 'vis', role: 'visitor' }]), log: () => {}, situationsDir: dir });
  await app.startWorld(
    parseWorldFile({
      id: 'sg',
      seed: 1,
      clock: { mode: 'scaled' },
      ticksPerRealSecond: 50,
      idleTicksPerRealSecond: 50,
      snapshotEveryTicks: 20,
      mind: { brain: 'autopilot' },
      entities: [{ id: 'robot', type: 'robot', pos: [10, 10] }, { id: 'pad', type: 'solarPad', pos: [8, 8] }, { id: 'mailbox', type: 'mailbox', pos: [17, 8] }],
      models: { models: {}, jobs: {} },
    }),
  );
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await new Promise((r) => setTimeout(r, 1500));
});
afterAll(async () => {
  await app.close();
});

const post = (path: string, key: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

describe('POST /worlds/:id/characters/:cid/situation', () => {
  it('captures the moment now, writes it when configured, and rebuilds', async () => {
    const res = await post('/worlds/sg/characters/robot/situation', 'adm', { title: 'now', tags: ['smoke'] });
    expect(res.status).toBe(200);
    const { situation, path } = (await res.json()) as { situation: unknown; path: string };
    const s = parseSituation(situation);
    expect(s).toMatchObject({ title: 'now', tags: ['captured', 'smoke'], source: { kind: 'captured', world: 'sg', characterId: 'robot' } });
    expect(path).toBe(join(dir, `${s.id}.json`));
    expect(JSON.parse(readFileSync(path, 'utf8')).id).toBe(s.id);
    expect(situationRequest(s).candidates.length).toBeGreaterThan(0);
  });

  it('captures a past tick by replay', async () => {
    const res = await post('/worlds/sg/characters/robot/situation', 'adm', { tick: 25 });
    const { situation } = (await res.json()) as { situation: { source: { tick: number }; id: string; templates?: Record<string, number> } };
    expect(situation.source.tick).toBe(25);
    expect(situation.templates).toEqual({ decide: 1, plan: 1, consolidate: 1, sheet: 1, mail: 1 });
    expect(existsSync(join(dir, `${situation.id}.json`))).toBe(true);
  });

  it('is admin-only and 404s for a character without a mind', async () => {
    expect((await post('/worlds/sg/characters/robot/situation', 'vis')).status).toBe(403);
    expect((await post('/worlds/sg/characters/pad/situation', 'adm')).status).toBe(404);
  });
});

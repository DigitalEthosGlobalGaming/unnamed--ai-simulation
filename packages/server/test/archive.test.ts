import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyRing, WorldRuntime, createApp, parseWorldFile, type App } from '../src/index.ts';

const world = (id: string, archived = false) =>
  parseWorldFile({ id, seed: 1, map: 'basic:garden-2', clock: { mode: 'scaled' }, archived, mind: { brain: 'autopilot' }, entities: [{ id: 'robot', type: 'robot', pos: [10, 10] }, { id: 'bed', type: 'garden-bed', pos: [5, 11] }], models: { models: {}, jobs: {} } });

let app: App;
let base: string;
const dir = mkdtempSync(join(tmpdir(), 'uas-archive-'));
beforeAll(async () => {
  const dbPath = join(dir, 'uas.db');
  // The world has history first, then is archived.
  const rt = new WorldRuntime(world('old'), { dbPath });
  rt.start();
  for (let i = 0; i < 20; i++) rt.tick();
  rt.shutdown();
  app = createApp({ dbPath, keys: new KeyRing([{ key: 'adm', role: 'admin' }, { key: 'vis', role: 'visitor' }]), log: () => {} });
  await app.startWorld(world('old', true));
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}, 30_000); // a worker start under a loaded full run can pass the 10 s default
afterAll(async () => {
  await app.close();
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { authorization: 'Bearer adm', 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });

describe('archived worlds', () => {
  it('stay readable, never tick, and refuse every input with 409', async () => {
    const before = (await (await call('GET', '/worlds/old')).json()) as { archived: boolean; status: { tick: number; archived: boolean } };
    expect(before.archived).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const after = (await (await call('GET', '/worlds/old')).json()) as { status: { tick: number } };
    expect(after.status.tick).toBe(before.status.tick);
    expect((await call('POST', '/worlds/old/mail', { text: 'hello' })).status).toBe(409);
    expect((await call('PATCH', '/worlds/old/settings', { needDecayMultiplier: 2 })).status).toBe(409);
    expect((await call('POST', '/worlds/old/entities', { type: 'ball', pos: { x: 1, y: 1 } })).status).toBe(409);
    expect((await call('GET', '/worlds/old/events?fromSeq=0')).status).toBe(200);
    expect((await call('GET', '/worlds/old/feed')).status).toBe(200);
  });

  it('GET /objects/defs lists pack and catalogue definitions as schema 2', async () => {
    const defs = (await (await call('GET', '/objects/defs')).json()) as { id: string; schema: number; source: string; footprint?: unknown }[];
    expect(defs.find((d) => d.id === 'garden-bed')).toMatchObject({ schema: 2, source: 'pack', footprint: { w: 3, h: 2 } });
    expect(defs.find((d) => d.id === 'cooling-gel')).toMatchObject({ schema: 2, source: 'catalog' });
    expect(defs.some((d) => d.id === 'solarPad')).toBe(false); // legacy, not schema 2
  });
});

describe('world scripts', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const script = join(root, 'packages/server/scripts/world.ts');
  it('world:new writes a fresh world file; world:archive backs up the database first, then flags it', () => {
    const worlds = join(dir, 'worlds');
    mkdirSync(worlds, { recursive: true });
    writeFileSync(join(worlds, 'garden2.yaml'), readFileSync(join(root, 'worlds/garden2.yaml'), 'utf8'));
    const db = join(dir, 'uas.db');
    const made = spawnSync('node', [script, 'new', '--world', 'garden3', '--map', 'garden-2', '--worlds', worlds, '--db', db], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const yaml = readFileSync(join(worlds, 'garden3.yaml'), 'utf8');
    expect(yaml).toMatch(/^id: garden3$/m);
    expect(yaml).toMatch(/^map: basic:garden-2$/m);
    // An id the database already has is refused.
    writeFileSync(join(worlds, 'old.yaml'), yaml.replace(/^id: garden3$/m, 'id: old'));
    const again = spawnSync('node', [script, 'new', '--world', 'old', '--worlds', join(dir, 'none'), '--db', db, '--template', join(worlds, 'garden2.yaml')], { encoding: 'utf8' });
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already has a world "old"/);
    const archived = spawnSync('node', [script, 'archive', '--world', 'old', '--worlds', worlds, '--db', db], { encoding: 'utf8' });
    expect(archived.status, archived.stderr).toBe(0);
    expect(readdirSync(join(dir, 'archive')).some((f) => /^old-\d{4}-\d{2}-\d{2}\.db$/.test(f))).toBe(true);
    expect(readFileSync(join(worlds, 'old.yaml'), 'utf8')).toMatch(/^archived: true/m);
    expect(existsSync(db)).toBe(true);
  });
});

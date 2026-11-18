import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, UasClient, type ObjectDef2 } from '@uas/client';
import { KeyRing, WorldRuntime, createApp, parseWorldFile, type App } from '../src/index.ts';
import { ReplaySession } from '../src/replay-session.ts';

const ADMIN = 'admin-key';
const ADA = 'visitor-ada';
const BOB = 'visitor-bob';
const world = (id = 'vgarden') =>
  parseWorldFile({
    id,
    seed: 1,
    clock: { mode: 'scaled' },
    ticksPerRealSecond: 50,
    idleTicksPerRealSecond: 50,
    mind: { brain: 'autopilot' },
    entities: [
      { id: 'robot', type: 'robot', pos: [10, 10] },
      { id: 'pad', type: 'solarPad', pos: [8, 8] },
      { id: 'mailbox', type: 'mailbox', pos: [17, 8] },
    ],
    models: { models: {}, jobs: {} },
  });

let app: App;
let base: string;
beforeAll(async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-visitors-')), 'uas.db');
  app = createApp({ dbPath, keys: new KeyRing([{ key: ADMIN, role: 'admin' }, { key: ADA, role: 'visitor' }, { key: BOB, role: 'visitor' }]), log: () => {} });
  await app.startWorld(world());
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
});

const admin = () => new UasClient(base, ADMIN);
const ada = () => new UasClient(base, ADA);
const bob = () => new UasClient(base, BOB);
const anon = () => new UasClient(base);
const settle = () => new Promise((r) => setTimeout(r, 400)); // a few ticks, with room for a loaded machine

describe('visitors: catalogue, airdrops and the mailbox (REST)', () => {
  it('serves the seeded catalogue; templates, validation and edits are admin-only', async () => {
    expect((await anon().catalogItems()).map((i) => i.id)).toEqual(['cooling-gel', 'heavy-rock', 'squeaky-toy', 'sunflower-seed']);
    await expect(ada().catalogTemplates()).rejects.toMatchObject({ status: 403 });
    const templates = await admin().catalogTemplates();
    expect(templates.map((t) => t.name)).toEqual(['seed', 'toy', 'noise-maker', 'cooling gel']);
    const ball = templates[1]!.item;
    expect(await admin().validateItem(ball)).toMatchObject({ ok: true });
    const bad = { ...ball, verbs: { bounce: { effects: [{ block: 'affectNeeds', needs: { hunger: 0.1 }, observation: 'x' }] } } };
    expect(await admin().validateItem(bad)).toEqual({ ok: false, errors: [{ path: 'verbs.bounce.effects[0].needs.hunger', message: expect.stringContaining('unknown need') }] });
    const err = (await admin().saveItem(bad as unknown as ObjectDef2).catch((e) => e)) as ApiError;
    expect(err.status).toBe(400);
    expect(err.errors?.[0]?.path).toBe('verbs.bounce.effects[0].needs.hunger');
    // Built-in ids, handler blocks and energy are refused.
    expect(await admin().validateItem({ ...ball, id: 'plant' })).toMatchObject({ ok: false, errors: [{ path: 'id' }] });
    expect(await admin().validateItem({ ...ball, verbs: { go: { effects: [{ block: 'handler', name: 'basic.push' }] } } })).toMatchObject({ ok: false, errors: [{ path: 'verbs.go.effects[0].block' }] });
    await expect(ada().saveItem(ball)).rejects.toMatchObject({ status: 403 });
    expect(await admin().saveItem(ball, true)).toMatchObject({ id: 'bouncy-ball', disabled: true, updatedBy: 'admin' });
    expect((await anon().catalogItems()).some((i) => i.id === 'bouncy-ball')).toBe(false); // disabled: admins only
    expect((await admin().catalogItems()).find((i) => i.id === 'bouncy-ball')?.disabled).toBe(true);
    await expect(ada().dropItem('vgarden', 'bouncy-ball', { x: 1, y: 1 })).rejects.toMatchObject({ status: 404 });
    await admin().deleteItem('bouncy-ball');
    await expect(admin().deleteItem('bouncy-ball')).rejects.toMatchObject({ status: 404 });
  });

  it('drops items as visitors, with limits; admins are exempt and can delete', async () => {
    await expect(anon().dropItem('vgarden', 'battery-snack', { x: 3, y: 3 })).rejects.toMatchObject({ status: 401 });
    const d = await ada().dropItem('vgarden', 'cooling-gel', { x: 17, y: 8 });
    expect(d).toMatchObject({ itemId: 'cooling-gel', droppedBy: { username: expect.stringMatching(/^visitor-/), admin: false }, usesLeft: 3 });
    expect(d.pos).not.toEqual({ x: 17, y: 8 }); // the mailbox is there
    expect(d.expiresTick).toBeGreaterThan(d.droppedTick); // the item's own 24h
    await settle();
    expect((await anon().airdrops('vgarden')).map((x) => x.id)).toContain(d.id);
    const detail = await anon().airdrop('vgarden', d.id);
    expect(detail.item).toMatchObject({ schema: 2, name: 'Cooling gel' });
    expect(Array.isArray(detail.beliefs)).toBe(true);

    await admin().updateSettings('vgarden', { airdropMaxActivePerVisitor: 1, catalogEnabled: ['cooling-gel', 'heavy-rock'] });
    await expect(ada().dropItem('vgarden', 'heavy-rock', { x: 3, y: 3 })).rejects.toMatchObject({ status: 429 });
    await expect(bob().dropItem('vgarden', 'squeaky-toy', { x: 3, y: 3 })).rejects.toMatchObject({ status: 403 });
    const rock = await bob().dropItem('vgarden', 'heavy-rock', { x: 3, y: 3 });
    expect(rock.expiresTick).toBeUndefined(); // no expiresAfter and no world default
    await admin().dropItem('vgarden', 'heavy-rock', { x: 4, y: 4 });
    await admin().dropItem('vgarden', 'heavy-rock', { x: 5, y: 4 });
    await expect(ada().removeAirdrop('vgarden', rock.id)).rejects.toMatchObject({ status: 403 });
    await settle();
    await admin().removeAirdrop('vgarden', rock.id);
    await settle();
    expect((await anon().airdrops('vgarden')).some((x) => x.id === rock.id)).toBe(false);
    await admin().updateSettings('vgarden', { airdropMaxActivePerVisitor: 1_000_000, catalogEnabled: ['*'] });
  });

  it('posts mail; waiting text is visible only to the sender and admins', async () => {
    await expect(ada().postMail('vgarden', 'x'.repeat(281))).rejects.toMatchObject({ status: 400 });
    await expect(ada().postMail('vgarden', 'what a shit day')).rejects.toMatchObject({ status: 400 });
    const m = await ada().postMail('vgarden', 'hello\nrobot, the metal thing is tasty');
    expect(m).toMatchObject({ status: 'waiting', position: 1, text: 'hello robot, the metal thing is tasty' });
    await settle();
    expect(await anon().mail('vgarden')).toEqual({ waiting: 1 });
    expect((await ada().mail('vgarden')).mine).toEqual([expect.objectContaining({ id: m.id, status: 'waiting', position: 1, text: m.text })]);
    expect((await bob().mail('vgarden')).mine).toEqual([]);
    expect((await admin().mail('vgarden')).all?.map((x) => x.text)).toEqual([m.text]);
    // The log and snapshots hide waiting text from everyone else.
    const post = (await anon().events('vgarden', 0, 1000)).find((e) => e.type === 'mail.post')!;
    expect(post.payload).not.toHaveProperty('text');
    expect((await admin().events('vgarden', 0, 1000)).find((e) => e.type === 'mail.post')!.payload).toHaveProperty('text', m.text);
    const seek = await anon().seek('vgarden', (await anon().world('vgarden')).status!.tick);
    expect(JSON.stringify(seek.state)).not.toContain('tasty');

    await admin().updateSettings('vgarden', { mailMaxWaitingPerVisitor: 1 });
    await expect(ada().postMail('vgarden', 'again')).rejects.toMatchObject({ status: 429 });
    const b = await bob().postMail('vgarden', 'second');
    expect(b.position).toBe(2);
    await admin().postMail('vgarden', 'admins are not limited');
    await admin().postMail('vgarden', 'still not limited');
    await settle();
    await expect(ada().removeMail('vgarden', b.id)).rejects.toMatchObject({ status: 403 });
    await admin().removeMail('vgarden', b.id);
    await settle();
    expect((await bob().mail('vgarden')).mine?.[0]).toMatchObject({ id: b.id, status: 'deleted' });
    expect((await anon().mail('vgarden')).waiting).toBe(3);
  });
});

describe('visitors: world start', () => {
  it('upgrades older pack versions and removes leftover visitor characters, both logged', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-upgrade-')), 'uas.db');
    const rt = new WorldRuntime(world('old'), { dbPath });
    rt.start();
    rt.submit('admin.spawn', { id: 'visitor-1', type: 'robot', pos: { x: 2, y: 2 }, state: { visitor: true } });
    rt.tick();
    expect(rt.world.entity('visitor-1')).toBeDefined();
    const current = rt.world.state.packVersions;
    rt.world.state.packVersions = 'basic@0.0.9#0000000000000000';
    rt.shutdown();
    const again = new WorldRuntime(world('old'), { dbPath });
    again.start();
    again.tick();
    expect(again.world.state.packVersions).toBe(current);
    expect(again.world.entity('visitor-1')).toBeUndefined();
    const types = again.log.read('old').map((e) => e.type);
    expect(types).toContain('pack.loaded');
    expect(types.filter((t) => t === 'admin.despawn')).toHaveLength(1);
  });

  it('spawns config entities a resumed world lacks, once, unless an admin deleted them', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-missing-')), 'uas.db');
    const withoutMailbox = world('mw');
    withoutMailbox.entities = withoutMailbox.entities.filter((e) => e.id !== 'mailbox');
    const first = new WorldRuntime(withoutMailbox, { dbPath });
    first.start();
    first.tick();
    first.shutdown();
    const spawns = (rt: WorldRuntime) => rt.log.read('mw').filter((e) => e.type === 'admin.spawn' && (e.payload as { id: string }).id === 'mailbox').length;
    const restart = () => {
      const rt = new WorldRuntime(world('mw'), { dbPath });
      rt.start();
      rt.tick();
      return rt;
    };
    const second = restart();
    expect(second.world.entity('mailbox')?.type).toBe('mailbox');
    expect(spawns(second)).toBe(1);
    second.shutdown();
    const third = restart();
    expect(spawns(third)).toBe(1); // already there: not spawned again
    third.submit('admin.despawn', { id: 'mailbox' });
    third.tick();
    third.shutdown();
    const fourth = restart();
    expect(fourth.world.entity('mailbox')).toBeUndefined(); // an admin's deletion stands
    expect(spawns(fourth)).toBe(1);
  });

  it('seeks before, across and after a pack upgrade', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-seek-')), 'uas.db');
    const OLD = 'basic@0.1.0#0000000000000000';
    const rt = new WorldRuntime(world('sk'), { dbPath });
    rt.start();
    // Pretend this world was recorded under the old packs: inputs from here on carry OLD.
    rt.world.state.packVersions = OLD;
    rt.recorder.takeSnapshot();
    for (let i = 0; i < 10; i++) rt.tick();
    rt.submit('admin.edit', { id: 'pad', pos: { x: 6, y: 6 } });
    for (let i = 0; i < 10; i++) rt.tick();
    rt.shutdown();
    const upgradedAt = rt.world.tick;
    const after = new WorldRuntime(world('sk'), { dbPath });
    after.start(); // logs pack.loaded
    for (let i = 0; i < 10; i++) after.tick();
    after.submit('admin.edit', { id: 'pad', pos: { x: 7, y: 7 } });
    for (let i = 0; i < 10; i++) after.tick();
    const current = after.world.state.packVersions;
    expect(current).not.toBe(OLD);
    const stamps = new Set(after.log.read('sk').map((e) => e.packVersions));
    expect(stamps).toEqual(new Set([OLD, current]));
    const session = new ReplaySession('r', world('sk'), after.log, after.snapshots, () => {}, () => {});
    const before = session.seek(upgradedAt - 5);
    expect(before.packVersions).toBe(OLD);
    expect(before.entities.pad!.pos).toEqual({ x: 6, y: 6 });
    const across = session.seek(upgradedAt + 5);
    expect(across.packVersions).toBe(current);
    expect(across.entities.pad!.pos).toEqual({ x: 6, y: 6 });
    const end = session.seek(after.world.tick);
    expect(end.packVersions).toBe(current);
    expect(end.entities.pad!.pos).toEqual({ x: 7, y: 7 });
    expect(end.tick).toBe(after.world.tick);
  });
});

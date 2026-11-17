/**
 * SIMULATED DATA. A stand-in for the catalogue, airdrop and mailbox endpoints
 * (docs/architecture/visitors.md) so the viewer's visitor UI can be built and reviewed offline.
 * Roles come from the sample account (`?as=admin|visitor|spectator`). The sample sim doesn't know
 * about drops: they are drawn from this list, and robots don't use them.
 */
import { CATALOG_TEMPLATES, MAIL_MAX_LENGTH, cleanMailText, mailTextProblem, validateCatalogItem } from '@uas/core';
import { VisitorError, type Airdrop, type AirdropDetail, type CatalogItem, type MailStatus, type MailView, type ValidateResult, type Vec2, type VisitorApi } from '../types.ts';

export interface SampleWorldHooks {
  tick(): number;
  secondsPerTick: number;
  /** Walkable, not a fixture and not already holding a drop. */
  free(x: number, y: number): boolean;
  width: number;
  height: number;
  role(): 'admin' | 'visitor' | 'spectator';
  username(): string | null;
  enabled(): string[];
  feedTickNear(tick: number): number;
}

const ICONS = {
  snack: '<icon><rect x="7" y="4" w="10" h="16" r="1" shade="light"/><line x1="10" y1="2" x2="14" y2="2" weight="heavy"/><line x1="9" y1="9" x2="15" y2="9" weight="thin"/></icon>',
  ball: '<icon><circle cx="12" cy="12" r="8" weight="heavy"/><path d="M6 8 A9 9 0 0 1 18 8" weight="thin"/><circle cx="12" cy="12" r="2.5" shade="dense"/></icon>',
  coolpack: '<icon><rect x="4" y="6" w="16" h="12" r="2" shade="medium"/><line x1="12" y1="3" x2="12" y2="21" dashed="true" weight="thin"/></icon>',
  parasol: '<icon><path d="M3 12 A9 9 0 0 1 21 12 Z" shade="light" weight="heavy"/><line x1="12" y1="12" x2="12" y2="21"/><polyline points="12,21 14,21 14,19"/></icon>',
  cube: '<icon><rect x="5" y="5" w="14" h="14" shade="dense"/><line x1="5" y1="12" x2="19" y2="12" weight="thin"/><line x1="12" y1="5" x2="12" y2="19" weight="thin"/></icon>',
  inert: '<icon><rect x="6" y="6" w="12" h="12" dashed="true"/></icon>',
};

const now = () => new Date().toISOString();

const CATALOGUE: CatalogItem[] = [
  {
    schema: 1,
    id: 'battery-snack',
    name: 'Battery snack',
    description: 'A small cell. Gives a little charge.',
    icon: ICONS.snack,
    tags: ['metal', 'small'],
    portable: true,
    expiresAfter: '24h',
    behaviours: [
      { block: 'affectsNeeds', verb: 'eat', range: 0, durationSeconds: 5, needs: { energy: 0.1 }, observation: 'a tingle of charge' },
      { block: 'consumable', uses: 1 },
    ],
  },
  {
    schema: 1,
    id: 'squeaky-ball',
    name: 'Squeaky ball',
    description: 'A soft ball that squeaks two notes when squeezed.',
    icon: ICONS.ball,
    tags: ['toy', 'round', 'soft'],
    portable: true,
    expiresAfter: '7d',
    behaviours: [
      { block: 'portable' },
      { block: 'makesNoise', verb: 'squeeze', range: 0, notes: ['chirp-E', 'chirp-G'], observation: 'it squeaked' },
      { block: 'affectsNeeds', verb: 'squeeze', needs: { curiosity: 0.15 }, observation: 'that was fun' },
    ],
  },
  {
    schema: 1,
    id: 'cool-pack',
    name: 'Cool pack',
    description: 'A chilled gel pack. Good for three cool-downs.',
    icon: ICONS.coolpack,
    tags: ['cold', 'soft'],
    portable: true,
    expiresAfter: '24h',
    behaviours: [
      { block: 'affectsNeeds', verb: 'hold', range: 0, durationSeconds: 30, needs: { cool: 0.25 }, observation: 'the casing cooled' },
      { block: 'consumable', uses: 3 },
    ],
  },
  {
    schema: 1,
    id: 'parasol',
    name: 'Parasol',
    description: 'A little sunshade. Does nothing at all.',
    icon: ICONS.parasol,
    tags: ['fabric', 'tall'],
    expiresAfter: '7d',
    behaviours: [{ block: 'inert' }],
  },
  {
    schema: 1,
    id: 'puzzle-cube',
    name: 'Puzzle cube',
    description: 'A twisty cube. Disabled while its behaviour is worked out.',
    icon: ICONS.cube,
    tags: ['toy', 'small'],
    portable: true,
    behaviours: [{ block: 'portable' }, { block: 'affectsNeeds', verb: 'twist', needs: { curiosity: 0.2 }, observation: 'the colours moved' }],
    disabled: true,
  },
].map((i) => ({ ...i, updatedAt: now(), updatedBy: 'admin' }));

const TEMPLATES = (): { name: string; item: CatalogItem }[] => CATALOG_TEMPLATES.map((t) => ({ name: t.name, item: { ...(t.item as CatalogItem), id: `new-${t.item.id}` } }));

/** The server's own validation (shared in @uas/core), with the sample world's needs and noises. */
export function validateItem(raw: unknown): ValidateResult {
  const r = validateCatalogItem(raw, { needKeys: ['energy', 'cool', 'signal', 'curiosity'], noiseNames: ['beep', 'chirp', 'trill', 'buzz'] });
  return r.ok ? { ok: true, item: r.item as CatalogItem } : { ok: false, errors: r.errors };
}

const parseDuration = (s: string | undefined) => {
  const m = s?.match(/^(\d+)([mhd])$/);
  return m ? Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as 'm' | 'h' | 'd'] : 86400;
};

export class SampleVisitors implements VisitorApi {
  private catalogue = CATALOGUE.map((i) => ({ ...i }));
  private drops: Airdrop[] = [];
  private mailbox: MailStatus[] = [];
  private lastDropAt = -Infinity;
  private lastPostAt = -Infinity;
  private seq = 1;

  constructor(private readonly hooks: SampleWorldHooks) {
    const t = hooks.tick();
    const mk = (item: CatalogItem, pos: Vec2, by: { username: string; admin: boolean }, ago: number): Airdrop => ({
      id: `d${this.seq++}`,
      entityId: `drop-${this.seq}`,
      itemId: item.id,
      item,
      pos,
      droppedBy: by,
      droppedTick: t - ago,
      expiresTick: t - ago + Math.round(parseDuration(item.expiresAfter) / hooks.secondsPerTick),
      ...(item.behaviours.some((b) => b.block === 'consumable') && { usesLeft: Number(item.behaviours.find((b) => b.block === 'consumable')!['uses']) }),
    });
    this.drops.push(mk(this.catalogue[0]!, { x: 9, y: 11 }, { username: 'sample-owner', admin: true }, 900), mk(this.catalogue[1]!, { x: 20, y: 6 }, { username: 'kiwi-fan', admin: false }, 300));
    const ft = hooks.feedTickNear(t - 2000);
    this.mailbox = [
      { id: 'm1', status: 'read', text: 'Hello little robot! Is the solar pad warm today?', from: { username: 'sample-owner', admin: true }, postedTick: t - 3200, readTick: ft, reaction: { feedTick: ft, summary: 'RB-02 chirped twice and went to the solar pad', notes: ['chirp-E', 'chirp-G'] } },
      { id: 'm2', status: 'waiting', position: 1, text: 'The ball rolls further on the path.', from: { username: 'sample-owner', admin: true }, postedTick: t - 400 },
      { id: 'm3', status: 'waiting', position: 2, text: 'Have you tried the piano at night?', from: { username: 'kiwi-fan', admin: false }, postedTick: t - 200 },
      { id: 'm4', status: 'expired', text: 'Good morning from the north.', from: { username: 'sample-owner', admin: true }, postedTick: t - 14000 },
    ];
  }

  get waiting(): number {
    return this.mailbox.filter((m) => m.status === 'waiting').length;
  }

  private need(role: 'visitor' | 'admin') {
    const r = this.hooks.role();
    if (r === 'spectator') throw new VisitorError(401, 'Sign in to do that.');
    if (role === 'admin' && r !== 'admin') throw new VisitorError(403, 'Only admins can do that.');
  }

  private async later<T>(v: T): Promise<T> {
    await new Promise((r) => setTimeout(r, 200));
    return v;
  }

  async catalog() {
    const admin = this.hooks.role() === 'admin';
    return this.catalogue.filter((i) => admin || !i.disabled).map((i) => ({ ...i }));
  }
  async templates() {
    this.need('admin');
    return TEMPLATES();
  }
  async validate(item: unknown) {
    this.need('admin');
    return this.later(validateItem(item));
  }
  async saveItem(item: CatalogItem, disabled?: boolean) {
    this.need('admin');
    const v = validateItem(item);
    if (!v.ok) throw new VisitorError(400, 'The item has errors.', v.errors);
    const saved: CatalogItem = { ...v.item, disabled: disabled ?? this.catalogue.find((i) => i.id === item.id)?.disabled ?? false, updatedAt: now(), updatedBy: this.hooks.username() ?? 'admin' };
    const i = this.catalogue.findIndex((x) => x.id === item.id);
    if (i >= 0) this.catalogue[i] = saved;
    else this.catalogue.push(saved);
    return this.later({ ...saved });
  }
  async deleteItem(itemId: string) {
    this.need('admin');
    this.catalogue = this.catalogue.filter((i) => i.id !== itemId);
  }

  async airdrops() {
    const t = this.hooks.tick();
    this.drops = this.drops.filter((d) => !d.expiresTick || d.expiresTick > t);
    return this.drops.map((d) => ({ ...d }));
  }
  async airdrop(dropId: string): Promise<AirdropDetail> {
    const d = this.drops.find((x) => x.id === dropId);
    if (!d) throw new VisitorError(404, 'That item is gone.');
    const beliefs = d.itemId === 'battery-snack' ? [{ characterId: 'rb-01', text: 'The small metal thing might give me charge (I heard so).', firmness: 0.2 }] : [];
    return { ...d, beliefs };
  }
  async drop(itemId: string, pos: Vec2) {
    this.need('visitor');
    const admin = this.hooks.role() === 'admin';
    const item = this.catalogue.find((i) => i.id === itemId && !i.disabled);
    if (!item || !this.hooks.enabled().includes(itemId)) throw new VisitorError(400, 'That item is not enabled in this world.');
    const nowMs = performance.now();
    const cooldown = 90;
    const left = Math.ceil(cooldown - (nowMs - this.lastDropAt) / 1000);
    if (!admin && left > 0) throw new VisitorError(429, `Airdrop cooldown: ${left} s left before your next drop.`, [], left);
    if (!admin && this.drops.filter((d) => d.droppedBy.username === this.hooks.username()).length >= 3) throw new VisitorError(409, 'You already have 3 items in this world (the most per visitor).');
    const spot = this.nearestFree(pos);
    if (!spot) throw new VisitorError(409, 'No free tile near that spot.');
    const t = this.hooks.tick();
    const d: Airdrop = {
      id: `d${this.seq++}`,
      entityId: `drop-${this.seq}`,
      itemId,
      item: { ...item },
      pos: spot,
      droppedBy: { username: this.hooks.username() ?? 'visitor', admin },
      droppedTick: t,
      expiresTick: t + Math.round(parseDuration(item.expiresAfter) / this.hooks.secondsPerTick),
    };
    this.drops.push(d);
    this.lastDropAt = nowMs;
    return this.later({ ...d });
  }
  private nearestFree(p: Vec2): Vec2 | null {
    const taken = (x: number, y: number) => this.drops.some((d) => d.pos.x === x && d.pos.y === y);
    for (let r = 0; r < 6; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = p.x + dx;
          const y = p.y + dy;
          if (x >= 0 && y >= 0 && x < this.hooks.width && y < this.hooks.height && this.hooks.free(x, y) && !taken(x, y)) return { x, y };
        }
    return null;
  }
  async removeDrop(dropId: string) {
    this.need('admin');
    this.drops = this.drops.filter((d) => d.id !== dropId);
  }

  async mail(): Promise<MailView> {
    const r = this.hooks.role();
    const me = this.hooks.username();
    const view: MailView = { waiting: this.waiting };
    if (me) view.mine = this.mailbox.filter((m) => m.from.username === me).map((m) => ({ ...m }));
    if (r === 'admin') view.all = this.mailbox.map((m) => ({ ...m }));
    return view;
  }
  async postMail(text: string) {
    this.need('visitor');
    const admin = this.hooks.role() === 'admin';
    const t = cleanMailText(text);
    const problem = mailTextProblem(t);
    if (problem) throw new VisitorError(400, t.length > MAIL_MAX_LENGTH ? `At most ${MAIL_MAX_LENGTH} characters (this has ${t.length}).` : problem.charAt(0).toUpperCase() + problem.slice(1) + '.');
    const left = Math.ceil(60 - (performance.now() - this.lastPostAt) / 1000);
    if (!admin && left > 0) throw new VisitorError(429, `Mail cooldown: ${left} s left before you can post again.`, [], left);
    const m: MailStatus = { id: `m${this.seq++}`, status: 'waiting', position: this.waiting + 1, text: t, from: { username: this.hooks.username() ?? 'visitor', admin }, postedTick: this.hooks.tick() };
    this.mailbox.push(m);
    this.lastPostAt = performance.now();
    return this.later({ ...m });
  }
  async deleteMail(mailId: string) {
    this.need('admin');
    const m = this.mailbox.find((x) => x.id === mailId);
    if (m) m.status = 'deleted';
    let pos = 1;
    for (const x of this.mailbox) if (x.status === 'waiting') x.position = pos++;
  }
}

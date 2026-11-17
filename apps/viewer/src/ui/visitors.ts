/**
 * Visitor views shown in the inspector (or the phone drawer): the item card, the airdrop flow
 * and the mailbox. Plain accessible HTML; the plan only draws (items, placement preview, flag).
 */
import type { ViewerStore } from '../client/store.ts';
import type { VisitorStore } from '../client/visitors.ts';
import { iconSvg } from '../icons/render.ts';
import { VisitorError, type AuthState, type CatalogBlock, type CatalogItem, type MailStatus, type Vec2 } from '../types.ts';
import { clockOf, durationText, esc } from './format.ts';

export interface VisitorUiHost {
  store: ViewerStore;
  visitors: VisitorStore;
  auth(): AuthState | null;
  enabledItems(): Promise<string[] | null>;
  signIn(): void;
  /** Placement on the plan: start, clear, and be told about taps. */
  startPlacing(item: CatalogItem, onPlace: (tile: Vec2) => void): void;
  stopPlacing(): void;
  setPlaceAt(tile: Vec2 | null): void;
  /** Phone: show enough of the plan to place an item. */
  revealPlan(): void;
  focusDrop(dropId: string | null): void;
  close(): void;
}

const NEED_LABEL: Record<string, string> = { energy: 'battery' };
const colName = (i: number) => String.fromCharCode(65 + i);
const tileName = (p: Vec2) => `${colName(p.x)}${p.y + 1}`;

/** What an item does, in plain words, from its behaviour blocks. */
export function describeItem(item: CatalogItem): string[] {
  const out: string[] = [];
  const signed = (v: number) => `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`;
  const range = (r: unknown) => (typeof r === 'number' ? (r === 0 ? ' (standing on it)' : ` (from up to ${r} tile${r === 1 ? '' : 's'} away)`) : '');
  for (const b of item.behaviours as CatalogBlock[]) {
    switch (b.block) {
      case 'affectsNeeds': {
        const needs = Object.entries((b['needs'] ?? {}) as Record<string, number>)
          .map(([k, v]) => `${signed(v)} ${NEED_LABEL[k] ?? k}`)
          .join(', ');
        const dur = typeof b['durationSeconds'] === 'number' ? ` over ${b['durationSeconds']} s` : '';
        out.push(`“${b['verb']}” it${range(b['range'])}: ${needs}${dur}. The robot notices “${b['observation']}”.`);
        break;
      }
      case 'makesNoise':
        out.push(`“${b['verb']}” it${range(b['range'])}: it plays ${((b['notes'] ?? []) as string[]).join(' · ')}.`);
        break;
      case 'portable':
        out.push('Can be picked up, carried and dropped.');
        break;
      case 'consumable':
        out.push(`Used up after ${b['uses']} use${b['uses'] === 1 ? '' : 's'} of any verb.`);
        break;
      case 'inert':
        out.push('Does nothing when used.');
        break;
      default:
        out.push(`${b.block} (a block this viewer doesn’t describe yet).`);
    }
  }
  if (item.portable && !item.behaviours.some((b) => b.block === 'portable')) out.push('Can be picked up, carried and dropped.');
  out.push(item.tags.length ? `The robot sees only a thing tagged ${item.tags.join(', ')}, and learns the rest by trying.` : 'The robot sees only a thing, and learns the rest by trying.');
  return out;
}

const sentence = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : t);

function errorText(e: unknown): string {
  if (e instanceof VisitorError) {
    e.message = sentence(e.message);
    if (e.status === 401) return 'Sign in to do that.';
    if (e.status === 403) return e.message || 'You can’t do that here.';
    if (e.status === 429 && e.retryAfterSeconds && !/\d/.test(e.message)) return `${e.message} Try again in ${e.retryAfterSeconds} s.`;
    return e.message;
  }
  return (e as Error).message ?? String(e);
}

/* ------------------------------------------------------------------ item card */

export function itemCard(host: VisitorUiHost, dropId: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'item-card';
  el.innerHTML = `<p class="hint">Loading…</p>`;
  const w = host.store.world!;
  const render = async () => {
    let detail;
    try {
      detail = await host.visitors.api!.airdrop(dropId);
    } catch (e) {
      el.innerHTML = `<p class="field-error">${esc(errorText(e))}</p>`;
      return;
    }
    const item = detail.item;
    const ck = (t: number) => clockOf(t, w.clock);
    const at = (t: number) => `day ${ck(t).day}, ${ck(t).time}`;
    const left = detail.expiresTick !== undefined ? detail.expiresTick - w.clock.tick : null;
    const admin = host.auth()?.role === 'admin';
    const beliefs = detail.beliefs.length
      ? detail.beliefs
          .map((b) => `<li><span class="who">${esc(host.store.nameOf(b.characterId))}</span> “${esc(b.text)}” <span class="sub">${Math.round(b.firmness * 100)}% firm${b.firmness < 0.35 ? ' · a hunch' : ''}</span></li>`)
          .join('')
      : `<li class="nil">No belief yet. It hasn’t worked out what this does.</li>`;
    el.innerHTML = `
      <div class="item-head">${iconSvg(item.icon, 64, `${item.name} icon`)}<div><p class="item-name">${esc(item.name)}</p><p class="item-desc">${esc(item.description)}</p></div></div>
      <table class="schedule spec-table">
        <caption class="sr-only">About this item</caption>
        <tbody>
          <tr><th scope="row">Dropped by</th><td>${esc(detail.droppedBy.username)}${detail.droppedBy.admin ? ' <span class="role-chip">admin</span>' : ''}</td></tr>
          <tr><th scope="row">Dropped</th><td>${at(detail.droppedTick)} · at ${tileName(detail.pos)}</td></tr>
          <tr><th scope="row">Expires</th><td>${left === null ? 'Never' : left <= 0 ? 'Now' : `in ${durationText(left * w.clock.secondsPerTick)} (${at(detail.expiresTick!)})`}</td></tr>
          ${detail.usesLeft !== undefined ? `<tr><th scope="row">Uses left</th><td>${detail.usesLeft}</td></tr>` : ''}
        </tbody>
      </table>
      <div class="item-compare">
        <section aria-labelledby="does-h"><h3 id="does-h" class="draft-h">What it does</h3><ul class="plain-list">${describeItem(item).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>
        <section aria-labelledby="thinks-h"><h3 id="thinks-h" class="draft-h">What the robot believes</h3><ul class="plain-list">${beliefs}</ul></section>
      </div>
      <div class="card-actions">
        <button type="button" class="btn ghost" data-act="json" aria-expanded="false" aria-controls="item-json">View JSON</button>
        ${admin ? `<button type="button" class="btn danger" data-act="delete">Delete item</button>` : ''}
      </div>
      <pre class="json-view" id="item-json" hidden>${esc(JSON.stringify(item, null, 2))}</pre>
      <p class="field-error" data-ref="card-error" role="alert" hidden></p>`;
  };
  el.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!b) return;
    if (b.dataset['act'] === 'json') {
      const pre = el.querySelector<HTMLElement>('#item-json')!;
      pre.hidden = !pre.hidden;
      b.setAttribute('aria-expanded', String(!pre.hidden));
      b.textContent = pre.hidden ? 'View JSON' : 'Hide JSON';
    }
    if (b.dataset['act'] === 'delete') {
      if (b.dataset['confirm'] !== '1') {
        b.dataset['confirm'] = '1';
        b.textContent = 'Confirm delete';
        return;
      }
      try {
        await host.visitors.api!.removeDrop(dropId);
        await host.visitors.refresh();
        host.close();
      } catch (err) {
        const p = el.querySelector<HTMLElement>('[data-ref="card-error"]')!;
        p.textContent = errorText(err);
        p.hidden = false;
      }
    }
  });
  host.focusDrop(dropId);
  void render();
  return el;
}

/* ------------------------------------------------------------------ airdrop flow */

export function airdropFlow(host: VisitorUiHost): HTMLElement {
  const el = document.createElement('div');
  el.className = 'airdrop-flow';
  let picked: CatalogItem | null = null;
  let spot: Vec2 | null = null;
  let error = '';
  let done = '';
  let busy = false;
  const w = () => host.store.world!;

  const canDrop = () => {
    const r = host.auth()?.role;
    return r === 'visitor' || r === 'admin';
  };

  const draw = async () => {
    if (!canDrop()) {
      const a = host.auth();
      el.innerHTML = `<p>Signed-in visitors can drop items into this world for the robots to find.</p>
        ${a?.loginAvailable ? `<button type="button" class="btn" data-act="signin">Sign in to airdrop</button>` : `<p class="hint">Sign in to airdrop. This server has no sign-in configured; ask the owner for a visitor key.</p>`}`;
      return;
    }
    if (done) {
      el.innerHTML = `<p class="ok-note" role="status">${esc(done)}</p>
        <div class="card-actions"><button type="button" class="btn" data-act="again">Drop another</button><button type="button" class="btn ghost" data-act="close">Done</button></div>`;
      return;
    }
    if (!picked) {
      const enabled = await host.enabledItems();
      const items = host.visitors.catalogue.filter((i) => !i.disabled && (!enabled || enabled.includes(i.id)));
      el.innerHTML = items.length
        ? `<fieldset class="item-pick"><legend class="draft-label-legend">Choose an item</legend>
            ${items
              .map(
                (i) => `<label class="pick-row"><input type="radio" name="pick" value="${esc(i.id)}">${iconSvg(i.icon, 32)}<span><span class="item-name">${esc(i.name)}</span><span class="sub">${esc(i.description)}</span></span></label>`,
              )
              .join('')}
          </fieldset>
          <div class="card-actions"><button type="button" class="btn" data-act="next" disabled>Choose a spot</button></div>`
        : `<p class="hint">${host.visitors.unavailable ? esc(host.visitors.unavailable) : 'No items are enabled for airdrops in this world.'}</p>`;
      return;
    }
    const W = w().map.width;
    const H = w().map.height;
    const cols = Array.from({ length: W }, (_, i) => `<option value="${i}"${spot?.x === i ? ' selected' : ''}>${colName(i)}</option>`).join('');
    const rows = Array.from({ length: H }, (_, i) => `<option value="${i}"${spot?.y === i ? ' selected' : ''}>${i + 1}</option>`).join('');
    el.innerHTML = `
      <div class="item-head">${iconSvg(picked.icon, 40)}<div><p class="item-name">${esc(picked.name)}</p><p class="sub">${esc(picked.description)}</p></div></div>
      <p>Tap a spot on the plan, or pick a tile here. It lands on the nearest free tile.</p>
      <div class="tile-pick" role="group" aria-label="Drop spot">
        <label>Column <select data-ref="col"><option value="">–</option>${cols}</select></label>
        <label>Row <select data-ref="row"><option value="">–</option>${rows}</select></label>
      </div>
      <p class="field-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p>
      <div class="card-actions">
        <button type="button" class="btn" data-act="confirm" ${spot && !busy ? '' : 'disabled'}>${busy ? 'Dropping…' : spot ? `Drop at ${tileName(spot)}` : 'Drop here'}</button>
        <button type="button" class="btn ghost" data-act="back">Pick another item</button>
      </div>`;
  };

  const setSpot = (t: Vec2 | null) => {
    spot = t;
    error = '';
    host.setPlaceAt(t);
    void draw();
  };

  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.name === 'pick') el.querySelector<HTMLButtonElement>('[data-act="next"]')!.disabled = false;
    if (t.dataset['ref'] === 'col' || t.dataset['ref'] === 'row') {
      const c = el.querySelector<HTMLSelectElement>('[data-ref="col"]')!.value;
      const r = el.querySelector<HTMLSelectElement>('[data-ref="row"]')!.value;
      if (c !== '' && r !== '') setSpot({ x: Number(c), y: Number(r) });
    }
  });
  el.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!b) return;
    const act = b.dataset['act'];
    if (act === 'signin') host.signIn();
    if (act === 'close') host.close();
    if (act === 'again') {
      done = '';
      picked = null;
      spot = null;
      void draw();
    }
    if (act === 'next') {
      const id = el.querySelector<HTMLInputElement>('input[name="pick"]:checked')?.value;
      picked = host.visitors.catalogue.find((i) => i.id === id) ?? null;
      if (!picked) return;
      host.startPlacing(picked, (t) => setSpot(t));
      host.revealPlan();
      void draw();
    }
    if (act === 'back') {
      picked = null;
      spot = null;
      error = '';
      host.stopPlacing();
      void draw();
    }
    if (act === 'confirm' && picked && spot && !busy) {
      busy = true;
      void draw();
      try {
        const d = await host.visitors.api!.drop(picked.id, spot);
        done = `${picked.name} dropped at ${tileName(d.pos)}${d.pos.x !== spot.x || d.pos.y !== spot.y ? ' (the nearest free tile)' : ''}.`;
        host.stopPlacing();
        await host.visitors.refresh();
      } catch (err) {
        error = errorText(err);
      }
      busy = false;
      void draw();
    }
  });
  void draw();
  return el;
}

/* ------------------------------------------------------------------ mailbox */

const MAX = 280;

export function mailView(host: VisitorUiHost): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mail-view';
  let draft = '';
  let error = '';
  let ok = '';
  let busy = false;

  const statusText = (m: MailStatus) => {
    const w = host.store.world!;
    const at = (t: number) => {
      const c = clockOf(t, w.clock);
      return `day ${c.day}, ${c.time}`;
    };
    switch (m.status) {
      case 'waiting':
        return `Waiting${m.position ? ` · ${m.position === 1 ? 'next to be read' : `number ${m.position} in line`}` : ''}`;
      case 'read':
        return `Read ${m.readTick !== undefined ? at(m.readTick) : ''}`;
      case 'expired':
        return 'Expired before it was read';
      case 'deleted':
        return 'Deleted by an admin';
    }
  };
  const row = (m: MailStatus, admin: boolean) => `<li class="mail-row status-${m.status}">
      <p class="mail-meta"><span class="mail-status">${esc(statusText(m))}</span> · from ${esc(m.from.username)}${m.from.admin ? ' <span class="role-chip">admin</span>' : ''}</p>
      ${m.text ? `<p class="mail-text">“${esc(m.text)}”</p>` : ''}
      ${m.reaction ? `<p class="mail-reaction">The robot’s reaction: ${esc(m.reaction.summary)}${m.reaction.notes?.length ? ` <span class="notes">${esc(m.reaction.notes.join(' · '))}</span>` : ''}</p>` : ''}
      ${admin && m.status === 'waiting' ? `<button type="button" class="btn ghost danger-text" data-act="delete" data-id="${esc(m.id)}">Delete</button>` : ''}
    </li>`;

  const draw = () => {
    const a = host.auth();
    const can = a?.role === 'visitor' || a?.role === 'admin';
    const admin = a?.role === 'admin';
    const m = host.visitors.mail;
    const waiting = m?.waiting ?? 0;
    const focus = (document.activeElement as HTMLElement | null)?.dataset?.['ref'];
    el.innerHTML = `
      <p class="mail-count">${waiting === 0 ? 'No mail waiting.' : `${waiting} message${waiting === 1 ? '' : 's'} waiting.`} The robot reads the oldest one each time it opens the box.</p>
      ${
        can
          ? `<form class="composer" data-ref="composer">
              <label for="mail-text" class="draft-label-legend">Post a message</label>
              <textarea id="mail-text" data-ref="text" rows="4" maxlength="${MAX}" aria-describedby="mail-count-left mail-help">${esc(draft)}</textarea>
              <p class="composer-foot"><span id="mail-help" class="sub">The robot reads it as a note from a stranger, and answers only with noises and behaviour.</span>
                <span id="mail-count-left" class="counter" aria-live="polite">${draft.length} / ${MAX}</span></p>
              <p class="field-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p>
              <p class="ok-note" role="status" ${ok ? '' : 'hidden'}>${esc(ok)}</p>
              <div class="card-actions"><button type="submit" class="btn" ${busy || !draft.trim() ? 'disabled' : ''}>${busy ? 'Posting…' : 'Post message'}</button></div>
            </form>`
          : `<p>${a?.loginAvailable ? `<button type="button" class="btn" data-act="signin">Sign in to post</button>` : 'Sign in as a visitor to post messages.'}</p>`
      }
      ${m?.mine ? `<section aria-labelledby="mine-h"><h3 id="mine-h" class="draft-h">My mail</h3>${m.mine.length ? `<ul class="mail-list">${m.mine.map((x) => row(x, false)).join('')}</ul>` : '<p class="hint">You haven’t posted anything here yet.</p>'}</section>` : ''}
      ${admin && m?.all ? `<section aria-labelledby="all-h"><h3 id="all-h" class="draft-h">All mail (admin)</h3>${m.all.length ? `<ul class="mail-list">${m.all.map((x) => row(x, true)).join('')}</ul>` : '<p class="hint">Nothing waiting.</p>'}</section>` : ''}
      ${host.visitors.unavailable ? `<p class="hint">${esc(host.visitors.unavailable)}</p>` : ''}`;
    if (focus === 'text') {
      const t = el.querySelector<HTMLTextAreaElement>('[data-ref="text"]');
      t?.focus();
      t?.setSelectionRange(draft.length, draft.length);
    }
  };

  el.addEventListener('input', (e) => {
    const t = e.target as HTMLTextAreaElement;
    if (t.dataset['ref'] !== 'text') return;
    draft = t.value;
    ok = '';
    el.querySelector<HTMLElement>('.counter')!.textContent = `${draft.length} / ${MAX}`;
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = busy || !draft.trim();
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !draft.trim()) return;
    busy = true;
    error = '';
    draw();
    try {
      const m = await host.visitors.api!.postMail(draft);
      ok = `Posted. ${m.position ? (m.position === 1 ? 'It’s next in line.' : `It’s number ${m.position} in line.`) : ''}`;
      draft = '';
      await host.visitors.refresh();
    } catch (err) {
      error = errorText(err);
    }
    busy = false;
    draw();
  });
  el.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!b) return;
    if (b.dataset['act'] === 'signin') host.signIn();
    if (b.dataset['act'] === 'delete') {
      try {
        await host.visitors.api!.deleteMail(b.dataset['id']!);
        await host.visitors.refresh();
      } catch (err) {
        error = errorText(err);
      }
      draw();
    }
  });
  const off = host.visitors.on(() => {
    if (!el.isConnected) return off();
    if (!busy && !(el.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA')) draw();
  });
  draw();
  return el;
}

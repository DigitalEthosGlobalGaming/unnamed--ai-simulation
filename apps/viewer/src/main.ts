import '@fontsource/overpass/500.css';
import '@fontsource/overpass/600.css';
import '@fontsource/overpass/700.css';
import '@fontsource/atkinson-hyperlegible-next/400.css';
import '@fontsource/atkinson-hyperlegible-next/700.css';
import './styles.css';
import dotFontUrl from '@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-700-normal.woff2?url';

import { SampleServer } from './sample/server.ts';
import { RealConnection } from './source/real.ts';
import type { WorldConnection } from './types.ts';
import { TICKS_PER_DAY, TICKS_PER_HOUR, type Scenario } from './sample/sim.ts';
import { ViewerStore } from './client/store.ts';
import { Scene } from './scene/scene.ts';
import { Panel } from './ui/panel.ts';
import { Timeline } from './ui/timeline.ts';
import { NoisePlayer } from './ui/audio.ts';
import { icons } from './ui/icons.ts';
import { clockOf, esc, fmtAud, fmtTick } from './ui/format.ts';
import { legendHtml } from './ui/legend.ts';
import { SettingsView } from './ui/settings.ts';
import type { AuthState, Vec2 } from './types.ts';
import { VisitorStore } from './client/visitors.ts';
import { airdropFlow, itemCard, mailView, type VisitorUiHost } from './ui/visitors.ts';
import { CataloguePage, withParam } from './ui/catalogue.ts';
import { objectCard } from './ui/objects.ts';
import { PromptsPage } from './ui/prompts.ts';

/* Data source: the real server by default (via `@uas/client`; `?world=<id>`, `?key=<api key>`),
   or the offline sample with `?source=sample`.
   Sample-only switches: ?scenario=empty|lowbattery &state=disconnected.
   Viewer switches: ?select=<id> &drawer=closed|peek|full &at=<tick> &view=x,y,zoom &tab=beliefs &legend=0|1
   Visitor views: ?open=airdrop|mail|drop:<dropId> ; the admin catalogue: ?page=catalogue[&item=<id>] */
const params = new URLSearchParams(location.search);
const sample = params.get('source') === 'sample';
const scenario = (['empty', 'lowbattery'].includes(params.get('scenario') ?? '') ? params.get('scenario') : 'default') as Scenario;

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="shell" data-mode="live">
    <a class="skip" href="#panel">Skip to inspector</a>
    <header class="topbar">
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><rect x="5" y="7" width="22" height="18" rx="6" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="21" cy="16" r="3" fill="currentColor"/></svg>
        <span class="product">Unnamed AI Simulation</span>
        <span class="crumb" data-ref="crumb"></span>
      </div>
      <div class="compact-title" aria-hidden="true">
        <span class="ct-world" data-ref="ct-world"></span>
        <span class="ct-clock" data-ref="ct-clock"></span>
      </div>
      <div class="top-actions">
        <span class="status" role="status" data-ref="status"></span>
        ${sample ? '<span class="sim-note" title="Offline sample: this world is generated in the browser">Simulated data</span>' : ''}
        <button type="button" class="btn ghost" data-ref="drop-btn">${icons.airdrop()}<span class="btn-text">Airdrop</span></button>
        <button type="button" class="btn ghost" data-ref="mail-btn" aria-label="Mailbox">${icons.mail()}<span class="btn-text">Mail</span><span class="btn-count" data-ref="mail-count" hidden></span></button>
        <a class="btn ghost" data-ref="cat-btn" hidden>${icons.catalogue()}<span class="btn-text">Catalogue</span></a>
        <a class="btn ghost" data-ref="prompts-btn" hidden>${icons.prompts()}<span class="btn-text">Prompts</span></a>
        <div class="account" data-ref="account"></div>
        <button type="button" class="btn ghost" data-ref="legend-btn" aria-pressed="false" aria-controls="legend">${icons.legend()}<span class="btn-text">Legend</span></button>
        <button type="button" class="btn ghost" data-ref="sound-btn" aria-pressed="false">${icons.soundOff()}<span class="btn-text">Sound off</span></button>
      </div>
    </header>
    <p class="archived-banner" data-ref="archived" role="status" hidden>${icons.revision()}<span><strong>Archived world · read only.</strong> Nothing new happens here; scrub the timeline and read the brain feed to look back.</span></p>
    <main class="workspace">
      <section class="sheet-col" aria-label="World plan">
        <div class="sheet" data-ref="sheet" tabindex="0" role="region" aria-label="World plan" aria-describedby="plan-keys">
          <p class="sr-only" data-ref="scene-desc" aria-live="off"></p>
          <p class="sr-only" id="plan-keys">Drag to pan, scroll or pinch to zoom. With the plan focused: plus and minus zoom, arrow keys pan, 0 fits the whole sheet.</p>
          <div class="cam" role="group" aria-label="Camera" data-ref="cam">
            <button type="button" class="btn icon-only" data-cam="in" aria-label="Zoom in" title="Zoom in (+)">${icons.zoomIn()}</button>
            <button type="button" class="btn icon-only" data-cam="out" aria-label="Zoom out" title="Zoom out (−)">${icons.zoomOut()}</button>
            <button type="button" class="btn icon-only" data-cam="fit" aria-label="Fit sheet" title="Fit sheet (0)">${icons.fit()}</button>
            <button type="button" class="btn icon-only" data-cam="follow" aria-pressed="false" aria-label="Follow selected robot" title="Follow selected robot">${icons.follow()}</button>
          </div>
          <div class="stamp" data-ref="stamp" hidden></div>
          <div class="sheet-message" data-ref="message" hidden></div>
          <aside class="legend" id="legend" aria-label="Legend" hidden>${legendHtml()}</aside>
          <div class="title-block" data-ref="title-block" aria-label="Title block"></div>
        </div>
        <div class="timeline-home" data-ref="timeline-home"></div>
      </section>
      <aside class="panel" id="panel" tabindex="-1" aria-label="Inspector" data-drawer="peek">
        <div class="drawer-top">
          <button type="button" class="drawer-handle" data-ref="handle" aria-expanded="false" aria-controls="panel-body">
            <span class="grip" aria-hidden="true"></span>
            <span class="handle-text" data-ref="handle-text">Inspector</span>
            <span class="handle-icon" data-ref="handle-icon">${icons.chevronUp()}</span>
          </button>
          <div class="timeline-drawer" data-ref="timeline-drawer"></div>
        </div>
        <div class="panel-body" id="panel-body" data-ref="panel-body"></div>
      </aside>
    </main>
    <main class="catalogue-page" data-ref="catalogue-page" aria-labelledby="cat-h" hidden>
      <a class="btn ghost back-link" data-ref="cat-back">${icons.back()}<span>Back to the plan</span></a>
    </main>
    <main class="catalogue-page prompts-page" data-ref="prompts-page" aria-labelledby="pr-h" hidden>
      <a class="btn ghost back-link" data-ref="prompts-back">${icons.back()}<span>Back to the plan</span></a>
    </main>
  </div>`;

const $ = <T extends HTMLElement = HTMLElement>(r: string) => app.querySelector<T>(`[data-ref="${r}"]`)!;
const shell = app.querySelector<HTMLElement>('.shell')!;
const legend = app.querySelector<HTMLElement>('#legend')!;

const server: WorldConnection = sample
  ? new SampleServer({
      scenario,
      seed: 7,
      startTick: 3 * TICKS_PER_DAY + 15 * TICKS_PER_HOUR + 8 * 10,
      ...(params.get('state') === 'disconnected' ? { disconnectAfterMs: 1200 } : {}),
      ...(params.get('archived') === '1' && { archived: true }),
    })
  : new RealConnection({
      baseUrl: import.meta.env.VITE_UAS_API ?? '/api',
      ...(params.get('key') && { apiKey: params.get('key')! }),
      ...(params.get('world') && { worldId: params.get('world')! }),
    });
const store = new ViewerStore(server);
const settingsView = new SettingsView(server.account);
const panel = new Panel($('panel-body'), store, settingsView);
const visitorStore = new VisitorStore(server.visitors);
settingsView.catalogue = () => visitorStore.catalogue;
panel.visitors = visitorStore;
const timeline = new Timeline(store);
const audio = new NoisePlayer();
const phoneMq = window.matchMedia('(max-width: 719px)');

/* ------------------------------------------------------------ scene */

const scene = new Scene($('sheet'), store);
scene.visitors = visitorStore;
scene.onSelect = (id) => {
  if (id && panel.openView) panel.closeView();
  store.select(id);
  if (id && phoneMq.matches && drawer === 'closed') setDrawer('peek');
};
// Overpass's middle dot sits hard against the next letter; borrow Atkinson's for U+00B7 only.
{
  const dot = new FontFace('Draft Dot', `url(${dotFontUrl})`, { unicodeRange: 'U+00B7', weight: '100 900' });
  document.fonts.add(await dot.load());
}
await Promise.all(['500', '600', '700'].map((w) => document.fonts.load(`${w} 13px "Overpass"`)));
await scene.init();
(window as unknown as { __uas: unknown }).__uas = { scene, store };

/* ----------------------------------------------------------- camera */

const camEl = $('cam');
const followBtn = camEl.querySelector<HTMLButtonElement>('[data-cam="follow"]')!;
camEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cam]');
  if (!b) return;
  const a = b.dataset['cam'];
  if (a === 'in') scene.zoomBy(1.5);
  if (a === 'out') scene.zoomBy(1 / 1.5);
  if (a === 'fit') scene.fit();
  if (a === 'follow') scene.setFollow(!scene.follow);
});
scene.onRevision = (key, id) => {
  // A red-pen note on the plan opens its brain-feed revision row.
  store.select(id);
  store.setHighlight(key, true);
  if (phoneMq.matches && drawer !== 'full') setDrawer('full');
  setTimeout(() => app.querySelector<HTMLElement>('#tab-feed[aria-selected="false"]')?.click(), 50);
};
scene.onFollowChange = (on) => followBtn.setAttribute('aria-pressed', String(on));
scene.onViewChange = () => {
  const cell = app.querySelector<HTMLElement>('[data-tb="scale"]');
  if (cell) cell.textContent = scene.scaleText();
};
const sheetEl = $('sheet');
sheetEl.addEventListener('keydown', (e) => {
  if (e.target !== sheetEl || e.altKey || e.ctrlKey || e.metaKey) return;
  const step = 80;
  const k = e.key;
  if (k === '+' || k === '=') scene.zoomBy(1.5);
  else if (k === '-' || k === '_') scene.zoomBy(1 / 1.5);
  else if (k === '0') scene.fit();
  else if (k === 'ArrowLeft') scene.panBy(step, 0);
  else if (k === 'ArrowRight') scene.panBy(-step, 0);
  else if (k === 'ArrowUp') scene.panBy(0, step);
  else if (k === 'ArrowDown') scene.panBy(0, -step);
  else return;
  e.preventDefault();
});
{
  const v = params.get('view')?.split(',').map(Number);
  if (v && v.length === 3 && v.every((n) => Number.isFinite(n))) scene.setView(v[0]!, v[1]!, v[2]!);
}

/* ------------------------------------------------------------ drawer */

type Drawer = 'closed' | 'peek' | 'full';
let drawer: Drawer = (['closed', 'peek', 'full'].includes(params.get('drawer') ?? '') ? params.get('drawer') : 'peek') as Drawer;
const panelEl = app.querySelector<HTMLElement>('.panel')!;

function setDrawer(d: Drawer) {
  drawer = d;
  panelEl.dataset['drawer'] = d;
  const handle = $('handle');
  handle.setAttribute('aria-expanded', String(d === 'full'));
  $('handle-icon').innerHTML = d === 'full' ? icons.chevronDown() : icons.chevronUp();
  handle.setAttribute('aria-label', d === 'full' ? 'Collapse inspector' : d === 'peek' ? 'Expand inspector' : 'Show inspector');
  layoutInsets();
}
$('handle').addEventListener('click', () => setDrawer(drawer === 'closed' ? 'peek' : drawer === 'peek' ? 'full' : 'closed'));

// Drag the handle to move between the three positions.
{
  let startY = 0;
  let moved = false;
  const handle = $('handle');
  handle.addEventListener('pointerdown', (e) => {
    if (!phoneMq.matches) return;
    startY = e.clientY;
    moved = false;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (startY && Math.abs(e.clientY - startY) > 12) moved = true;
  });
  handle.addEventListener('pointerup', (e) => {
    if (!phoneMq.matches || !startY) return;
    const dy = e.clientY - startY;
    startY = 0;
    if (!moved) return;
    e.preventDefault();
    const order: Drawer[] = ['closed', 'peek', 'full'];
    const i = order.indexOf(drawer) + (dy < 0 ? 1 : -1);
    setDrawer(order[Math.max(0, Math.min(2, i))]!);
    handle.addEventListener('click', (ev) => ev.stopImmediatePropagation(), { once: true, capture: true });
  });
}

function placeTimeline() {
  const target = phoneMq.matches ? $('timeline-drawer') : $('timeline-home');
  if (timeline.el.parentElement !== target) target.appendChild(timeline.el);
  layoutInsets();
}

function layoutInsets() {
  const sheet = $('sheet').getBoundingClientRect();
  const cam = $('cam').getBoundingClientRect();
  // Camera buttons plus room above them for the north arrow.
  // Camera buttons plus the north arrow drawn just above them.
  scene.setReserved([{ x: cam.left - sheet.left - 24, y: cam.top - sheet.top - 40, w: cam.width + 28, h: cam.height + 44 }]);
  const right = sheet.right - cam.left + 6;
  if (phoneMq.matches) {
    const top = panelEl.querySelector<HTMLElement>('.drawer-top')!.getBoundingClientRect().height;
    const peek = drawer === 'closed' ? top : peekHeight();
    const stamp = $('stamp');
    const stampH = stamp.hidden ? 0 : stamp.getBoundingClientRect().bottom - sheet.top + 6;
    scene.setInsets({ top: Math.max(4, stampH), right: right - 18, bottom: peek, left: 0 });
    panelEl.style.setProperty('--drawer-closed', `${Math.round(top)}px`);
    panelEl.style.setProperty('--drawer-peek', `${Math.round(peekHeight())}px`);
  } else {
    let top = $('title-block').getBoundingClientRect().top;
    if (!legend.hidden) top = Math.min(top, legend.getBoundingClientRect().top);
    scene.setInsets({ top: 0, right, bottom: Math.max(0, sheet.bottom - top) + 6, left: 0 });
  }
}

// Re-fit whenever anything that frames the plan changes size (fonts, legend, stamp, drawer).
{
  let queued = false;
  const ro = new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      layoutInsets();
    });
  });
  for (const el of [$('sheet'), $('title-block'), legend, $('stamp'), $('cam'), panelEl.querySelector('.drawer-top')!, $('panel-body')]) ro.observe(el);
}

function peekHeight(): number {
  const top = panelEl.querySelector<HTMLElement>('.drawer-top')!.getBoundingClientRect().height;
  const peekEl = panelEl.querySelector<HTMLElement>('.peek');
  const h = peekEl ? peekEl.getBoundingClientRect().height : 160;
  return Math.min(top + h + 4, window.innerHeight * 0.42);
}

phoneMq.addEventListener('change', placeTimeline);
window.addEventListener('resize', layoutInsets);
placeTimeline();
setDrawer(drawer);

/* -------------------------------------------------------- account */

// Sign in with Vercel (when the server offers it), who is signed in and their role; `?key=` still works.
let auth: AuthState | null = null;
const accountEl = $('account');
function renderAccount() {
  if (!auth) {
    accountEl.innerHTML = '';
    return;
  }
  const u = auth.user;
  const authError = params.get('authError');
  const failed = authError && !u ? `<span class="auth-error" role="alert">Sign-in failed: ${esc(authError)}</span>` : '';
  if (!u) {
    // Signed in by API key (?key=): no user, but say which role the key carries.
    const keyRole = auth.role !== 'spectator' ? `<span class="role-chip" title="Access by API key">${esc(auth.role)} · key</span>` : '';
    accountEl.innerHTML = failed + keyRole + (auth.loginAvailable
      ? `<button type="button" class="btn" data-acct="login" aria-label="Sign in with Vercel">${icons.vercel()}<span class="btn-text">Sign in with Vercel</span></button>`
      : '');
    return;
  }
  const initials = u.name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
  const face = u.avatarUrl ? `<img class="acct-avatar" src="${esc(u.avatarUrl)}" alt="" width="28" height="28" referrerpolicy="no-referrer">` : `<span class="acct-avatar acct-initials" aria-hidden="true">${esc(initials)}</span>`;
  accountEl.innerHTML = `<span class="acct-who" title="${esc(u.email)}">${face}<span class="acct-name">${esc(u.name)}</span><span class="role-chip">${esc(auth.role)}</span></span>
    <button type="button" class="btn ghost acct-out" data-acct="logout">Sign out</button>`;
}
async function loadAuth() {
  if (!server.account) return;
  try {
    auth = await server.account.me();
  } catch {
    auth = null;
  }
  renderAccount();
  settingsView.setAuth(auth);
  catPage.setAuth(auth);
  promptsPage.setAuth(auth);
  syncTopButtons();
  void visitorStore.refresh();
}
async function signOut() {
  await server.account?.logout().catch(() => {});
  await loadAuth();
}
settingsView.onSignOut = () => void signOut();
accountEl.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-acct]');
  if (!t) return;
  if (t.dataset['acct'] === 'login') server.account?.login(location.href);
  if (t.dataset['acct'] === 'logout') void signOut();
});
void loadAuth();

/* ------------------------------------------------------ top actions */

const legendBtn = $('legend-btn');
function setLegend(on: boolean) {
  legend.hidden = !on;
  legendBtn.setAttribute('aria-pressed', String(on));
  layoutInsets();
}
setLegend(params.has('legend') ? params.get('legend') === '1' : !phoneMq.matches);
legendBtn.addEventListener('click', () => setLegend(legend.hidden));

const soundBtn = $('sound-btn');
soundBtn.addEventListener('click', async () => {
  if (audio.enabled) audio.disable();
  else await audio.enable();
  soundBtn.setAttribute('aria-pressed', String(audio.enabled));
  soundBtn.innerHTML = `${audio.enabled ? icons.soundOn() : icons.soundOff()}<span class="btn-text">${audio.enabled ? 'Sound on' : 'Sound off'}</span>`;
});

store.onNoise((n) => {
  const w = store.world;
  if (!w) return;
  const pan = (n.pos.x / w.map.width) * 2 - 1;
  const sel = store.character(store.selectedId);
  const gain = sel ? Math.max(0.15, 1 - Math.hypot(sel.pos.x - n.pos.x, sel.pos.y - n.pos.y) / 14) : 0.7;
  audio.play(n.notes, pan, gain);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && store.selectedId) store.select(null);
});

$('message').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-action="reconnect"]')) store.reconnect();
});

/* ----------------------------------------------------------- render */

let lastPanel = 0;
let trailing: number | undefined;
let lastSel: string | null | undefined;
function render() {
  const w = store.world;
  shell.dataset['mode'] = store.mode;
  shell.dataset['status'] = store.status;
  const status = $('status');
  status.className = `status is-${store.status === 'live' ? (store.archived && store.mode === 'live' ? 'replay' : store.mode) : store.status}`;
  // An archived world never moves on: its latest state isn't "live".
  status.textContent = store.status === 'connecting' ? 'Connecting' : store.status === 'disconnected' ? 'Disconnected' : store.mode === 'live' ? (store.archived ? 'Archived' : 'Live') : 'Replay';

  const now = performance.now();
  const selChanged = lastSel !== store.selectedId;
  if (!selChanged && now - lastPanel <= 200) {
    // Throttled: make sure a trailing update lands even if nothing else ticks (paused replay).
    if (trailing === undefined) trailing = window.setTimeout(() => ((trailing = undefined), render()), 220);
  } else {
    lastPanel = now;
    lastSel = store.selectedId;
    panel.update();
    timeline.update();
    if (selChanged && phoneMq.matches) requestAnimationFrame(layoutInsets);
    const sel = store.character(store.selectedId);
    $('handle-text').textContent = sel ? `${sel.name} · ${sel.mind.asleep ? 'standby' : sel.action?.verb ?? 'idle'}` : w ? `${w.characters.length} robots · brain feed` : 'Inspector';
  }
  if (!w) {
    showMessage(store.status === 'disconnected' ? disconnectedHtml() : `<p class="msg-title">Connecting…</p><p>${sample ? 'Starting the offline sample world.' : 'Loading the world, its packs and the latest snapshot from the server.'}</p>`);
    return;
  }
  const ck = clockOf(w.clock.tick, w.clock);
  $('ct-clock').textContent = `${ck.date || `Day ${ck.day}`} · ${ck.time}${sample ? ' · simulated' : ''}`;
  $('crumb').textContent = w.name;
  $('ct-world').textContent = w.name;
  document.title = `${w.name} — Unnamed AI Simulation`;
  const stampHtml =
    store.mode === 'replay'
      ? `<span class="stamp-main">Revision — tick ${fmtTick(w.clock.tick)}</span><span class="stamp-sub">Not live · day ${ck.day}, ${ck.time} · ${store.playing ? `replaying at ${store.speed}×` : 'paused'}</span>`
      : '';
  $('title-block').innerHTML = titleBlock(w.name, ck, w.clock.tick, w.spendTodayAud, w.capAud, stampHtml);
  // Phone has no title block on the sheet, so the stamp sits in the sheet margin above the plan.
  const stamp = $('stamp');
  const wasHidden = stamp.hidden;
  stamp.hidden = !stampHtml || !phoneMq.matches;
  if (!stamp.hidden) stamp.innerHTML = stampHtml;
  if (wasHidden !== stamp.hidden) layoutInsets();

  if (store.status === 'disconnected') showMessage(disconnectedHtml());
  else if (w.characters.length === 0 && w.objects.length === 0)
    showMessage(`<p class="msg-title">Nothing on this sheet yet</p><p>${esc(w.name)} is running, but it has no robots or objects. When something is spawned it will be drawn here.</p>`);
  else showMessage(null);

  $('scene-desc').textContent = w.characters.map((c) => `${c.name} at column ${String.fromCharCode(65 + Math.round(c.pos.x))}, row ${Math.round(c.pos.y) + 1}`).join('; ');
}

function disconnectedHtml() {
  const t = store.world ? `at tick ${fmtTick(store.tick)}` : '';
  const why = store.statusDetail ? ` (${esc(store.statusDetail)})` : '';
  const body = store.world ? 'The plan shows the last state received. Nothing new is arriving.' : `Could not reach the world server${why}. Start it with <code>npm start</code> at the repo root, or open <code>?source=sample</code> for the offline sample.`;
  return `<p class="msg-title red">${store.world ? `Connection lost ${t}` : 'No connection'}</p><p>${body}</p><button type="button" class="btn" data-action="reconnect">${icons.reconnect()}<span>Reconnect</span></button>`;
}

function showMessage(html: string | null) {
  const m = $('message');
  if (html === null) {
    m.hidden = true;
    m.dataset['k'] = '';
    return;
  }
  m.hidden = false;
  if (m.dataset['k'] !== html) {
    m.dataset['k'] = html;
    m.innerHTML = html;
  }
}

function titleBlock(name: string, ck: ReturnType<typeof clockOf>, tick: number, spend: number, cap: number | null, stamp: string) {
  const tod = ck.daylight ? `${icons.sun()}<span>Day</span>` : `${icons.moon()}<span>Night</span>`;
  return `${stamp ? `<div class="tb-stamp">${stamp}</div>` : ''}
    <div class="tb-cell tb-project"><span class="tb-k">Project</span><span class="tb-v">Unnamed AI Simulation</span></div>
    <div class="tb-cell tb-sheet"><span class="tb-k">Sheet · day</span><span class="tb-v tb-big">${ck.day}</span></div>
    <div class="tb-cell"><span class="tb-k">World</span><span class="tb-v">${esc(name)}</span></div>
    <div class="tb-cell"><span class="tb-k">In-world time</span><span class="tb-v tb-time">${ck.date ? `${ck.date} · ` : ''}${ck.time} <span class="tod">${tod}</span></span></div>
    <div class="tb-cell"><span class="tb-k">Tick</span><span class="tb-v">${fmtTick(tick)}</span></div>
    <div class="tb-cell"><span class="tb-k">Scale</span><span class="tb-v" data-tb="scale">${scene.scaleText()}</span></div>
    <div class="tb-cell"><span class="tb-k">Thinking today</span><span class="tb-v">${fmtAud(spend)} of ${fmtAud(cap)}</span></div>
    <div class="tb-cell"><span class="tb-k">Data</span><span class="tb-v">${sample ? 'Simulated sample' : 'Live server'}</span></div>`;
}

// Noise synthesis follows the world's archetype (pitches and synth settings from its pack).
let noisesConfigured = false;
store.on(() => {
  const cat = store.catalog;
  if (noisesConfigured || !cat) return;
  NoisePlayer.configure(cat.archetypes.find((a) => a.noises)?.noises);
  noisesConfigured = true;
});
store.on(render);
store.on(() => {
  syncTopButtons();
  promptsPage.worldChanged();
});
render();

/* --------------------------------------------------------- visitors */

// Airdrops, the mailbox and (admins) the catalogue. Views open in the inspector / phone drawer.
const dropBtn = $<HTMLButtonElement>('drop-btn');
const mailBtn = $<HTMLButtonElement>('mail-btn');
const catBtn = $<HTMLAnchorElement>('cat-btn');
const promptsBtn = $<HTMLAnchorElement>('prompts-btn');
const promptsPage = new PromptsPage(server.prompts, () => store.world?.name ?? 'this world');
$('prompts-page').append(promptsPage.el);
const catPage = new CataloguePage(visitorStore);
$('catalogue-page').append(catPage.el);
let enabledCache: { at: number; ids: string[] | null } | null = null;

const host: VisitorUiHost = {
  store,
  visitors: visitorStore,
  auth: () => auth,
  async enabledItems() {
    if (enabledCache && performance.now() - enabledCache.at < 10_000) return enabledCache.ids;
    let ids: string[] | null = null;
    try {
      const v = (await server.account?.settings())?.values['catalogEnabled'];
      ids = Array.isArray(v) && !v.includes('*') ? v : null; // `*` = every item
    } catch {
      ids = null;
    }
    enabledCache = { at: performance.now(), ids };
    return ids;
  },
  signIn: () => server.account?.login(location.href),
  startPlacing(item, onPlace) {
    scene.placing = { icon: item.icon, name: item.name };
    scene.placeAt = null;
    scene.onPlace = (t) => onPlace(t);
  },
  stopPlacing() {
    scene.placing = null;
    scene.placeAt = null;
    scene.onPlace = () => {};
  },
  setPlaceAt(t: Vec2 | null) {
    scene.placeAt = t;
  },
  revealPlan() {
    if (phoneMq.matches) setDrawer('peek');
  },
  focusDrop(id) {
    scene.focusDrop = id;
  },
  close: () => panel.closeView(),
};

function openVisitorView(key: string, title: string, el: HTMLElement, onClose?: () => void) {
  if (store.selectedId) store.select(null);
  panel.showView(key, title, el, () => {
    host.stopPlacing();
    scene.focusDrop = null;
    onClose?.();
    syncTopButtons();
  });
  if (phoneMq.matches && drawer !== 'full') setDrawer('full');
  syncTopButtons();
}
function openDrop(dropId: string) {
  openVisitorView(`drop:${dropId}`, 'Airdropped item', itemCard(host, dropId));
}
function openAirdrop() {
  if (panel.openView === 'airdrop') return panel.closeView();
  openVisitorView('airdrop', 'Airdrop an item', airdropFlow(host));
}
function openMail() {
  if (panel.openView === 'mail') return panel.closeView();
  openVisitorView('mail', 'Mailbox', mailView(host));
}
function syncTopButtons() {
  dropBtn.setAttribute('aria-pressed', String(panel.openView === 'airdrop'));
  mailBtn.setAttribute('aria-pressed', String(panel.openView === 'mail'));
  const n = visitorStore.waiting;
  const count = $('mail-count');
  count.hidden = n === 0;
  count.textContent = String(n);
  mailBtn.setAttribute('aria-label', n ? `Mailbox, ${n} waiting` : 'Mailbox');
  const admin = auth?.role === 'admin';
  catBtn.hidden = !admin || !server.visitors;
  catBtn.href = withParam('page', 'catalogue');
  promptsBtn.hidden = !admin || !server.prompts;
  promptsBtn.href = withParam('page', 'prompts');
  // Phones: the admin pages move from the top bar into the drawer.
  const links = admin ? { ...(server.visitors && { catalogue: catBtn.href }), ...(server.prompts && { prompts: promptsBtn.href }) } : null;
  if (JSON.stringify(links) !== JSON.stringify(panel.adminLinks)) {
    panel.adminLinks = links;
    if (!panel.openView) panel.update();
  }
  // An archived world takes no inputs: no drops or mail (history and the catalogue stay).
  dropBtn.hidden = mailBtn.hidden = !server.visitors || store.archived;
  const banner = $('archived');
  if (banner.hidden !== !store.archived) {
    banner.hidden = !store.archived;
    requestAnimationFrame(layoutInsets);
  }
  if (store.archived && (panel.openView === 'airdrop' || panel.openView === 'mail')) panel.closeView();
}
scene.onSelectDrop = (id) => openDrop(id);
function openObject(id: string) {
  const o = store.world?.objects.find((x) => x.id === id);
  // Several plants share a name: the grid reference tells them apart (it matches the plan's references).
  const name = o ? `${store.objectLabel(o.type)} · ${String.fromCharCode(65 + o.pos.x)}${o.pos.y + 1}` : 'Object';
  scene.focusObject = id;
  openVisitorView(`obj:${id}`, name, objectCard(store, id), () => (scene.focusObject = null));
}
scene.onSelectObject = (id) => openObject(id);
panel.onOpenObject = (id) => openObject(id);
scene.onOpenMail = () => openMail();
panel.onOpenDrop = (id) => openDrop(id);
panel.onFocusDrop = (id) => (scene.focusDrop = id);
panel.onOpenAirdrop = () => openAirdrop();
panel.onOpenMail = () => openMail();
dropBtn.addEventListener('click', openAirdrop);
mailBtn.addEventListener('click', openMail);
store.onVisitorDelta(() => visitorStore.soon());
visitorStore.on(() => {
  syncTopButtons();
  settingsView.catalogueChanged();
  if (!panel.openView) panel.update();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && scene.placing && panel.openView === 'airdrop') {
    host.stopPlacing();
  }
});

// The catalogue page replaces the workspace; it has its own URL so it can be linked and reloaded.
function showPage() {
  const q = new URLSearchParams(location.search);
  const page = q.get('page');
  const cat = page === 'catalogue';
  const pr = page === 'prompts';
  shell.dataset['page'] = cat || pr ? page! : 'plan';
  $('catalogue-page').hidden = !cat;
  $('prompts-page').hidden = !pr;
  app.querySelector<HTMLElement>('.workspace')!.hidden = cat || pr;
  {
    const p = new URLSearchParams(location.search);
    for (const k of ['page', 'item', 'template']) p.delete(k);
    const back = `${location.pathname}${p.size ? `?${p}` : ''}`;
    $<HTMLAnchorElement>('cat-back').href = back;
    $<HTMLAnchorElement>('prompts-back').href = back;
  }
  // The plan isn't on screen behind an admin page: stop drawing it.
  if (cat || pr) scene.app.ticker.stop();
  else scene.app.ticker.start();
  for (const [btn, on] of [[catBtn, cat], [promptsBtn, pr]] as const) {
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  if (cat) void catPage.show(q.get('item'));
  else catPage.hide();
  if (pr) void promptsPage.show(q.get('template'));
  else promptsPage.hide();
  if (!cat && !pr) requestAnimationFrame(layoutInsets);
}
for (const a of [catBtn, promptsBtn, $<HTMLAnchorElement>('cat-back'), $<HTMLAnchorElement>('prompts-back')]) {
  a.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    history.pushState(null, '', a.href);
    showPage();
  });
}
window.addEventListener('popstate', showPage);
$('panel-body').addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-nav]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  history.pushState(null, '', a.href);
  showPage();
});
visitorStore.start();
syncTopButtons();
showPage();
{
  const open = params.get('open');
  if (open) {
    const off = store.on(() => {
      if (!store.world) return;
      off();
      setTimeout(() => {
        if (open === 'airdrop') openAirdrop();
        else if (open === 'mail') openMail();
        else if (open.startsWith('drop:')) openDrop(open.slice(5));
        else if (open.startsWith('obj:')) openObject(open.slice(4));
      }, 400);
    });
  }
}

// Review switches.
const at = params.get('at');
const pick = params.get('select');
const tab = params.get('tab');
if (at || pick) {
  const off = store.on(() => {
    if (!store.world || store.status !== 'live') return;
    off();
    if (pick) store.select(pick);
    if (at) store.seek(Number(at));
    if (pick && tab === 'beliefs') setTimeout(() => app.querySelector<HTMLElement>('#tab-beliefs')?.click(), 300);
  });
}

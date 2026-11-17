/**
 * Inspector panel (desktop right column; phone pull-up drawer). Standard
 * HTML controls only. Updated in place so focus and scroll survive ticks.
 */
import type { CharacterView, FeedEntry, Tier } from '../types.ts';
import type { ViewerStore } from '../client/store.ts';
import { clockOf, esc, fmtAud, fmtPct, pct, TIER_LABEL, TRIGGER_LABEL } from './format.ts';
import { icons } from './icons.ts';
import { gaugesFor } from '../client/view.ts';
import type { SettingsView } from './settings.ts';
import type { VisitorStore } from '../client/visitors.ts';
import { iconSvg } from '../icons/render.ts';
import { durationText } from './format.ts';


const TIER_RANK: Record<Tier, number> = { 'carry-on': 0, autopilot: 0, local: 1, decision: 2, llm: 3, fallback: 0 };
const FEED_ROWS = 60;

function tierBars(tier: Tier): string {
  const n = TIER_RANK[tier];
  const bars = [0, 1, 2]
    .map((i) => {
      const h = 5 + i * 3.5;
      return `<rect x="${1 + i * 5}" y="${14 - h}" width="3.2" height="${h}" rx="0.6" ${i < n ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1"'} />`;
    })
    .join('');
  return `<svg class="tier-bars" viewBox="0 0 16 15" width="16" height="15" aria-hidden="true">${bars}</svg>`;
}

type Tab = 'feed' | 'beliefs' | 'settings';

export class Panel {
  private mode: 'overview' | 'robot' | 'view' | null = null;
  /** A temporary view (item card, airdrop flow, mail) shown in place of the inspector's content. */
  private view: { key: string; el: HTMLElement; onClose?: () => void } | null = null;
  /** Item schedule rows link to the item card. */
  onOpenDrop: (dropId: string) => void = () => {};
  onFocusDrop: (dropId: string | null) => void = () => {};
  onOpenAirdrop: () => void = () => {};
  onOpenMail: () => void = () => {};
  visitors: VisitorStore | null = null;
  private lastDropsKey: string | null = null;
  private robotId: string | null = null;
  private tab: Tab = 'feed';
  private lastFeedKey: string | null = null;
  private lastBeliefKey: string | null = null;
  private lastRobotsKey: string | null = null;
  private scrolledSeq = 0;

  constructor(
    private root: HTMLElement,
    private store: ViewerStore,
    private settings?: SettingsView,
  ) {
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!t) return;
      const a = t.dataset['action'];
      if (a === 'select') store.select(t.dataset['id'] ?? null);
      if (a === 'back') store.select(null);
      if (a === 'close-view') this.closeView();
      if (a === 'open-drop') this.onOpenDrop(t.dataset['id']!);
      if (a === 'open-airdrop') this.onOpenAirdrop();
      if (a === 'open-mail') this.onOpenMail();
      if (a === 'tab') this.setTab(t.dataset['tab'] as Tab);
      if (a === 'rev') {
        const k = t.dataset['key'] ?? null;
        store.setHighlight(store.highlight === k ? null : k);
      }
    });
    root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.getAttribute('role') !== 'tab') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].map((b) => b.dataset['tab'] as Tab);
        const i = tabs.indexOf(this.tab) + (e.key === 'ArrowRight' ? 1 : -1);
        this.setTab(tabs[(i + tabs.length) % tabs.length]!);
        root.querySelector<HTMLElement>(`[role="tab"][data-tab="${this.tab}"]`)?.focus();
      }
    });
  }

  private setTab(tab: Tab) {
    this.tab = tab;
    if (tab === 'settings') void this.settings?.show();
    else this.settings?.hide();
    if (this.mode === 'overview') {
      const meta = this.root.querySelector<HTMLElement>('.tab-meta');
      if (meta) meta.textContent = tab === 'settings' ? '' : 'All robots · newest first';
    }
    for (const b of this.root.querySelectorAll<HTMLElement>('[role="tab"]')) {
      const on = b.dataset['tab'] === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const p of this.root.querySelectorAll<HTMLElement>('[role="tabpanel"]')) p.hidden = p.dataset['tab'] !== tab;
    this.lastFeedKey = null;
    this.lastBeliefKey = null;
    this.update();
  }

  /** Show a view in the inspector (or phone drawer) with a back button; replaces any open view. */
  showView(key: string, title: string, el: HTMLElement, onClose?: () => void) {
    this.view?.onClose?.();
    this.view = { key, el, ...(onClose && { onClose }) };
    this.mode = 'view';
    this.root.innerHTML = `<section class="pane-section view-section" aria-labelledby="view-h">
      <div class="robot-title">
        <button type="button" class="btn ghost icon-only" data-action="close-view" aria-label="Back">${icons.back()}</button>
        <h2 id="view-h" class="draft-h big">${esc(title)}</h2>
      </div>
      <div data-ref="view-slot"></div>
    </section>`;
    this.root.querySelector('[data-ref="view-slot"]')!.append(el);
    this.root.querySelector<HTMLElement>('[data-action="close-view"]')?.focus();
  }

  get openView(): string | null {
    return this.view?.key ?? null;
  }

  closeView() {
    if (!this.view) return;
    const v = this.view;
    this.view = null;
    this.mode = null;
    v.onClose?.();
    this.update();
  }

  update() {
    if (this.view) return;
    const s = this.store;
    const world = s.world;
    if (!world) {
      this.root.innerHTML = `<div class="panel-empty"><p>Waiting for the world…</p></div>`;
      this.mode = null;
      return;
    }
    const sel = s.character(s.selectedId);
    if (sel) {
      if (this.mode !== 'robot' || this.robotId !== sel.id) this.buildRobot(sel);
      this.updateRobot(sel);
    } else {
      if (this.mode !== 'overview') this.buildOverview();
      this.updateOverview();
    }
  }

  /* ------------------------------------------------------- overview */

  private buildOverview() {
    if (this.tab === 'beliefs') this.tab = 'feed';
    this.mode = 'overview';
    this.robotId = null;
    this.lastFeedKey = null;
    this.lastRobotsKey = null;
    this.root.innerHTML = `
      <section class="pane-section peek" aria-labelledby="robots-h">
        <div class="section-head">
          <h2 id="robots-h" class="draft-h">Robot schedule</h2>
          <p class="section-meta" data-ref="spend"></p>
        </div>
        <table class="schedule robot-schedule">
          <caption class="sr-only">Robots on this sheet: what each is doing, battery and alerts. Choose a robot to read its mind.</caption>
          <thead><tr><th scope="col">Mark</th><th scope="col">Doing</th><th scope="col" class="c-num">Battery</th><th scope="col">Alert</th></tr></thead>
          <tbody data-ref="robots"></tbody>
        </table>
        <p class="hint" data-ref="hint">Tap a robot on the plan, or its mark here, to read its mind.</p>
        ${this.visitors?.api ? `<div class="visitor-actions" role="group" aria-label="Visitors">
          <button type="button" class="btn" data-action="open-airdrop">${icons.airdrop()}<span>Airdrop</span></button>
          <button type="button" class="btn" data-action="open-mail">${icons.mail()}<span>Mailbox</span><span class="btn-count" data-ref="drawer-mail-count" hidden></span></button>
        </div>` : ''}
      </section>
      <section class="pane-section" aria-labelledby="items-h" data-ref="items-section" hidden>
        <div class="section-head">
          <h2 id="items-h" class="draft-h">Item schedule</h2>
          <p class="section-meta">Airdropped by visitors</p>
        </div>
        <table class="schedule item-schedule">
          <caption class="sr-only">Items airdropped into this world. Choose one to see what it is and what the robots believe about it.</caption>
          <thead><tr><th scope="col">Item</th><th scope="col">Dropped by</th><th scope="col" class="c-num">Expires</th></tr></thead>
          <tbody data-ref="drops"></tbody>
        </table>
      </section>
      <section class="pane-section tabs-section">
        <div class="tabs" role="tablist" aria-label="World">
          ${this.tabButton('feed', 'Brain feed')}
          ${this.tabButton('settings', 'World settings')}
          <p class="section-meta tab-meta">${this.tab === 'settings' ? '' : 'All robots · newest first'}</p>
        </div>
        <div role="tabpanel" id="tp-feed" aria-labelledby="tab-feed" data-tab="feed" ${this.tab === 'feed' ? '' : 'hidden'}>
          <div class="table-wrap">${this.feedTableShell(true)}</div>
        </div>
        <div role="tabpanel" id="tp-settings" aria-labelledby="tab-settings" data-tab="settings" data-ref="settings-slot" ${this.tab === 'settings' ? '' : 'hidden'}></div>
      </section>`;
    const slot = this.root.querySelector<HTMLElement>('[data-ref="settings-slot"]');
    if (slot && this.settings) slot.append(this.settings.el);
    if (this.tab === 'settings') void this.settings?.show();
  }

  private tabButton(tab: Tab, label: string): string {
    const on = this.tab === tab;
    return `<button type="button" role="tab" class="tab" id="tab-${tab}" data-action="tab" data-tab="${tab}" aria-controls="tp-${tab}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${label}</button>`;
  }

  private updateOverview() {
    const s = this.store;
    const w = s.world!;
    const spend = this.root.querySelector<HTMLElement>('[data-ref="spend"]')!;
    spend.textContent = `Thinking today ${fmtAud(w.spendTodayAud)} of ${fmtAud(w.capAud)} cap`;
    const list = this.root.querySelector<HTMLElement>('[data-ref="robots"]')!;
    const key = w.characters.map((c) => c.id).join(',');
    if (key !== this.lastRobotsKey) {
      this.lastRobotsKey = key;
      list.innerHTML = w.characters.length
        ? w.characters
            .map(
              (c) => `
          <tr data-id="${c.id}">
            <th scope="row"><button type="button" class="mark-btn" data-action="select" data-id="${c.id}">${icons.robot()}<span>${esc(c.name)}</span></button></th>
            <td data-ref="doing"></td>
            <td class="c-num"><span class="mini-gauge" aria-hidden="true"><span class="mini-fill"></span></span><span class="robot-bat" data-ref="batv"></span></td>
            <td data-ref="alert"></td>
          </tr>`,
            )
            .join('')
        : `<tr class="empty-row"><td colspan="4"><strong>No robots on this sheet.</strong> ${esc(w.name)} has no characters yet. When one is spawned it appears here and on the plan.</td></tr>`;
      this.root.querySelector<HTMLElement>('[data-ref="hint"]')!.hidden = w.characters.length === 0;
    }
    for (const c of w.characters) {
      const row = list.querySelector<HTMLElement>(`tr[data-id="${c.id}"]`);
      if (!row) continue;
      const low = c.mind.energy < (s.catalog?.energyFloor ?? 0.1);
      row.classList.toggle('is-alert', c.alerts.length > 0);
      const al = row.querySelector<HTMLElement>('[data-ref="alert"]')!;
      al.textContent = c.alerts.length ? c.alerts.map((a) => a.text.toLowerCase()).join(', ') : '—';
      al.classList.toggle('red', c.alerts.length > 0);
      row.querySelector<HTMLElement>('[data-ref="doing"]')!.textContent = this.doing(c);
      const fill = row.querySelector<HTMLElement>('.mini-fill')!;
      fill.style.width = pct(c.mind.energy);
      fill.classList.toggle('is-low', low);
      const bv = row.querySelector<HTMLElement>('[data-ref="batv"]')!;
      bv.textContent = pct(c.mind.energy);
      bv.classList.toggle('is-low', low);
      row.querySelector('.mark-btn')!.setAttribute('aria-label', `${c.name}: read its mind`);
    }
    this.updateFeed(null);
    this.updateDrops();
  }

  private updateDrops() {
    const sec = this.root.querySelector<HTMLElement>('[data-ref="items-section"]');
    const body = this.root.querySelector<HTMLElement>('[data-ref="drops"]');
    const v = this.visitors;
    if (!sec || !body || !v) return;
    const mc = this.root.querySelector<HTMLElement>('[data-ref="drawer-mail-count"]');
    if (mc) {
      mc.hidden = v.waiting === 0;
      mc.textContent = String(v.waiting);
    }
    const w = this.store.world!;
    const drops = v.airdrops;
    sec.hidden = drops.length === 0;
    const key = drops.map((d) => `${d.id}${d.expiresTick}`).join(',') + `|${Math.floor(w.clock.tick / 60)}`;
    if (key === this.lastDropsKey) return;
    this.lastDropsKey = key;
    body.innerHTML = drops
      .map((d) => {
        const left = d.expiresTick ? d.expiresTick - w.clock.tick : null;
        return `<tr>
          <th scope="row"><button type="button" class="mark-btn drop-btn" data-action="open-drop" data-id="${d.id}">${iconSvg(d.item.icon, 20)}<span>${esc(d.item.name)}</span></button></th>
          <td>${esc(d.droppedBy.username)}${d.droppedBy.admin ? ' <span class="role-chip">admin</span>' : ''}</td>
          <td class="c-num">${left === null ? '<span class="nil">never</span>' : esc(durationText(left * w.clock.secondsPerTick))}</td>
        </tr>`;
      })
      .join('');
  }

  private doing(c: CharacterView): string {
    if (c.mind.asleep) return c.action ? `Standby · ${phrase(this.store, c.action.verb, c.action.targetId)}` : 'Standby';
    if (!c.action) return 'Idle';
    return cap(phrase(this.store, c.action.verb, c.action.targetId));
  }

  /* ---------------------------------------------------------- robot */

  private buildRobot(c: CharacterView) {
    if (this.tab === 'settings') {
      this.tab = 'feed';
      this.settings?.hide();
    }
    this.mode = 'robot';
    this.robotId = c.id;
    this.lastFeedKey = null;
    this.lastBeliefKey = null;
    // Gauges and their low marks come from the archetype (needs) and the world's energy floor (battery).
    const gauges = gaugesFor(this.store.catalog, c.type).map(
      (g) => `
      <div class="gauge" role="meter" aria-label="${g.label}" aria-valuemin="0" aria-valuemax="100" data-key="${g.key}">
        <span class="gauge-label">${g.label}</span>
        <span class="gauge-ticks" aria-hidden="true">${'<i></i>'.repeat(20)}<b class="gauge-low" style="left:${g.low * 100}%"></b></span>
        <span class="gauge-value"></span>
      </div>`,
    ).join('');
    this.root.innerHTML = `
      <section class="pane-section peek robot-head" aria-labelledby="robot-h">
        <div class="robot-title">
          <button type="button" class="btn ghost icon-only" data-action="back" aria-label="Back to all robots">${icons.back()}</button>
          <h2 id="robot-h" class="draft-h big">${esc(c.name)}</h2>
          <p class="mood" data-ref="mood"></p>
        </div>
        <div class="gauges">${gauges}</div>
        <div class="now">
          <p class="now-action" data-ref="action"></p>
          <p class="now-reason" data-ref="reason"></p>
          <p class="now-meta" data-ref="meta"></p>
        </div>
        <ul class="alerts" data-ref="alerts" aria-live="polite"></ul>
      </section>
      <section class="pane-section tabs-section">
        <div class="tabs" role="tablist" aria-label="${esc(c.name)} details">
          <button type="button" role="tab" class="tab" id="tab-feed" data-action="tab" data-tab="feed" aria-controls="tp-feed" aria-selected="${this.tab === 'feed'}" tabindex="${this.tab === 'feed' ? 0 : -1}">Brain feed</button>
          <button type="button" role="tab" class="tab" id="tab-beliefs" data-action="tab" data-tab="beliefs" aria-controls="tp-beliefs" aria-selected="${this.tab === 'beliefs'}" tabindex="${this.tab === 'beliefs' ? 0 : -1}">Beliefs <span class="count" data-ref="bcount"></span></button>
          <p class="section-meta tab-meta" data-ref="spendBot"></p>
        </div>
        <div role="tabpanel" id="tp-feed" aria-labelledby="tab-feed" data-tab="feed" ${this.tab === 'feed' ? '' : 'hidden'}>
          <div class="table-wrap">${this.feedTableShell(false)}</div>
        </div>
        <div role="tabpanel" id="tp-beliefs" aria-labelledby="tab-beliefs" data-tab="beliefs" ${this.tab === 'beliefs' ? '' : 'hidden'}>
          <p class="belief-note">Learned from experience, not told. Beliefs can be wrong and only change while the robot is in standby.</p>
          <table class="schedule belief-schedule">
            <caption class="sr-only">Belief schedule: what this robot believes, how firmly, and the last day experience supported it</caption>
            <thead><tr><th scope="col">Mark</th><th scope="col">Belief</th><th scope="col" class="c-num">Firm</th><th scope="col" class="c-hide-phone c-num">Support</th><th scope="col">Last support</th></tr></thead>
            <tbody data-ref="beliefs"></tbody>
          </table>
        </div>
      </section>`;
  }

  private updateRobot(c: CharacterView) {
    const s = this.store;
    const w = s.world!;
    const q = (r: string) => this.root.querySelector<HTMLElement>(`[data-ref="${r}"]`)!;
    q('mood').textContent = `${cap(c.mind.mood)}${c.mind.asleep ? ' · standby' : ''}`;
    for (const g of gaugesFor(s.catalog, c.type)) {
      const el = this.root.querySelector<HTMLElement>(`.gauge[data-key="${g.key}"]`);
      if (!el) continue;
      const v = (g.key === 'energy' ? c.mind.energy : c.mind.needs[g.key]) ?? 0;
      const low = v < g.low;
      el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
      el.setAttribute('aria-valuetext', `${pct(v)}${low ? ', low' : ''}`);
      el.classList.toggle('is-low', low);
      const on = Math.round(v * 20);
      el.querySelectorAll('i').forEach((t, i) => t.classList.toggle('on', i < on));
      el.querySelector<HTMLElement>('.gauge-value')!.textContent = pct(v);
    }
    const last = [...s.feed].reverse().find((e) => e.characterId === c.id && e.actions[0]?.verb !== 'reflect');
    q('action').textContent = this.doing(c);
    q('reason').textContent = c.action?.reason ? `“${cap(c.action.reason.replace(/\.$/, ''))}.”` : '';
    if (last) {
      const ck = clockOf(last.tick, w.clock);
      q('meta').textContent = `Decided ${ck.time} by ${TIER_LABEL[last.tier]}${last.modelId ? ` (${last.modelId})` : ''}${last.confidence !== undefined ? `, confidence ${last.confidence.toFixed(2)}` : ''} · trigger: ${TRIGGER_LABEL[last.trigger] ?? last.trigger}`;
    } else q('meta').textContent = '';
    const alerts = q('alerts');
    const ak = c.alerts.map((a) => a.text).join('|');
    if (alerts.dataset['k'] !== ak) {
      alerts.dataset['k'] = ak;
      alerts.innerHTML = c.alerts
        .map((a) => {
          const extra =
            a.kind === 'energy-low'
              ? 'Thinking is limited to the local model and autopilot until the battery recovers.'
              : a.kind === 'need-critical'
                ? 'Cool is critical; it needs rest or water.'
                : 'The world refused its last action.';
          return `<li class="alert">${icons.revision()}<span><strong>${esc(a.text)}</strong> ${extra}</span></li>`;
        })
        .join('');
    }
    // spend today for this robot
    const day = clockOf(w.clock.tick, w.clock).day;
    let aud = 0;
    let energy = 0;
    for (const e of s.feed)
      if (e.characterId === c.id && clockOf(e.tick, w.clock).day === day) {
        aud += e.usage?.costAud ?? 0;
        energy += e.energyCost ?? 0;
      }
    q('spendBot').textContent = `Today ${fmtAud(aud)} · ${fmtPct(energy)} battery`;
    q('bcount').textContent = String(c.beliefs.length);
    if (this.tab === 'feed') this.updateFeed(c.id);
    else this.updateBeliefs(c);
  }

  private updateBeliefs(c: CharacterView) {
    const key = c.beliefs.map((b) => `${b.key}${b.firmness}${b.text}`).join('|');
    if (key === this.lastBeliefKey) return;
    this.lastBeliefKey = key;
    const list = this.root.querySelector<HTMLElement>('[data-ref="beliefs"]')!;
    if (!c.beliefs.length) {
      list.innerHTML = `<tr class="empty-row"><td colspan="5"><strong>No beliefs yet.</strong> ${esc(c.name)} forms beliefs while in standby, from what happened during the day.</td></tr>`;
      return;
    }
    list.innerHTML = [...c.beliefs]
      .sort((a, b) => b.lastSupportedDay - a.lastSupportedDay || b.firmness - a.firmness)
      .map((b, i, all) => {
        const ticks = Array.from({ length: 10 }, (_, k) => `<i class="${k < Math.round(b.firmness * 10) ? 'on' : ''}"></i>`).join('');
        return `<tr>
          <th scope="row" class="mark">B${all.length - i}</th>
          <td><span class="belief-text">“${esc(b.text)}”</span><span class="sub belief-key">${esc(b.key)}</span></td>
          <td class="c-num"><span class="firm" role="img" aria-label="Firmness ${pct(b.firmness)}"><span class="firm-ticks" aria-hidden="true">${ticks}</span></span><span class="sub">${pct(b.firmness)}</span></td>
          <td class="c-num c-hide-phone">${b.support}</td>
          <td class="c-when">Day ${b.lastSupportedDay + 1}</td>
        </tr>`;
      })
      .join('');
  }

  /* ----------------------------------------------------------- feed */

  private feedTableShell(all: boolean): string {
    return `<table class="rev-table">
      <caption class="sr-only">Brain feed: each decision with tier, model, confidence and cost in Australian dollars</caption>
      <thead><tr>
        <th scope="col" class="c-rev">Rev · when</th>
        <th scope="col" class="c-tier">Tier · model</th>
        <th scope="col" class="c-dec">${all ? 'Robot · decision' : 'Decision'}</th>
        <th scope="col" class="c-num">Conf. · A$</th>
      </tr></thead>
      <tbody data-ref="feed"></tbody>
    </table>`;
  }

  private updateFeed(robotId: string | null) {
    const s = this.store;
    const tbody = this.root.querySelector<HTMLElement>('[data-ref="feed"]');
    if (!tbody) return;
    const rows: FeedEntry[] = [];
    for (let i = s.feed.length - 1; i >= 0 && rows.length < FEED_ROWS; i--) {
      const e = s.feed[i]!;
      if (!robotId || e.characterId === robotId) rows.push(e);
    }
    // Keep a highlighted row in view even when it is older than the newest rows.
    if (s.highlight && !rows.some((e) => `${e.tick}:${e.characterId}` === s.highlight)) {
      const h = s.feed.find((e) => `${e.tick}:${e.characterId}` === s.highlight);
      if (h && (!robotId || h.characterId === robotId)) rows.push(h);
    }
    const key = `${s.highlight}|` + rows.map((e) => `${e.tick}${e.characterId}${e.actions.map((a) => a.status[0]).join('')}`).join(',');
    if (key === this.lastFeedKey) return;
    this.lastFeedKey = key;
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="4"><strong>No decisions recorded yet.</strong> Entries appear here as the brain wakes on events.</td></tr>`;
      return;
    }
    const w = s.world!;
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.['key'];
    tbody.innerHTML = rows
      .map((e) => {
        const ck = clockOf(e.tick, w.clock);
        const warn = e.tier === 'fallback' || e.actions.some((a) => a.status === 'rejected' || a.status === 'failed');
        const acts = e.actions
          .map((a) => {
            const st = a.status === 'queued' ? '' : `<span class="st st-${a.status}">${a.status}</span>`;
            return `<span class="act"><span class="verb">${esc(phrase(s, a.verb, a.targetId))}</span>${st}<span class="why">${esc(a.reason)}</span></span>`;
          })
          .join('');
    if (focusKey) tbody.querySelector<HTMLElement>(`.rev-btn[data-key="${focusKey}"]`)?.focus();
    if (s.highlight && this.scrolledSeq !== s.highlightSeq) {
      this.scrolledSeq = s.highlightSeq;
      tbody.querySelector<HTMLElement>(`tr[data-key="${s.highlight}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
        const notes = e.notes?.length ? `<span class="notes">${esc(e.notes.join(' · '))}</span>` : '';
        const why = e.reason ? `<span class="why fallback-why">${esc(e.reason)}</span>` : '';
        const who = robotId ? '' : `<span class="who">${esc(s.nameOf(e.characterId))}</span>`;
        const cost = e.usage ? `${fmtAud(e.usage.costAud)}${e.energyCost ? `<span class="sub">−${fmtPct(e.energyCost)} bat</span>` : ''}` : `<span class="nil">free</span>`;
        const k = `${e.tick}:${e.characterId}`;
        const n = s.rev(e);
        const on = s.highlight === k;
        const belief = e.actions[0]?.verb === 'reflect' && /new|revised/.test(e.actions[0].reason);
        return `<tr class="${warn ? 'is-warn' : ''} tier-${e.tier}${on ? ' is-lit' : ''}" data-key="${k}">
          <th scope="row" class="c-rev"><button type="button" class="rev-btn" data-action="rev" data-key="${k}" aria-pressed="${on}" aria-label="Revision ${n}${warn ? ', needs attention' : ''}${belief ? ', belief changed' : ''}: show on the plan and timeline">${deltaSvg(warn, on)}<span>${n}</span></button><span class="t">${ck.time}</span><span class="sub">D${ck.day}</span></th>
          <td class="c-tier"><span class="tier">${warn && e.tier === 'fallback' ? icons.revision() : tierBars(e.tier)}${TIER_LABEL[e.tier]}</span>${e.modelId ? `<span class="sub model">${esc(e.modelId)}</span>` : ''}</td>
          <td class="c-dec">${who}${acts}${why}${notes}</td>
          <td class="c-num"><span class="conf">${e.confidence !== undefined ? e.confidence.toFixed(2) : '<span class="nil">—</span>'}</span>${cost}</td>
        </tr>`;
      })
      .join('');
  }
}

const PREP: Record<string, string> = { rest: 'at', charge: 'at', rinse: 'at', splash: 'at', dock: 'at', vocalize: 'to' };

/** "charge" + solar pad → "charge at solar pad"; robots keep their tag. */
export function phrase(store: ViewerStore, verb: string, targetId?: string): string {
  if (!targetId) return verb;
  const isRobot = !!store.character(targetId);
  const name = isRobot ? store.nameOf(targetId) : store.nameOf(targetId).toLowerCase();
  return `${verb} ${PREP[verb] ? `${PREP[verb]} ` : ''}${name}`;
}

/** Revision delta, drawn: outline, or red when the row needs attention; filled when highlighted. */
function deltaSvg(warn: boolean, on: boolean): string {
  return `<svg class="delta${warn ? ' warn' : ''}" viewBox="0 0 16 14" width="16" height="14" aria-hidden="true"><path d="M8 1.5 14.8 12.8H1.2Z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

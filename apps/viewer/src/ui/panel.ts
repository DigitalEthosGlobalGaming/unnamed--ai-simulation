/**
 * Inspector panel (desktop right column; phone pull-up drawer). Standard
 * HTML controls only. Updated in place so focus and scroll survive ticks.
 */
import type { CharacterView } from '../types.ts';
import type { ViewerStore } from '../client/store.ts';
import { clockOf, esc, fmtAud, fmtPct, pct, TIER_LABEL, TRIGGER_LABEL } from './format.ts';
import { icons } from './icons.ts';
import { gaugesFor } from '../client/view.ts';
import type { SettingsView } from './settings.ts';
import type { VisitorStore } from '../client/visitors.ts';
import { iconSvg } from '../icons/render.ts';
import { durationText, phrase } from './format.ts';
import { FeedView } from './feed.ts';


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
  private readonly feed: FeedView;
  private lastBeliefKey: string | null = null;
  private lastRobotsKey: string | null = null;

  constructor(
    private root: HTMLElement,
    private store: ViewerStore,
    private settings?: SettingsView,
  ) {
    this.feed = new FeedView(store, () => this.root);
    root.addEventListener('scroll', () => this.feed.onScroll(), { passive: true });
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
          <div data-ref="feed-slot"></div>
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
    if (c.mind.asleep && c.mind.sleepWork) return 'Asleep';
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
    this.lastBeliefKey = null;
    // Gauges and their low marks come from the archetype (needs) and the world's energy floor (battery).
    const gauges = this.gaugeList(c)
      .map((g) => {
        const bat = g.key === 'energy';
        // The battery is the thinking budget: its A$ worth shows on hover and keyboard focus.
        return `
      <div class="gauge${g.high ? ' is-rising' : ''}" role="meter" aria-label="${g.label}${bat ? ', thinking budget' : ''}" aria-valuemin="0" aria-valuemax="100" data-key="${g.key}"${bat ? ' tabindex="0" aria-describedby="bat-tip"' : ''}>
        <span class="gauge-label">${g.label}${bat ? '<span class="gauge-sub">thinking</span>' : ''}</span>
        <span class="gauge-ticks" aria-hidden="true">${'<i></i>'.repeat(20)}<b class="gauge-low" style="left:${(g.high ?? g.low) * 100}%"></b></span>
        <span class="gauge-value"></span>
        ${bat ? '<span class="gauge-tip" id="bat-tip" role="tooltip"></span>' : ''}
      </div>`;
      })
      .join('');
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
          <ol class="sleep-steps" data-ref="sleep" aria-label="Sleep work" hidden></ol>
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
          <div data-ref="feed-slot"></div>
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
    for (const g of this.gaugeList(c)) {
      const el = this.root.querySelector<HTMLElement>(`.gauge[data-key="${g.key}"]`);
      if (!el) {
        if (g.high !== undefined) this.robotId = null; // a new reading appeared: rebuild the gauges
        continue;
      }
      const v = (g.key === 'energy' ? c.mind.energy : g.key === 'sleepPressure' ? c.mind.sleepPressure : g.key === 'fog' ? c.mind.fog : c.mind.needs[g.key]) ?? 0;
      const low = g.high !== undefined ? v >= g.high : v < g.low;
      el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
      let extra = low ? (g.high !== undefined ? ', high' : ', low') : '';
      if (g.key === 'energy') {
        const per = s.catalog?.energyPerAud;
        if (per) {
          const left = v / per;
          extra += `, about ${fmtAud(left)} of thinking left`;
          const tip = el.querySelector<HTMLElement>('.gauge-tip');
          if (tip) tip.textContent = `≈ ${fmtAud(left)} of thinking left · a full battery is ${fmtAud(1 / per)}`;
        }
      }
      el.setAttribute('aria-valuetext', `${pct(v)}${extra}`);
      el.classList.toggle('is-low', low);
      const on = Math.round(v * 20);
      el.querySelectorAll('i').forEach((t, i) => t.classList.toggle('on', i < on));
      el.querySelector<HTMLElement>('.gauge-value')!.textContent = pct(v);
    }
    const last = [...s.feed].reverse().find((e) => e.characterId === c.id && e.actions[0]?.verb !== 'reflect');
    q('action').textContent = this.doing(c);
    this.updateSleep(c, q('sleep'));
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

  /** Needs plus, when the world reports them, sleep pressure and fog (they read worse as they rise). */
  private gaugeList(c: CharacterView): { key: string; label: string; low: number; high?: number }[] {
    const list: { key: string; label: string; low: number; high?: number }[] = gaugesFor(this.store.catalog, c.type);
    if (c.mind.sleepPressure !== undefined) list.push({ key: 'sleepPressure', label: 'Sleep', low: 0, high: 0.85 });
    if (c.mind.fog !== undefined) list.push({ key: 'fog', label: 'Fog', low: 0, high: 0.8 });
    return list;
  }

  /** While asleep: the night's work in order (memories, habits, sheet, rest), current step marked. */
  private updateSleep(c: CharacterView, el: HTMLElement) {
    const w = c.mind.asleep ? c.mind.sleepWork : undefined;
    el.hidden = !w;
    if (!w) return;
    const steps: { id: string; text: string }[] = [
      { id: 'consolidating', text: w.step === 'consolidating' && w.total ? `Settling memories ${w.done ?? 0} of ${w.total}` : 'Settling memories' },
      { id: 'habits', text: 'Finding habits' },
      { id: 'sheet', text: 'Rewriting its character sheet' },
      ...(w.step === 'refine' ? [{ id: 'refine', text: 'Reviewing the day' }] : []),
      { id: 'done', text: 'Resting until rested or full' },
    ];
    const at = steps.findIndex((x) => x.id === w.step);
    const key = `${w.step}:${w.done}:${w.total}`;
    if (el.dataset['k'] === key) return;
    el.dataset['k'] = key;
    el.innerHTML = steps
      .map((x, i) => `<li class="${i < at ? 'is-done' : i === at ? 'is-now' : 'is-next'}"${i === at ? ' aria-current="step"' : ''}><span class="sr-only">${i < at ? 'Done: ' : i === at ? 'Now: ' : 'Next: '}</span>${x.text}</li>`)
      .join('');
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

  private updateFeed(robotId: string | null) {
    const slot = this.root.querySelector<HTMLElement>('[data-ref="feed-slot"]');
    if (!slot) return;
    if (this.feed.el.parentElement !== slot) slot.append(this.feed.el);
    this.feed.setRobot(robotId);
    this.feed.update();
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

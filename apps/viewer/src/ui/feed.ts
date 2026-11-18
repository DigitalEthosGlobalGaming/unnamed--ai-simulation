/**
 * The brain feed as a revision list: newest first, grouped into in-world hours under sticky
 * headings, identical decisions in a row collapsed into one entry ("Wait ×7"), paged 25 rows at a
 * time with older history fetched from the server by tick. Each entry leads with what was decided,
 * then the quoted reason, then a muted meta line whose tier mark opens the model and cost detail.
 * While the reader is scrolled back, live entries wait behind an "N new decisions" button.
 */
import type { ViewerStore } from '../client/store.ts';
import { isWarn } from '../client/store.ts';
import type { FeedEntry, Tier } from '../types.ts';
import { clockOf, esc, fmtAud, fmtPct, phrase, TIER_LABEL, TRIGGER_LABEL } from './format.ts';

const PAGE = 25;
/** Most rows a reader can page back to; older history is a timeline scrub away. */
const MAX_ROWS = 500;
const FETCH = 100;

export type FeedFilter = 'all' | 'model' | 'auto' | 'problems';
const FILTERS: { id: FeedFilter; label: string; title: string }[] = [
  { id: 'all', label: 'All', title: 'Every decision' },
  { id: 'model', label: 'Model calls', title: 'Decisions a model made (they cost battery and money)' },
  { id: 'auto', label: 'Autopilot', title: 'Free decisions: autopilot, carrying on a plan, fallbacks' },
  { id: 'problems', label: 'Problems', title: 'Refused or failed steps, decisions made after a refusal, and fallbacks' },
];

const MODEL_TIERS = new Set<Tier>(['decision', 'local', 'llm']);
const TIER_RANK: Record<Tier, number> = { 'carry-on': 0, autopilot: 0, local: 1, decision: 2, llm: 3, fallback: 0 };
const TIER_SHORT: Record<Tier, string> = { 'carry-on': 'Plan', autopilot: 'Auto', local: 'Local', decision: 'Scorer', llm: 'LLM', fallback: 'Fallback' };
const TIER_MEANS: Record<Tier, string> = {
  'carry-on': 'The next step of an earlier plan. No model call.',
  autopilot: 'Chosen by the robot’s own rules from what it believes. No model call.',
  local: 'A small chat model running on the server’s machine.',
  decision: 'A decision model scored the options and picked one.',
  llm: 'A text model chose or planned this.',
  fallback: 'No model answered in time, so a safe default was used.',
};
/** The robot's own choice of how hard to think (iteration 2). */
type Depth = 'habit' | 'gut' | 'think';
const DEPTH_SHORT: Record<Depth, string> = { habit: 'Habit', gut: 'Gut', think: 'Think' };
const DEPTH_MEANS: Record<Depth, string> = {
  habit: 'Habit: did what it usually does here. Free.',
  gut: 'Gut: a quick call to the decision model.',
  think: 'Think it through: asked the plan model for a plan, the dearest choice.',
};
const depthOf = (e: FeedEntry) => (e as FeedEntry & { depth?: Depth; depthWhy?: string });
const VERB_WORDS: Record<string, string> = { pickup: 'pick up', putdown: 'put down', vocalize: 'make noises', moveTo: 'go to' };

function tierBars(tier: Tier): string {
  const n = TIER_RANK[tier];
  const bars = [0, 1, 2]
    .map((i) => {
      const h = 5 + i * 3.5;
      return `<rect x="${1 + i * 5}" y="${14 - h}" width="3.2" height="${h}" rx="0.6" ${i < n ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1"'} />`;
    })
    .join('');
  return `<svg class="tier-bars" viewBox="0 0 16 15" width="14" height="13" aria-hidden="true">${bars}</svg>`;
}

function deltaSvg(warn: boolean, on: boolean): string {
  return `<svg class="delta${warn ? ' warn' : ''}" viewBox="0 0 16 14" width="13" height="11" aria-hidden="true"><path d="M8 1.5 14.8 12.8H1.2Z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

const keyOf = (e: FeedEntry) => `${e.tick}:${e.characterId}`;
/** "pickup ball" → "pick up ball", keeping phrase()'s prepositions ("vocalize to RB-01" → "make noises to RB-01"). */
const say = (store: ViewerStore, verb: string, targetId?: string) => {
  const p = phrase(store, verb, targetId);
  return VERB_WORDS[verb] ? VERB_WORDS[verb] + p.slice(verb.length) : p;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const quote = (s: string) => `“${cap(s.trim().replace(/\.$/, ''))}.”`;

/** A row: one decision, or a run of identical consecutive ones (newest first). */
interface Row {
  id: string;
  entries: FeedEntry[];
}

export class FeedView {
  readonly el = document.createElement('div');
  private robotId: string | null = null;
  private filter: FeedFilter = 'all';
  private pages = 1;
  /** Entries fetched from the server, older than everything the store holds (newest first). */
  private older: FeedEntry[] = [];
  private olderHead: number | null = null;
  private olderDone = false;
  private loading = false;
  private loadError = '';
  /** Live entries newer than this tick wait behind the "new decisions" button while the reader is scrolled back. */
  private frozenAt: number | null = null;
  private expanded = new Set<string>();
  private byKey = new Map<string, FeedEntry>();
  /** Runs by their newest entry's key, so the detail box can count their tiers. */
  private runs = new Map<string, FeedEntry[]>();
  private lastKey = '';
  private scrolledSeq = 0;
  private pop: TierPopover;

  constructor(
    private store: ViewerStore,
    private scroller: () => HTMLElement | null,
  ) {
    this.el.className = 'feed-view';
    this.pop = new TierPopover(store, (k) => this.byKey.get(k), (k) => this.runs.get(k));
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-feed]');
      if (!t) return;
      const a = t.dataset['feed'];
      if (a === 'filter') this.setFilter(t.dataset['id'] as FeedFilter);
      if (a === 'older') void this.loadOlder();
      if (a === 'newest') this.showNewest();
      if (a === 'expand') {
        const id = t.dataset['id']!;
        if (this.expanded.has(id)) this.expanded.delete(id);
        else this.expanded.add(id);
        this.lastKey = '';
        this.update();
        this.el.querySelector<HTMLElement>(`[data-feed="expand"][data-id="${id}"]`)?.focus();
      }
    });
    this.pop.attach(this.el);
  }

  /** Show one robot's feed (or all robots' with null); resets paging when it changes. */
  setRobot(id: string | null) {
    if (id === this.robotId && this.el.childElementCount) return;
    this.robotId = id;
    this.reset();
    this.build();
  }

  private reset() {
    this.pages = 1;
    this.older = [];
    this.olderHead = null;
    this.olderDone = false;
    this.loadError = '';
    this.frozenAt = null;
    this.expanded.clear();
    this.lastKey = '';
  }

  private setFilter(f: FeedFilter) {
    if (f === this.filter) return;
    this.filter = f;
    this.pages = 1;
    this.expanded.clear();
    this.lastKey = '';
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-feed="filter"]')) b.setAttribute('aria-pressed', String(b.dataset['id'] === f));
    this.update();
  }

  private build() {
    this.el.innerHTML = `
      <div class="feed-tools">
        <div class="feed-filter" role="group" aria-label="Show decisions">
          ${FILTERS.map((f) => `<button type="button" class="chip-btn" data-feed="filter" data-id="${f.id}" aria-pressed="${f.id === this.filter}" title="${f.title}">${f.label}</button>`).join('')}
        </div>
      </div>
      <button type="button" class="new-pill" data-feed="newest" hidden></button>
      <div class="feed-list" data-ref="list" aria-live="off"></div>
      <div class="feed-more" data-ref="more"></div>`;
  }

  /* ------------------------------------------------------------ data */

  private matches(e: FeedEntry): boolean {
    if (this.robotId && e.characterId !== this.robotId) return false;
    switch (this.filter) {
      case 'model':
        return MODEL_TIERS.has(e.tier);
      case 'auto':
        return !MODEL_TIERS.has(e.tier);
      case 'problems':
        return this.bad(e);
      default:
        return true;
    }
  }

  private status(e: FeedEntry, i: number): FeedEntry['actions'][number]['status'] {
    const own = e.actions[i]!.status;
    return own !== 'queued' ? own : (this.store.stepOutcomes(e)[i]?.status ?? own);
  }

  /** Decisions whose next decision by the same robot was triggered by a refusal: a step was refused, even
      when history doesn't hold the step's status. */
  private refusedKeys = new Set<string>();

  private noteRefusals() {
    this.refusedKeys.clear();
    const next = new Map<string, FeedEntry>();
    const scan = (e: FeedEntry) => {
      const n = next.get(e.characterId);
      if (n?.trigger === 'action-rejected') this.refusedKeys.add(keyOf(e));
      next.set(e.characterId, e);
    };
    const feed = this.store.feed;
    for (let i = feed.length - 1; i >= 0; i--) scan(feed[i]!);
    for (const e of this.older) scan(e);
  }

  private badStep(e: FeedEntry): boolean {
    return e.actions.some((_, i) => {
      const st = this.status(e, i);
      return st === 'rejected' || st === 'failed';
    });
  }

  /** Needs attention: a refused or failed step (known or inferred), or a fallback. */
  private bad(e: FeedEntry): boolean {
    return isWarn(e) || this.badStep(e) || this.refusedKeys.has(keyOf(e));
  }

  private sig(e: FeedEntry): string {
    // Outcomes count only as good or bad, so a loop reads as one run across history (status not
    // recorded) and live entries (status known).
    return `${e.characterId}|${e.actions.map((a) => `${a.verb}:${a.targetId ?? ''}`).join('>')}|${e.notes?.join(',') ?? ''}|${e.tier === 'fallback'}|${this.bad(e)}`;
  }

  /** Rows newest first, enough for the pages shown plus one to know if there are more. */
  private rows(limit: number): { rows: Row[]; more: boolean; newer: number } {
    this.noteRefusals();
    const feed = this.store.feed;
    const rows: Row[] = [];
    let last = '';
    let newer = 0;
    // A run only joins decisions that really were back to back for that robot: one the filter hides breaks it.
    let gap = false;
    const push = (e: FeedEntry) => {
      const sg = this.sig(e);
      const r = rows[rows.length - 1];
      if (r && sg === last && !gap) r.entries.push(e);
      else {
        rows.push({ id: keyOf(e), entries: [e] });
        last = sg;
      }
      gap = false;
    };
    const skip = (e: FeedEntry) => {
      const r = rows[rows.length - 1];
      if (r && r.entries[0]!.characterId === e.characterId && (!this.robotId || e.characterId === this.robotId)) gap = true;
    };
    let i = feed.length - 1;
    for (; i >= 0; i--) {
      const e = feed[i]!;
      if (!this.matches(e)) {
        skip(e);
        continue;
      }
      if (this.frozenAt !== null && e.tick > this.frozenAt) {
        newer++;
        continue;
      }
      if (rows.length > limit) break;
      push(e);
    }
    let localLeft = false;
    for (; i >= 0; i--) if (this.matches(feed[i]!)) localLeft = true;
    if (rows.length <= limit)
      for (const e of this.older) {
        if (this.matches(e)) push(e);
        else skip(e);
      }
    // Rows are keyed by their oldest entry, so a run keeps its id (and open state) as it grows.
    for (const r of rows) r.id = keyOf(r.entries[r.entries.length - 1]!);
    const more = rows.length > limit || localLeft || (!this.olderDone && !!this.store.conn.feedBefore);
    return { rows: rows.slice(0, limit), more, newer };
  }

  private async loadOlder() {
    this.pages = Math.min(this.pages + 1, MAX_ROWS / PAGE);
    this.lastKey = '';
    const need = this.pages * PAGE;
    if (this.rows(need).rows.length < need && !this.olderDone && this.store.conn.feedBefore) await this.fetchOlder(need);
    this.update();
    // Keep the reader's place: focus the first newly shown row.
    const items = this.el.querySelectorAll<HTMLElement>('.fe-row');
    items[(this.pages - 1) * PAGE]?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  /** Page back through the server's history until there are enough rows or none left. */
  private async fetchOlder(need: number) {
    if (this.loading) return;
    this.loading = true;
    this.loadError = '';
    this.renderMore(true);
    try {
      for (let n = 0; n < 5 && !this.olderDone && this.rows(need).rows.length < need; n++) {
        const head = this.store.feed[0];
        if (this.olderHead !== null && head && head.tick !== this.olderHead) {
          // The store dropped old entries since the last fetch: start the older pages again from its head.
          this.older = [];
        }
        this.olderHead = head?.tick ?? null;
        const cursor = this.older.length ? this.older[this.older.length - 1]!.tick : (head?.tick ?? this.store.tick + 1);
        // `beforeTick` is exclusive and several robots can decide in one tick: ask from the cursor's
        // tick inclusive and drop what is already held.
        const got = await this.store.feedBefore(cursor + 1, FETCH, this.robotId ?? undefined);
        const have = new Set([...this.older.slice(-50), ...this.store.feed.slice(0, 50)].map(keyOf));
        const fresh = got.filter((e) => !have.has(keyOf(e))).reverse();
        this.older.push(...fresh);
        if (got.length < FETCH || !fresh.length) this.olderDone = true;
      }
    } catch (e) {
      this.loadError = `Couldn’t load older decisions: ${(e as Error).message}`;
    }
    this.loading = false;
  }

  private showNewest() {
    this.frozenAt = null;
    this.pages = 1;
    this.lastKey = '';
    this.update();
    const list = this.el.querySelector<HTMLElement>('[data-ref="list"]');
    list?.scrollIntoView({ block: 'start', behavior: 'auto' });
    list?.querySelector<HTMLElement>('.fe-row button')?.focus({ preventScroll: true });
  }

  /** The scroll container moved: freeze the newest edge while the reader is down in the list. */
  onScroll() {
    if (this.store.mode !== 'live' || !this.el.isConnected) return;
    const sc = this.scroller();
    const list = this.el.querySelector<HTMLElement>('[data-ref="list"]');
    if (!sc || !list) return;
    const away = list.getBoundingClientRect().top < sc.getBoundingClientRect().top - 48;
    if (away && this.frozenAt === null) {
      const first = this.el.querySelector<HTMLElement>('.fe-row');
      const k = first?.dataset['newest'];
      this.frozenAt = k ? Number(k.split(':')[0]) : this.store.tick;
    } else if (!away && this.frozenAt !== null) {
      this.frozenAt = null;
      this.lastKey = '';
      this.update();
    }
  }

  /* ---------------------------------------------------------- render */

  update() {
    const s = this.store;
    const w = s.world;
    if (!w) return;
    if (s.mode !== 'live') this.frozenAt = null;
    // A linked revision (cloud or timeline marker) must be on screen: page to it and open its run.
    let wantSeq = false;
    if (s.highlight && this.scrolledSeq !== s.highlightSeq) {
      wantSeq = true;
      for (let p = this.pages; p <= MAX_ROWS / PAGE; p++) {
        const r = this.rows(p * PAGE).rows.find((r) => r.entries.some((e) => keyOf(e) === s.highlight));
        if (r) {
          this.pages = p;
          if (r.entries.length > 1 && keyOf(r.entries[0]!) !== s.highlight) this.expanded.add(r.id);
          break;
        }
        if (p * PAGE > this.rows(p * PAGE).rows.length) break;
      }
    }
    const { rows, more, newer } = this.rows(this.pages * PAGE);
    const pill = this.el.querySelector<HTMLElement>('.new-pill');
    if (pill) {
      pill.hidden = newer === 0;
      pill.textContent = `${newer} new decision${newer === 1 ? '' : 's'} · show`;
    }
    const key = [
      this.filter,
      this.robotId,
      this.pages,
      s.highlight,
      [...this.expanded].join(','),
      more,
      rows.map((r) => `${keyOf(r.entries[0]!)}x${r.entries.length}${r.entries[0]!.actions.map((_, i) => this.status(r.entries[0]!, i)[0]).join('')}`).join(','),
      clockOf(w.clock.tick, w.clock).day,
    ].join('|');
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.render(rows);
      this.renderMore(false, more);
    }
    if (wantSeq) {
      this.scrolledSeq = s.highlightSeq;
      this.el.querySelector<HTMLElement>(`[data-entry="${s.highlight}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  private render(rows: Row[]) {
    const list = this.el.querySelector<HTMLElement>('[data-ref="list"]');
    if (!list) return;
    const s = this.store;
    const w = s.world!;
    const focus = document.activeElement as HTMLElement | null;
    const focusSel = focus && list.contains(focus) ? (focus.dataset['key'] ? `[data-key="${focus.dataset['key']}"][data-feed="${focus.dataset['feed'] ?? ''}"]` : focus.dataset['id'] ? `[data-feed="expand"][data-id="${focus.dataset['id']}"]` : null) : null;
    this.byKey.clear();
    this.runs.clear();
    if (!rows.length) {
      list.innerHTML = `<p class="feed-empty">${
        this.filter === 'all'
          ? '<strong>No decisions recorded yet.</strong> Entries appear here as the brain wakes on events.'
          : this.filter === 'problems'
            ? '<strong>No problems in the loaded history.</strong> Refused and failed steps and fallbacks show here.'
            : '<strong>Nothing matches this filter yet.</strong>'
      }</p>`;
      return;
    }
    // Group rows by in-world hour, newest first.
    const groups: { id: string; label: string; rows: Row[] }[] = [];
    for (const r of rows) {
      const ck = clockOf(r.entries[0]!.tick, w.clock);
      const h = ck.time.slice(0, 2);
      const id = `${ck.day}-${h}`;
      let g = groups[groups.length - 1];
      if (!g || g.id !== id) {
        const next = String((Number(h) + 1) % 24).padStart(2, '0');
        g = { id, label: `Day ${ck.day} · ${h}:00–${next}:00`, rows: [] };
        groups.push(g);
      }
      g.rows.push(r);
    }
    list.innerHTML = groups
      .map((g) => {
        const n = g.rows.reduce((a, r) => a + r.entries.length, 0);
        return `<section class="fe-group" aria-labelledby="feh-${g.id}">
          <h3 class="fe-group-h" id="feh-${g.id}"><span>${g.label}</span><span class="fe-group-n">${n} decision${n === 1 ? '' : 's'}</span></h3>
          <ol class="fe-list">${g.rows.map((r) => this.rowHtml(r)).join('')}</ol>
        </section>`;
      })
      .join('');
    if (focusSel) list.querySelector<HTMLElement>(focusSel)?.focus({ preventScroll: true });
    this.pop.rebind(list);
  }

  private renderMore(loading: boolean, more?: boolean) {
    const host = this.el.querySelector<HTMLElement>('[data-ref="more"]');
    if (!host) return;
    if (loading) {
      host.innerHTML = `<button type="button" class="btn" disabled>Loading older…</button>`;
      return;
    }
    const capped = this.pages * PAGE >= MAX_ROWS;
    host.innerHTML = this.loadError
      ? `<p class="field-error" role="alert">${esc(this.loadError)}</p><button type="button" class="btn" data-feed="older">Try again</button>`
      : more && !capped
        ? `<button type="button" class="btn" data-feed="older">Load older</button>`
        : capped
          ? `<p class="hint">That’s the last ${MAX_ROWS} entries. Scrub the timeline back to see earlier decisions.</p>`
          : this.el.querySelector('.fe-row')
            ? `<p class="hint">Start of the recorded feed.</p>`
            : '';
  }

  private steps(e: FeedEntry): string {
    const s = this.store;
    const who = this.robotId ? '' : `<span class="fe-who">${esc(s.nameOf(e.characterId))}</span> `;
    const steps = e.actions
      .map((a, i) => {
        const st = this.status(e, i);
        // A go-to without a target is heading for the next step's target; a last one is a spot on the floor.
        const nx = e.actions[i + 1];
        const nextT = nx && nx.verb !== 'moveTo' ? nx.targetId : undefined;
        const words = a.verb === 'moveTo' && !a.targetId ? (nextT ? say(s, 'moveTo', nextT) : 'go to a spot') : say(s, a.verb, a.targetId);
        const txt = i === 0 ? cap(words) : words;
        // Only problems are marked: "done" is the normal case and "queued" is often never updated in history.
        const mark = st === 'rejected' || st === 'failed' ? ` <span class="st st-${st}">${st}</span>` : st === 'superseded' ? ' <span class="st st-superseded">replaced</span>' : '';
        return `<span class="fe-step${st === 'rejected' || st === 'failed' ? ' is-bad' : st === 'superseded' ? ' is-dropped' : ''}">${esc(txt)}${mark}</span>`;
      })
      .join('<span class="fe-then" aria-label="then"> → </span>');
    const notes = e.notes?.length ? ` <span class="notes">${esc(e.notes.join(' · '))}</span>` : '';
    return `${who}${steps}${notes}`;
  }

  private problems(e: FeedEntry): string {
    const out: string[] = [];
    const o = this.store.stepOutcomes(e);
    e.actions.forEach((a, i) => {
      const st = this.status(e, i);
      const why = o[i]?.why || a.result;
      if ((st === 'rejected' || st === 'failed') && why) out.push(`<p class="fe-problem"><strong>${st === 'rejected' ? 'Refused' : 'Failed'}:</strong> ${esc(say(this.store, a.verb, a.targetId))} · ${esc(why)}</p>`);
    });
    if (!out.length && !this.badStep(e) && this.refusedKeys.has(keyOf(e)))
      out.push(`<p class="fe-problem"><strong>Refused:</strong> a step didn’t go through, so the robot decided again.</p>`);
    if (e.tier === 'fallback') out.push(`<p class="fe-problem"><strong>Fallback:</strong> ${esc(e.reason ?? 'no model answered in time')}</p>`);
    return out.join('');
  }

  private metaBits(e: FeedEntry, opts: { time: string; rev?: boolean; run?: FeedEntry[] }): string {
    const s = this.store;
    const k = keyOf(e);
    const on = s.highlight === k;
    const warn = this.bad(e);
    const n = s.rev(e);
    const run = opts.run ?? [e];
    const aud = run.reduce((a, x) => a + (x.usage?.costAud ?? 0), 0);
    const bat = run.reduce((a, x) => a + (x.energyCost ?? 0), 0);
    const cost = run.some((x) => x.usage) ? `${opts.run ? 'total ' : ''}${fmtAud(aud)}${bat ? ` · −${fmtPct(bat)} battery` : ''}` : 'free';
    this.byKey.set(k, e);
    const mixed = new Set(run.map((x) => x.tier)).size > 1;
    const tpl = (e as FeedEntry & { template?: { id: string; version: number } }).template;
    if (opts.run) this.runs.set(k, run);
    const rev =
      opts.rev === false
        ? ''
        : `<button type="button" class="rev-btn" data-action="rev" data-key="${k}" data-feed="rev" aria-pressed="${on}" aria-label="Revision ${n}${warn ? ', needs attention' : ''}: show on the plan and timeline">${deltaSvg(warn, on)}<span>${n}</span></button>`;
    return `${rev}
      <span class="fe-time">${opts.time}</span>
      <button type="button" class="tier-btn tier-${mixed ? 'mixed' : e.tier}" data-feed="tier" data-key="${k}" aria-expanded="false" aria-controls="tier-pop" aria-label="${mixed ? 'Mixed tiers' : `${depthOf(e).depth ? `${DEPTH_SHORT[depthOf(e).depth!]}, ` : ''}${TIER_LABEL[e.tier]}`}${e.modelId && !mixed ? `, ${esc(e.modelId)}` : ''}: model and cost details">${tierBars(e.tier)}<span>${mixed ? 'Mixed' : depthOf(e).depth ? DEPTH_SHORT[depthOf(e).depth!] : TIER_SHORT[e.tier]}</span>${!mixed && tpl ? `<span class="fe-tpl">${esc(tpl.id)}@${tpl.version}</span>` : ''}</button>
      <span class="fe-cost">${cost}</span>`;
  }

  private rowHtml(r: Row): string {
    const s = this.store;
    const w = s.world!;
    const e = r.entries[0]!;
    // A system line (e.g. "prompt template plan@2 activated"): an admin action, not a decision.
    const sys = (e as FeedEntry & { system?: string }).system;
    if (sys && !e.actions.length)
      return `<li class="fe-row fe-system" data-entry="${keyOf(e)}" data-newest="${keyOf(e)}"><p class="fe-meta"><span class="fe-time">${clockOf(e.tick, w.clock).time}</span><span class="fe-sys">${esc(cap(sys))}</span></p></li>`;
    const n = r.entries.length;
    const warn = this.bad(e);
    const lit = r.entries.some((x) => keyOf(x) === s.highlight);
    const reason = e.actions[0]?.reason ? `<p class="fe-why">${esc(quote(e.actions[0].reason))}</p>` : '';
    if (n === 1) {
      return `<li class="fe-row${warn ? ' is-warn' : ''}${lit ? ' is-lit' : ''}" data-entry="${keyOf(e)}" data-newest="${keyOf(e)}">
        <p class="fe-do">${this.steps(e)}</p>
        ${this.problems(e)}${reason}
        <p class="fe-meta">${this.metaBits(e, { time: clockOf(e.tick, w.clock).time })}</p>
      </li>`;
    }
    const first = r.entries[n - 1]!;
    const span = `${clockOf(first.tick, w.clock).time}–${clockOf(e.tick, w.clock).time}`;
    const open = this.expanded.has(r.id);
    const subId = `fes-${r.id.replace(':', '-')}`;
    const sub = open
      ? `<ol class="fe-sub" id="${subId}">${r.entries
          .map((x) => {
            const why = x.actions[0]?.reason && x.actions[0].reason !== e.actions[0]?.reason ? `<span class="fe-sub-why">${esc(quote(x.actions[0].reason))}</span>` : '';
            return `<li class="fe-sub-row${keyOf(x) === s.highlight ? ' is-lit' : ''}" data-entry="${keyOf(x)}"><p class="fe-meta">${this.metaBits(x, { time: clockOf(x.tick, w.clock).time })}</p>${why}</li>`;
          })
          .join('')}</ol>`
      : '';
    // A run that keeps restarting after refusals is the robot stuck in a loop: say so plainly.
    const refusedRun = r.entries.filter((x) => x.trigger === 'action-rejected').length;
    const loop =
      refusedRun * 2 >= n
        ? `<p class="fe-problem"><strong>Stuck:</strong> the same decision ${n} times in a row${refusedRun === n ? ', each one after the last attempt was refused' : `, ${refusedRun} of them after a refusal`}.</p>`
        : '';
    // Entries inside a closed run still resolve for the detail popover (its newest entry has the button).
    for (const x of r.entries) this.byKey.set(keyOf(x), x);
    return `<li class="fe-row fe-run${warn || loop ? ' is-warn' : ''}${lit && !open ? ' is-lit' : ''}" data-entry="${keyOf(e)}" data-newest="${keyOf(e)}">
      <p class="fe-do">${this.steps(e)} <span class="fe-times" aria-label="${n} times in a row">×${n}</span></p>
      ${loop}${this.problems(e)}${reason}
      <p class="fe-meta">${this.metaBits(e, { time: span, rev: false, run: r.entries })}
        <button type="button" class="link-btn fe-expand" data-feed="expand" data-id="${r.id}" aria-expanded="${open}" ${open ? `aria-controls="${subId}"` : ''}>${open ? 'Hide' : `Show all ${n}`}</button></p>
      ${sub}
    </li>`;
  }
}

/* -------------------------------------------------------- tier detail popover */

/**
 * One shared, non-modal detail box for the tier marks. Opens on hover and keyboard focus (and
 * closes when they leave), and pins open on click or tap; Escape closes it and returns focus.
 * Uses the Popover API (top layer) so the inspector's scroll box never clips it.
 */
class TierPopover {
  private el: HTMLElement;
  private owner: HTMLElement | null = null;
  private pinned = false;
  private quiet = false;
  private hoverMuted = false;
  private hideTimer: number | undefined;

  constructor(
    private store: ViewerStore,
    private lookup: (key: string) => FeedEntry | undefined,
    private runOf: (key: string) => FeedEntry[] | undefined,
  ) {
    this.el = document.getElementById('tier-pop') ?? document.createElement('div');
    this.el.id = 'tier-pop';
    this.el.className = 'tier-pop';
    this.el.setAttribute('popover', 'manual');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Decision detail');
    this.el.tabIndex = -1;
    if (!this.el.isConnected) document.body.append(this.el);
    this.el.addEventListener('mouseenter', () => window.clearTimeout(this.hideTimer));
    this.el.addEventListener('mouseleave', () => this.softHide());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.owner) {
        const key = this.owner.dataset['key'];
        const o = this.owner.isConnected ? this.owner : (document.querySelector<HTMLElement>(`[data-feed="tier"][data-key="${key}"]`) ?? this.owner);
        this.hide();
        // Returning focus must not reopen it through the focus handler.
        this.quiet = true;
        o.focus();
        this.quiet = false;
        // A list re-render under a still pointer fires mouseover again: ignore hover until it moves.
        this.hoverMuted = true;
        e.stopPropagation();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.owner || !this.pinned) return;
      const t = e.target as Node;
      if (!this.el.contains(t) && !this.owner.contains(t)) this.hide();
    });
  }

  attach(root: HTMLElement) {
    const btn = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('[data-feed="tier"]');
    document.addEventListener('pointermove', () => (this.hoverMuted = false), { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') this.hoverMuted = false;
    });
    root.addEventListener('mouseover', (e) => {
      const b = btn(e);
      if (b && !this.pinned && !this.hoverMuted) this.show(b, false);
    });
    root.addEventListener('mouseout', (e) => {
      const b = btn(e);
      if (b && b === this.owner && !this.pinned && !b.contains(e.relatedTarget as Node)) this.softHide();
    });
    root.addEventListener('focusin', (e) => {
      const b = btn(e);
      // after Escape, a focus restored by a list re-render must not reopen it (until a key or the pointer moves on)
      if (b && !this.quiet && !this.hoverMuted && b.matches(':focus-visible') && !this.pinned) this.show(b, false);
    });
    root.addEventListener('focusout', (e) => {
      const b = btn(e);
      if (b && b === this.owner && !this.pinned && !this.el.contains(e.relatedTarget as Node)) this.hide();
    });
    root.addEventListener('click', (e) => {
      const b = btn(e);
      if (!b) return;
      if (this.owner === b && this.pinned) this.hide();
      else this.show(b, true);
    });
  }

  /** The list re-rendered: move the open box to the new button for the same entry, or close it. */
  rebind(root: HTMLElement) {
    if (!this.owner || this.owner.isConnected) return;
    const b = root.querySelector<HTMLElement>(`[data-feed="tier"][data-key="${this.owner.dataset['key']}"]`);
    if (!b) return this.hide();
    const hadFocus = document.activeElement === document.body;
    this.owner = b;
    b.setAttribute('aria-expanded', 'true');
    b.setAttribute('aria-describedby', 'tier-pop');
    if (hadFocus && this.pinned) b.focus({ preventScroll: true });
  }

  private softHide() {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (!this.pinned) this.hide();
    }, 160);
  }

  hide() {
    window.clearTimeout(this.hideTimer);
    this.owner?.setAttribute('aria-expanded', 'false');
    this.owner?.removeAttribute('aria-describedby');
    this.owner = null;
    this.pinned = false;
    try {
      this.el.hidePopover();
    } catch {
      /* already hidden */
    }
  }

  private show(b: HTMLElement, pin: boolean) {
    window.clearTimeout(this.hideTimer);
    const e = this.lookup(b.dataset['key'] ?? '');
    if (!e) return;
    if (this.owner && this.owner !== b) this.owner.setAttribute('aria-expanded', 'false');
    this.owner?.removeAttribute('aria-describedby');
    this.owner = b;
    this.pinned = pin;
    b.setAttribute('aria-expanded', 'true');
    b.setAttribute('aria-describedby', 'tier-pop');
    this.el.innerHTML = this.html(e, this.runOf(b.dataset['key'] ?? ''));
    try {
      this.el.showPopover();
    } catch {
      /* already open */
    }
    // Place below the mark (above when there's no room), inside the viewport.
    const r = b.getBoundingClientRect();
    const pw = this.el.offsetWidth;
    const ph = this.el.offsetHeight;
    const x = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
    const below = r.bottom + 6 + ph < window.innerHeight - 8;
    const y = below ? r.bottom + 6 : Math.max(8, r.top - 6 - ph);
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
    // Pinned by click, tap or Enter: move into the box so it can be read; Escape comes back.
    if (pin) this.el.focus({ preventScroll: true });
  }

  private html(e: FeedEntry, run?: FeedEntry[]): string {
    const s = this.store;
    const w = s.world;
    const ck = w ? clockOf(e.tick, w.clock) : null;
    const u = e.usage;
    const n = (v: number) => v.toLocaleString('en-AU');
    // Text models (plans, or a chat model answering a decision) have no real score.
    const conf =
      e.confidence !== undefined && (e.tier === 'decision' || e.confidence < 1)
        ? e.confidence.toFixed(2)
        : e.tier === 'decision'
          ? 'No score'
          : MODEL_TIERS.has(e.tier)
            ? 'Plan, no score'
            : 'No score (no model call)';
    const m = s.catalog?.models?.find((x) => x.id === e.modelId);
    const model = e.modelId
      ? `<span class="mono">${esc(m?.model ?? e.modelId)}</span>${m?.model && m.model !== e.modelId ? ` <span class="tp-sub">as ${esc(e.modelId)}</span>` : ''}`
      : 'None';
    const provider = m ? `${esc(m.provider ?? m.adapter)}${m.local ? ' · on this server' : ' · hosted'}` : null;
    const rows: [string, string][] = [];
    if (run && run.length > 1) {
      const by = new Map<Tier, number>();
      for (const x of run) by.set(x.tier, (by.get(x.tier) ?? 0) + 1);
      const aud = run.reduce((a, x) => a + (x.usage?.costAud ?? 0), 0);
      rows.push(['Run', `${run.length} decisions: ${[...by].map(([t, c]) => `${c} ${TIER_LABEL[t]}`).join(', ')} · ${aud ? `${fmtAud(aud)} in all` : 'all free'}. Details below are the newest.`]);
    }
    rows.push(
      ...(depthOf(e).depth
        ? ([['Chose', `<strong>${DEPTH_MEANS[depthOf(e).depth!]}</strong>${depthOf(e).depthWhy ? ` <span class="tp-sub">(${esc(depthOf(e).depthWhy!)})</span>` : ''}`]] as [string, string][])
        : []),
      ['Tier', `<strong>${TIER_LABEL[e.tier]}</strong>. ${TIER_MEANS[e.tier]}`],
      ['Model', model],
      ...((): [string, string][] => {
        // The prompt template and version that made this call (iteration 2, Stage 3).
        const tp = (e as FeedEntry & { template?: { id: string; version: number } }).template;
        return tp ? [['Prompt', `<span class="mono">${esc(tp.id)}@${tp.version}</span>`]] : [];
      })(),
      ...(provider ? ([['Provider', provider]] as [string, string][]) : []),
      ['Confidence', conf],
    );
    if (e.escalated) rows.push(['Escalated', `The decision model (${esc(e.escalated.from)}) was unsure at ${e.escalated.confidence.toFixed(2)}, so a text model planned this.`]);
    if (u) {
      rows.push(['Latency', u.latencyMs >= 1000 ? `${(u.latencyMs / 1000).toFixed(1)} s` : `${Math.round(u.latencyMs)} ms`]);
      rows.push(['Tokens', `${n(u.inputTokens)} in (${n(u.cachedInputTokens)} cached) · ${n(u.outputTokens)} out`]);
    }
    rows.push(['Cost', u ? `${fmtAud(u.costAud)}${e.energyCost ? ` · ${fmtPct(e.energyCost)} of the battery` : ''}` : 'Free']);
    rows.push(['Trigger', esc(cap(TRIGGER_LABEL[e.trigger] ?? e.trigger))]);
    const one = e.actions.length === 1 ? e.actions[0]! : null;
    if (one && one.status !== 'queued') rows.push(['Outcome', `${esc(cap(one.status === 'superseded' ? 'replaced by a newer decision' : one.status))}${one.result && one.status !== 'superseded' ? `: ${esc(one.result)}` : ''}`]);
    if (e.actions.length > 1) {
      rows.push([
        'Plan',
        `<ol class="tp-steps">${e.actions
          .map((a) => `<li><strong>${esc(cap(say(s, a.verb, a.targetId)))}</strong> ${esc(quote(a.reason))}${a.status !== 'queued' ? ` <span class="tp-sub">${esc(a.status === 'superseded' ? 'replaced' : a.status)}${a.result ? `: ${esc(a.result)}` : ''}</span>` : ''}</li>`)
          .join('')}</ol>`,
      ]);
    }
    return `<p class="tp-head">${esc(s.nameOf(e.characterId))} · ${ck ? `day ${ck.day}, ${ck.time}` : `tick ${e.tick}`}</p>
      <dl class="tp-list">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }
}

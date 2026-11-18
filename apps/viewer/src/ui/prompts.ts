/**
 * The Prompts page (admins; docs/architecture/prompts.md): the five templates, an editor per part
 * with the locked safety block read-only, the variable list (click to insert; prefix parts only
 * offer prefix variables), live validation with errors by part and line and a token estimate, a
 * live preview against a saved situation, a per-part line diff against the active version, Save
 * with a note, Test (estimate → confirm → progress → results against the baseline), Activate and
 * Roll back with a confirmation naming the world, and the version history.
 */
import {
  VisitorError,
  type AuthState,
  type PromptBody,
  type PromptIssue,
  type PromptPreview,
  type PromptSituation,
  type PromptSummary,
  type PromptTemplate,
  type PromptTestStatus,
  type PromptValidation,
  type PromptsApi,
  type WorldPrompts,
} from '../types.ts';
import { esc, fmtAud } from './format.ts';
import { withParam } from './catalogue.ts';

const VALIDATE_MS = 350;
const PREVIEW_MS = 500;
type Side = 'vars' | 'preview' | 'diff' | 'test' | 'history';
const SIDES: { id: Side; label: string }[] = [
  { id: 'vars', label: 'Variables' },
  { id: 'preview', label: 'Preview' },
  { id: 'diff', label: 'Diff' },
  { id: 'test', label: 'Test' },
  { id: 'history', label: 'History' },
];

const errMsg = (e: unknown) => (e instanceof VisitorError ? e.message : (e as Error).message ?? String(e));
const lineOf = (text: string, index?: number) => (index === undefined ? null : text.slice(0, index).split('\n').length);
const when = (iso: string) => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Line diff by longest common subsequence (parts are at most 4,000 characters, so this stays small). */
export function lineDiff(a: string, b: string): { op: ' ' | '-' | '+'; text: string }[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = A[i] === B[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { op: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ op: ' ', text: A[i]! });
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ op: '-', text: A[i++]! });
    else out.push({ op: '+', text: B[j++]! });
  }
  while (i < n) out.push({ op: '-', text: A[i++]! });
  while (j < m) out.push({ op: '+', text: B[j++]! });
  return out;
}

export class PromptsPage {
  readonly el = document.createElement('div');
  private auth: AuthState | null = null;
  private visible = false;
  private list: PromptSummary[] = [];
  private tpl: PromptTemplate | null = null;
  private world: WorldPrompts | null = null;
  private situations: PromptSituation[] = [];
  private tid = '';
  /** The version the editor started from, and its text (for "unsaved"). */
  private baseVersion = 0;
  private baseBody: PromptBody = { parts: {} };
  private activeBody: PromptBody | null = null;
  private body: PromptBody = { parts: {} };
  private validation: PromptValidation | null = null;
  private preview: PromptPreview | null = null;
  private previewErr = '';
  private situation = '';
  private side: Side = 'vars';
  private focusPart = '';
  private note = '';
  private status = '';
  private confirm: null | { kind: 'activate' | 'rollback' | 'test'; version?: number; estimate?: { calls: number; aud: number; minutes: number } } = null;
  private testId: string | null = null;
  private testStatus: PromptTestStatus | null = null;
  private testErr = '';
  private vTimer: number | undefined;
  private pTimer: number | undefined;
  private poll: number | undefined;
  private seq = 0;
  private vSeq = 0;
  private loadErr = '';

  constructor(
    private readonly api: PromptsApi | undefined,
    private readonly worldName: () => string,
  ) {
    this.el.className = 'prompts';
    this.el.addEventListener('click', (e) => void this.onClick(e));
    this.el.addEventListener('input', (e) => this.onInput(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('focusin', (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset['part'] && t.tagName === 'TEXTAREA' && this.focusPart !== t.dataset['part']) {
        this.focusPart = t.dataset['part'];
        if (this.side === 'vars') this.drawSide();
      }
    });
    this.el.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && this.tpl) {
        e.preventDefault();
        void this.save();
      }
      if (e.key === 'Escape' && this.confirm) {
        this.confirm = null;
        this.drawActions();
        if (this.side === 'test') this.drawSide();
      }
      // Tool tabs: arrows, Home and End move between them (focus follows selection).
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.pr-tabs [role="tab"]');
      if (tab && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const i = SIDES.findIndex((s) => s.id === this.side);
        const n = e.key === 'Home' ? 0 : e.key === 'End' ? SIDES.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + SIDES.length) % SIDES.length;
        this.selectSide(SIDES[n]!.id);
        this.el.querySelector<HTMLElement>(`#pr-tab-${this.side}`)?.focus();
      }
    });
  }

  private want: string | null = null;

  setAuth(a: AuthState | null) {
    this.auth = a;
    if (this.visible) void this.show(this.want ?? (this.tid || null));
  }

  /** The world's name arrived or changed: refresh the places that name it. */
  worldChanged() {
    if (!this.visible || !this.tpl) return;
    const name = this.worldName();
    for (const el of this.el.querySelectorAll<HTMLElement>('[data-world-name]')) if (el.textContent !== name) el.textContent = name;
  }

  hide() {
    this.visible = false;
    window.clearInterval(this.poll);
  }

  async show(tid?: string | null) {
    this.visible = true;
    if (tid) this.want = tid;
    if (this.auth?.role !== 'admin' || !this.api) {
      this.el.innerHTML = `<div class="cat-denied"><h1 class="draft-h big">Prompts</h1><p>${!this.api ? 'This data source has no prompt templates.' : 'Only admins can edit prompt templates.'}</p></div>`;
      return;
    }
    if (!this.list.length) {
      this.el.innerHTML = `<p class="hint">Loading templates…</p>`;
      try {
        [this.list, this.situations, this.world] = await Promise.all([this.api.list(), this.api.situations(), this.api.world()]);
        this.loadErr = '';
      } catch (e) {
        this.loadErr = errMsg(e);
        this.el.innerHTML = `<div class="cat-denied"><h1 class="draft-h big">Prompts</h1><p class="field-error" role="alert">Couldn’t load the templates: ${esc(this.loadErr)}</p></div>`;
        return;
      }
    }
    const want = this.want;
    await this.open(want && this.list.some((t) => t.id === want) ? want : (this.tid || this.list[0]?.id || ''));
  }

  private activeOf(tid: string) {
    return this.world?.active[tid] ?? 1;
  }

  /** Open a template in the editor at a version (default: its latest). */
  private async open(tid: string, version?: number) {
    if (!this.api || !tid) return;
    const n = ++this.seq;
    try {
      const tpl = await this.api.get(tid);
      const latest = tpl.versions[tpl.versions.length - 1]!.version;
      const v = version ?? latest;
      const [cur, act] = await Promise.all([this.api.version(tid, v), this.api.version(tid, this.activeOf(tid))]);
      if (n !== this.seq) return;
      if (tid !== this.tid) {
        this.testId = null;
        this.testStatus = null;
        window.clearInterval(this.poll);
      }
      this.tid = tid;
      this.tpl = tpl;
      this.baseVersion = v;
      this.baseBody = structuredClone(cur.body);
      this.body = structuredClone(cur.body);
      this.activeBody = act.body;
      this.focusPart = tpl.parts[0] ?? '';
      this.confirm = null;
      this.status = '';
      this.note = '';
      const sits = this.situations.filter((s) => s.templates.includes(tid));
      if (!sits.some((s) => s.id === this.situation)) this.situation = sits[0]?.id ?? '';
      history.replaceState(null, '', withParam('template', tid));
      this.render();
      void this.validate();
      void this.renderPreview();
    } catch (e) {
      this.status = `Couldn’t open ${tid}: ${errMsg(e)}`;
      this.render();
    }
  }

  private get dirty() {
    return JSON.stringify(this.body.parts) !== JSON.stringify(this.baseBody.parts);
  }

  /* ------------------------------------------------------------------ render */

  private render() {
    const t = this.tpl;
    if (!t) return;
    const latest = t.versions[t.versions.length - 1]!.version;
    const active = this.activeOf(t.id);
    this.el.innerHTML = `
      <nav class="pr-list" aria-labelledby="pr-h">
        <h1 id="pr-h" class="draft-h big">Prompts</h1>
        <p class="sub">Active versions are for <strong data-world-name>${esc(this.worldName())}</strong>.</p>
        <ul>${this.list
          .map((x) => {
            const a = this.activeOf(x.id);
            return `<li><button type="button" class="pr-tpl" data-act="open" data-id="${esc(x.id)}" ${x.id === t.id ? 'aria-current="true"' : ''}>
              <span class="pr-tpl-name">${esc(x.name)}</span>
              <span class="pr-tpl-v"><span class="state-chip">v${a} active</span>${x.latestVersion > a ? ` <span class="sub">latest v${x.latestVersion}</span>` : ''}</span>
            </button></li>`;
          })
          .join('')}</ul>
      </nav>
      <div class="pr-main">
        <header class="pr-head">
          <div>
            <h2 class="draft-h">${esc(t.name)} <span class="h-note mono">${esc(t.id)}</span></h2>
            <p class="sub">${esc(t.description)}</p>
          </div>
          <div class="pr-head-meta">
            <label class="pr-version">Editing <select data-ref="version">${[...t.versions]
              .reverse()
              .map((v) => `<option value="${v.version}"${v.version === this.baseVersion ? ' selected' : ''}>v${v.version}${v.version === active ? ' · active' : ''}${v.version === latest ? ' · latest' : ''}</option>`)
              .join('')}</select></label>
            <span class="pr-dirty" data-ref="dirty"></span>
            <span class="pr-tokens" data-ref="tokens" aria-live="polite"></span>
          </div>
        </header>
        <div class="pr-world" data-ref="world"></div>
        <div class="pr-work">
          <div class="pr-parts">${t.parts.map((p) => this.partHtml(p)).join('')}
            ${t.safetyBlock ? `<section class="pr-safety" aria-labelledby="pr-safety-h"><h3 id="pr-safety-h" class="pr-part-h">Locked safety block <span class="h-note">appended by code to ${t.parts.includes('rules') ? 'rules' : 'system'}; can’t be edited</span></h3><pre class="pr-code is-locked">${esc(t.safetyBlock)}</pre></section>` : ''}
          </div>
          <aside class="pr-side" aria-label="Template tools">
            <div class="tabs pr-tabs" role="tablist" aria-label="Template tools">${SIDES.map((s) => `<button type="button" role="tab" class="tab" id="pr-tab-${s.id}" data-act="side" data-id="${s.id}" aria-selected="${s.id === this.side}" aria-controls="pr-panel" tabindex="${s.id === this.side ? 0 : -1}">${s.label}</button>`).join('')}</div>
            <div id="pr-panel" role="tabpanel" aria-labelledby="pr-tab-${this.side}" data-ref="side"></div>
          </aside>
        </div>
        <div class="pr-actions" data-ref="actions"></div>
      </div>`;
    this.drawChecks();
    this.drawSide();
    this.drawActions();
  }

  private partHtml(p: string): string {
    const t = this.tpl!;
    const prefix = t.prefixParts?.includes(p) ?? false;
    const text = this.body.parts[p] ?? '';
    return `<section class="pr-part" data-sec="${esc(p)}">
      <h3 class="pr-part-h"><label for="pr-part-${esc(p)}">${esc(p)}</label>${prefix ? ' <span class="state-chip" title="Cached prefix: only prefix variables">prefix</span>' : ''}<span class="pr-count" data-count="${esc(p)}">${text.length.toLocaleString('en-AU')} / 4,000</span></h3>
      <textarea id="pr-part-${esc(p)}" class="pr-code pr-input" data-part="${esc(p)}" spellcheck="false" autocapitalize="off" autocomplete="off" rows="${Math.min(14, Math.max(3, Math.ceil(text.length / 70) + text.split('\n').length))}" aria-describedby="pr-err-${esc(p)}">${esc(text)}</textarea>
      <ul class="issues" id="pr-err-${esc(p)}" data-errs="${esc(p)}"></ul>
    </section>`;
  }

  /** Gutters, per-part error lists, token estimate and the "unsaved" note. */
  private drawChecks() {
    const t = this.tpl;
    if (!t) return;
    const v = this.validation;
    for (const p of t.parts) {
      const text = this.body.parts[p] ?? '';
      const errs = (v?.errors ?? []).filter((e) => e.part === p);
      const warns = (v?.warnings ?? []).filter((w): w is PromptIssue => typeof w !== 'string' && w.part === p);
      const ta = this.el.querySelector<HTMLElement>(`textarea[data-part="${p}"]`);
      ta?.setAttribute('aria-invalid', String(errs.length > 0));
      const list = this.el.querySelector<HTMLElement>(`[data-errs="${p}"]`);
      if (list)
        list.innerHTML = [
          ...errs.map((e) => {
            const ln = lineOf(text, e.index);
            return `<li class="is-err">${ln ? `<button type="button" class="link-btn" data-act="goto" data-part="${esc(p)}" data-index="${e.index}">Line ${ln}</button> ` : ''}${esc(e.message)}</li>`;
          }),
          ...warns.map((w) => `<li class="is-warn">${esc(w.message)}</li>`),
        ].join('');
      const c = this.el.querySelector<HTMLElement>(`[data-count="${p}"]`);
      if (c) {
        c.textContent = `${text.length.toLocaleString('en-AU')} / 4,000`;
        c.classList.toggle('is-over', text.length > 4000);
      }
    }
    const tok = this.el.querySelector<HTMLElement>('[data-ref="tokens"]');
    if (tok)
      tok.innerHTML = v
        ? `≈ ${v.tokens.toLocaleString('en-AU')} tokens · ${v.errors.length ? `<button type="button" class="link-btn field-error-inline" data-act="first-error">${v.errors.length} error${v.errors.length === 1 ? '' : 's'}</button>` : 'valid'}${v.warnings.length ? ` · ${v.warnings.length} warning${v.warnings.length === 1 ? '' : 's'}` : ''}`
        : 'Checking…';
    const d = this.el.querySelector<HTMLElement>('[data-ref="dirty"]');
    if (d) d.textContent = this.dirty ? `Edited from v${this.baseVersion}, not saved` : '';
  }

  private drawSide() {
    const host = this.el.querySelector<HTMLElement>('[data-ref="side"]');
    const t = this.tpl;
    if (!host || !t) return;
    host.setAttribute('aria-labelledby', `pr-tab-${this.side}`);
    switch (this.side) {
      case 'vars': {
        const prefix = t.prefixParts?.includes(this.focusPart) ?? false;
        const vars = t.variables.filter((v) => !prefix || v.scope === 'prefix');
        host.innerHTML = `<p class="sub">Click to insert into <strong>${esc(this.focusPart)}</strong> at the cursor.${prefix ? ' This is a cached-prefix part, so only prefix variables are offered.' : ''}</p>
          <ul class="pr-vars">${vars
            .map(
              (v) => `<li><button type="button" class="pr-var" data-act="insert" data-name="${esc(v.name)}"><span class="mono">{{${esc(v.name)}}}</span>${v.required ? ' <span class="state-chip">required once</span>' : ''}${v.scope === 'prefix' ? ' <span class="state-chip">prefix</span>' : ''}</button>
                <p class="pr-var-d">${esc(v.description)}</p><pre class="pr-var-ex" aria-label="Example">${esc(v.example)}</pre></li>`,
            )
            .join('')}</ul>`;
        break;
      }
      case 'preview': {
        const sits = this.situations.filter((s) => s.templates.includes(t.id));
        const p = this.preview;
        host.innerHTML = `<label class="pr-field">Situation <select data-ref="situation">${sits.map((s) => `<option value="${esc(s.id)}"${s.id === this.situation ? ' selected' : ''}>${esc(s.title)}</option>`).join('')}</select></label>
          <p class="sub">Rendered exactly as the model sees it, from the editor’s text${this.dirty ? ' (unsaved)' : ''}.${p ? ` ≈ ${p.tokens.toLocaleString('en-AU')} tokens.` : ''}</p>
          ${this.previewErr ? `<p class="field-error" role="alert">${esc(this.previewErr)}</p>` : ''}
          ${p ? `<div class="pr-preview">${t.parts.map((part) => `<p class="pr-pv-h">${esc(part)}</p><pre class="pr-code">${esc(p.parts[part] ?? '')}</pre>`).join('')}${p.safetyBlock && !Object.values(p.parts).some((x) => x.includes(p.safetyBlock.trim())) ? `<p class="pr-pv-h">safety block (locked)</p><pre class="pr-code is-locked">${esc(p.safetyBlock)}</pre>` : ''}</div>` : '<p class="hint">Rendering…</p>'}`;
        break;
      }
      case 'diff': {
        const act = this.activeBody;
        const av = this.activeOf(t.id);
        if (!act) {
          host.innerHTML = '<p class="hint">Loading the active version…</p>';
          break;
        }
        let adds = 0;
        let dels = 0;
        const blocks = t.parts
          .map((part) => {
            const d = lineDiff(act.parts[part] ?? '', this.body.parts[part] ?? '');
            const a = d.filter((x) => x.op === '+').length;
            const r = d.filter((x) => x.op === '-').length;
            adds += a;
            dels += r;
            if (!a && !r) return '';
            return `<p class="pr-pv-h">${esc(part)} <span class="sub">+${a} −${r}</span></p><pre class="pr-diff">${d
              .map((x) => `<span class="d-${x.op === '+' ? 'add' : x.op === '-' ? 'del' : 'same'}"><span class="d-mark" aria-hidden="true">${x.op === ' ' ? ' ' : x.op === '+' ? '+' : '−'}</span><span class="sr-only">${x.op === '+' ? 'added: ' : x.op === '-' ? 'removed: ' : ''}</span>${esc(x.text) || ' '}</span>`)
              .join('')}</pre>`;
          })
          .join('');
        host.innerHTML = `<p class="sub">The editor’s text against <strong>v${av}</strong>, active in ${esc(this.worldName())}: ${adds || dels ? `+${adds} −${dels} lines.` : 'no changes.'}</p>${blocks}`;
        break;
      }
      case 'test':
        this.drawTest(host);
        break;
      case 'history': {
        const hist = this.world?.history.filter((h) => h.tid === t.id) ?? [];
        const active = this.activeOf(t.id);
        host.innerHTML = `<ol class="pr-history" reversed>${[...t.versions]
          .reverse()
          .map((v) => {
            const acts = hist.filter((h) => h.version === v.version);
            return `<li class="${v.version === active ? 'is-active' : ''}">
              <p class="pr-h-line"><strong>v${v.version}</strong>${v.version === active ? ' <span class="state-chip">active</span>' : ''} <span class="sub">${esc(v.createdBy)} · ${when(v.createdAt)}</span></p>
              <p class="pr-h-note">${esc(v.note)}</p>
              ${acts.length ? `<p class="sub">Activated ${acts.map((h) => `${when(h.at)} by ${esc(h.by)}`).join('; ')}</p>` : ''}
              <p class="pr-h-acts"><button type="button" class="link-btn" data-act="load" data-v="${v.version}">Open in editor</button>${v.version !== active ? ` · <button type="button" class="link-btn" data-act="ask-activate" data-v="${v.version}">Activate…</button>` : ''}</p>
            </li>`;
          })
          .join('')}</ol>`;
        break;
      }
    }
  }

  private drawTest(host: HTMLElement) {
    const t = this.tpl!;
    if (t.id !== 'decide' && t.id !== 'plan') {
      host.innerHTML = `<p class="hint">${esc(t.name)} has preview only: there are no situations to test it against yet.</p>`;
      return;
    }
    const s = this.testStatus;
    const c = this.confirm?.kind === 'test' ? this.confirm.estimate : undefined;
    const sitTitle = (id: string) => this.situations.find((x) => x.id === id)?.title ?? id;
    let html = `<p class="sub">Runs the editor’s text${this.dirty ? ' (unsaved)' : ` (v${this.baseVersion})`} against the eval situations, three runs each, with real model calls. Tests share the free-tier rate limit and count towards today’s A$ cap.</p>`;
    if (this.testErr) html += `<p class="field-error" role="alert">${esc(this.testErr)}</p>`;
    if (c) {
      html += `<div class="pr-confirm" role="group" aria-label="Confirm test"><p><strong>${c.calls} model calls · about ${fmtAud(c.aud)} · ~${c.minutes} min.</strong> Run the test?</p>
        <p class="card-actions"><button type="button" class="btn" data-act="run-test">Run test</button><button type="button" class="btn ghost" data-act="cancel">Cancel</button></p></div>`;
    } else if (!s || s.status !== 'running') html += `<p class="card-actions"><button type="button" class="btn" data-act="estimate"${this.validation && !this.validation.ok ? ' disabled' : ''}>Estimate test…</button></p>`;
    if (s) {
      const pct = s.progress.total ? s.progress.done / s.progress.total : 0;
      html += `<div class="pr-progress" role="progressbar" aria-label="Test progress" aria-valuemin="0" aria-valuemax="${s.progress.total}" aria-valuenow="${s.progress.done}"><i style="width:${pct * 100}%"></i></div>
        <p class="sub" aria-live="polite">${s.status === 'running' ? 'Running' : s.status === 'done' ? 'Done' : 'Failed'}: ${s.progress.done} of ${s.progress.total} calls · ${fmtAud(s.aud)}${s.error ? ` · ${esc(s.error)}` : ''}</p>`;
      if (s.results.length)
        html += `<table class="schedule pr-results"><caption class="sr-only">Test results per situation against the active version’s baseline</caption>
          <thead><tr><th scope="col">Situation</th><th scope="col" class="c-num">Passes</th><th scope="col" class="c-num">Baseline</th><th scope="col">Checks</th></tr></thead>
          <tbody>${s.results
            .map((r) => {
              const rate = r.runs ? r.passes / r.runs : 0;
              const base = r.baseline ? r.baseline.passes / r.baseline.runs : null;
              const worse = base !== null && rate < base;
              const better = base !== null && rate > base;
              const failed = (r.checks as ({ name: string; pass: boolean } | string)[]).filter((x) => typeof x !== 'string' && !x.pass).map((x) => (x as { name: string }).name);
              return `<tr class="${worse ? 'is-worse' : ''}"><th scope="row">${esc(sitTitle(r.situation))}</th>
                <td class="c-num">${r.passes}/${r.runs}${better ? ' <span class="sub">better</span>' : worse ? ' <span class="red">worse</span>' : ''}${r.errors ? `<span class="sub">${r.errors} call${r.errors === 1 ? '' : 's'} failed, not scored</span>` : ''}</td>
                <td class="c-num">${r.baseline ? `${r.baseline.passes}/${r.baseline.runs}` : '<span class="nil">—</span>'}</td>
                <td>${failed.length ? `<span class="red">Failed:</span> ${esc(failed.join('; '))}` : '<span class="sub">all passed</span>'}</td></tr>`;
            })
            .join('')}</tbody></table>`;
    }
    host.innerHTML = html;
  }

  private drawActions() {
    const host = this.el.querySelector<HTMLElement>('[data-ref="actions"]');
    const t = this.tpl;
    if (!host || !t) return;
    const world = this.worldName();
    const active = this.activeOf(t.id);
    const hist = this.world?.history.filter((h) => h.tid === t.id) ?? [];
    const prev = hist.length >= 2 ? hist[hist.length - 2]!.version : null;
    const c = this.confirm;
    const bad = !!this.validation && !this.validation.ok;
    let confirmHtml = '';
    if (c?.kind === 'activate')
      confirmHtml = `<div class="pr-confirm" role="alertdialog" aria-labelledby="pr-c-h"><p id="pr-c-h"><strong>Activate ${esc(t.id)} v${c.version} in ${esc(world)}?</strong> It applies to the next ${t.id === 'decide' || t.id === 'plan' ? 'decision, and the cached prefix is rebuilt now' : 'job'}. It’s logged, and Roll back undoes it.</p>
        <p class="card-actions"><button type="button" class="btn" data-act="activate" data-v="${c.version}">Activate in ${esc(world)}</button><button type="button" class="btn ghost" data-act="cancel">Cancel</button></p></div>`;
    if (c?.kind === 'rollback')
      confirmHtml = `<div class="pr-confirm" role="alertdialog" aria-labelledby="pr-c-h"><p id="pr-c-h"><strong>Roll ${esc(t.id)} in ${esc(world)} back to v${prev}?</strong> v${active} stays stored.</p>
        <p class="card-actions"><button type="button" class="btn" data-act="rollback">Roll back in ${esc(world)}</button><button type="button" class="btn ghost" data-act="cancel">Cancel</button></p></div>`;
    const worldHost = this.el.querySelector<HTMLElement>('[data-ref="world"]');
    if (worldHost)
      worldHost.innerHTML = `<p class="pr-world-line"><span>In <strong data-world-name>${esc(world)}</strong>: <strong>v${active}</strong> active.</span>
          ${this.baseVersion !== active && !this.dirty ? `<button type="button" class="btn" data-act="ask-activate" data-v="${this.baseVersion}">Activate v${this.baseVersion}…</button>` : ''}
          ${prev !== null ? `<button type="button" class="btn ghost" data-act="ask-rollback">Roll back to v${prev}…</button>` : ''}</p>
        ${confirmHtml}${this.status ? `<p class="save-state" role="status">${esc(this.status)}</p>` : ''}`;
    host.innerHTML = `
      <div class="pr-save">
        <label for="pr-note" class="draft-label-legend">Note for the new version</label>
        <div class="pr-save-row"><input id="pr-note" data-ref="note" type="text" maxlength="200" placeholder="e.g. List observations nearest first" value="${esc(this.note)}">
        <button type="button" class="btn" data-act="save" ${!this.dirty || bad ? 'disabled' : ''}>Save version</button></div>
      </div>
`;
    worldHost?.querySelector<HTMLElement>('.pr-confirm .btn')?.focus();
  }

  /* ------------------------------------------------------------------ behaviour */

  private onInput(e: Event) {
    const t = e.target as HTMLTextAreaElement | HTMLInputElement;
    if (t.dataset['ref'] === 'note') {
      this.note = t.value;
      return;
    }
    const part = t.dataset['part'];
    if (!part || !this.tpl) return;
    this.body.parts[part] = t.value;
    this.status = '';
    this.drawChecks();
    window.clearTimeout(this.vTimer);
    this.vTimer = window.setTimeout(() => void this.validate(), VALIDATE_MS);
    window.clearTimeout(this.pTimer);
    this.pTimer = window.setTimeout(() => void this.renderPreview(), PREVIEW_MS);
    const save = this.el.querySelector<HTMLButtonElement>('[data-act="save"]');
    if (save) save.disabled = !this.dirty;
  }

  private onChange(e: Event) {
    const t = e.target as HTMLSelectElement;
    if (t.dataset['ref'] === 'version' && this.tpl) {
      if (this.dirty && !window.confirm('Discard your unsaved edits?')) {
        t.value = String(this.baseVersion);
        return;
      }
      void this.open(this.tpl.id, Number(t.value));
    }
    if (t.dataset['ref'] === 'situation') {
      this.situation = t.value;
      void this.renderPreview();
    }
  }

  private async validate() {
    if (!this.api || !this.tpl) return;
    const n = ++this.vSeq;
    try {
      const r = await this.api.validate(this.tpl.id, this.body);
      if (n !== this.vSeq) return;
      this.validation = r;
    } catch (e) {
      this.validation = { ok: false, errors: [{ part: this.tpl.parts[0]!, message: `Couldn’t validate: ${errMsg(e)}` }], warnings: [], tokens: 0 };
    }
    this.drawChecks();
    this.drawActions();
    if (this.side === 'test') this.drawSide();
  }

  private async renderPreview() {
    if (!this.api || !this.tpl || !this.situation) return;
    const tid = this.tpl.id;
    try {
      const p = await this.api.preview(tid, { body: this.body }, this.situation);
      if (tid !== this.tpl?.id) return;
      this.preview = p;
      this.previewErr = '';
    } catch (e) {
      this.previewErr = errMsg(e);
    }
    if (this.side === 'preview') this.drawSide();
  }

  private insert(name: string) {
    const part = this.focusPart || this.tpl?.parts[0];
    const ta = this.el.querySelector<HTMLTextAreaElement>(`textarea[data-part="${part}"]`);
    if (!ta) return;
    ta.focus();
    ta.setRangeText(`{{${name}}}`, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private async save() {
    if (!this.api || !this.tpl || !this.dirty) return;
    await this.validate();
    if (!this.validation?.ok) {
      this.status = 'Fix the errors before saving.';
      return this.drawActions();
    }
    try {
      const { version } = await this.api.save(this.tpl.id, this.body, this.note);
      this.list = await this.api.list();
      await this.open(this.tpl.id, version);
      this.status = `Saved as v${version}. It isn’t active anywhere yet.`;
      this.drawActions();
    } catch (e) {
      this.status = `Couldn’t save: ${errMsg(e)}`;
      this.drawActions();
    }
  }

  private async onClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b || !this.api) return;
    const act = b.dataset['act'];
    const t = this.tpl;
    if (act === 'open' && b.dataset['id'] !== this.tid) {
      if (this.dirty && !window.confirm('Discard your unsaved edits?')) return;
      void this.open(b.dataset['id']!);
    }
    if (act === 'side') this.selectSide(b.dataset['id'] as Side);
    if (act === 'first-error') {
      const link = this.el.querySelector<HTMLElement>('.issues .is-err .link-btn');
      if (link) link.click();
      else this.el.querySelector<HTMLElement>('textarea[aria-invalid="true"]')?.focus();
    }
    if (act === 'insert') this.insert(b.dataset['name']!);
    if (act === 'goto') {
      const ta = this.el.querySelector<HTMLTextAreaElement>(`textarea[data-part="${b.dataset['part']}"]`);
      const i = Number(b.dataset['index']);
      ta?.focus();
      ta?.setSelectionRange(i, i);
    }
    if (!t) return;
    if (act === 'save') await this.save();
    if (act === 'load') {
      if (this.dirty && !window.confirm('Discard your unsaved edits?')) return;
      void this.open(t.id, Number(b.dataset['v']));
    }
    if (act === 'cancel') {
      this.confirm = null;
      this.drawActions();
      if (this.side === 'test') this.drawSide();
    }
    if (act === 'ask-activate') {
      this.confirm = { kind: 'activate', version: Number(b.dataset['v']) };
      this.drawActions();
    }
    if (act === 'ask-rollback') {
      this.confirm = { kind: 'rollback' };
      this.drawActions();
    }
    if (act === 'activate' || act === 'rollback') {
      try {
        if (act === 'activate') await this.api.activate(t.id, Number(b.dataset['v']));
        else await this.api.rollback(t.id);
        this.world = await this.api.world();
        this.list = await this.api.list();
        const now = this.activeOf(t.id);
        const keep = this.dirty ? null : this.baseVersion;
        await this.open(t.id, keep ?? undefined);
        this.status = `${t.id} v${now} is now active in ${this.worldName()}.`;
        this.drawActions();
      } catch (err) {
        this.confirm = null;
        this.status = errMsg(err);
        this.drawActions();
      }
    }
    if (act === 'estimate') {
      this.testErr = '';
      try {
        const r = await this.api.estimate(t.id, { body: this.body });
        this.confirm = { kind: 'test', estimate: r.estimate };
      } catch (err) {
        this.testErr = errMsg(err);
      }
      this.drawSide();
    }
    if (act === 'run-test') {
      this.confirm = null;
      try {
        const { testId } = await this.api.startTest(t.id, { body: this.body });
        this.testId = testId;
        this.testStatus = { status: 'running', progress: { done: 0, total: 0 }, aud: 0, results: [] };
        this.pollTest();
      } catch (err) {
        this.testErr = errMsg(err);
      }
      this.drawSide();
    }
  }

  private selectSide(side: Side) {
    this.side = side;
    for (const tab of this.el.querySelectorAll<HTMLElement>('.pr-tabs [role="tab"]')) {
      const on = tab.dataset['id'] === this.side;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    this.drawSide();
  }

  private pollTest() {
    window.clearInterval(this.poll);
    const tick = async () => {
      if (!this.testId || !this.api) return;
      try {
        this.testStatus = await this.api.test(this.testId);
        if (this.testStatus.status !== 'running') window.clearInterval(this.poll);
      } catch (e) {
        this.testErr = errMsg(e);
        window.clearInterval(this.poll);
      }
      if (this.side === 'test') this.drawSide();
    };
    void tick();
    this.poll = window.setInterval(() => void tick(), 1000);
  }
}

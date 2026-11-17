/**
 * The catalogue page (admins): a drawing register of every item, and a JSON editor with live
 * server validation (errors marked at their lines), a live icon and info-card preview, templates,
 * and save / duplicate / disable / delete. Per-world enabling lives in World settings.
 */
import type { VisitorStore } from '../client/visitors.ts';
import { iconDoc, iconSvg } from '../icons/render.ts';
import { parseIcon } from '../icons/iconlang.ts';
import { VisitorError, type AuthState, type CatalogItem, type ValidationIssue } from '../types.ts';
import { esc } from './format.ts';
import { describeItem } from './visitors.ts';

const VALIDATE_MS = 350;

/** Byte offset of each value in a JSON text, by dotted path (`behaviours.0.needs.energy`). Tolerant: stops at the first syntax error. */
export function locatePaths(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const str = (): string => {
    let s = '';
    i++; // opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        s += text[i + 1] ?? '';
        i += 2;
      } else s += text[i++];
    }
    if (text[i] !== '"') throw new Error('unterminated');
    i++;
    return s;
  };
  const value = (path: string) => {
    ws();
    out.set(path, i);
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Error('key');
        const keyAt = i;
        const k = str();
        const p = path ? `${path}.${k}` : k;
        ws();
        if (text[i++] !== ':') throw new Error(':');
        out.set(`${p}#key`, keyAt);
        value(p);
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') return void i++;
        else throw new Error(',');
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return void i++;
      for (let n = 0; ; n++) {
        value(path ? `${path}.${n}` : String(n));
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return void i++;
        else throw new Error(',');
      }
    }
    if (c === '"') return void str();
    const m = /^[^,}\]\s]+/.exec(text.slice(i));
    if (!m) throw new Error('value');
    i += m[0].length;
  };
  try {
    value('');
  } catch {
    /* partial map is still useful */
  }
  return out;
}

/** The 1-based line an issue's path points at, or the nearest enclosing value's line. */
export function lineOfPath(text: string, map: Map<string, number>, path: string): number {
  const parts = path
    .replace(/^(\$|item)\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  for (let n = parts.length; n >= 0; n--) {
    const p = parts.slice(0, n).join('.');
    const at = map.get(`${p}#key`) ?? map.get(p);
    if (at !== undefined) return text.slice(0, at).split('\n').length;
  }
  return 1;
}

interface Draft {
  /** The saved id this draft edits, or null for a new item. */
  savedId: string | null;
  text: string;
}

export class CataloguePage {
  readonly el = document.createElement('div');
  private draft: Draft | null = null;
  private issues: (ValidationIssue & { line: number })[] = [];
  private valid: CatalogItem | null = null;
  private parsed: unknown = null;
  private status = '';
  private confirmDelete = false;
  private timer: number | undefined;
  private seq = 0;
  private templates: { name: string; item: CatalogItem }[] = [];
  private auth: AuthState | null = null;

  constructor(private readonly visitors: VisitorStore) {
    this.el.className = 'catalogue';
    this.el.addEventListener('click', (e) => void this.onClick(e));
    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLTextAreaElement;
      if (t.dataset['ref'] !== 'json' || !this.draft) return;
      this.draft.text = t.value;
      this.status = '';
      this.drawGutter();
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.validate(), VALIDATE_MS);
    });
    this.el.addEventListener(
      'scroll',
      (e) => {
        const t = e.target as HTMLElement;
        if (t.dataset?.['ref'] === 'json') this.el.querySelector<HTMLElement>('[data-ref="gutter"]')!.scrollTop = t.scrollTop;
      },
      true,
    );
    this.el.addEventListener('keydown', (e) => {
      const t = e.target as HTMLTextAreaElement;
      // Tab indents inside the editor; Escape then Tab leaves it (standard textarea escape hatch).
      if (t.dataset['ref'] === 'json' && e.key === 'Tab' && !e.shiftKey && !t.dataset['escaped']) {
        e.preventDefault();
        t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end');
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (t.dataset['ref'] === 'json') t.dataset['escaped'] = e.key === 'Escape' ? '1' : '';
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && this.draft) {
        e.preventDefault();
        void this.save();
      }
    });
    visitors.on(() => {
      if (this.visible) this.drawRegister();
    });
  }

  private visible = false;
  private wantItem: string | null = null;

  setAuth(a: AuthState | null) {
    this.auth = a;
    if (this.visible) void this.show(this.wantItem);
  }

  hide() {
    this.visible = false;
  }

  async show(itemId?: string | null) {
    this.visible = true;
    this.wantItem = itemId ?? null;
    this.render();
    if (this.auth?.role !== 'admin') return;
    if (!this.templates.length) this.templates = await this.visitors.api?.templates().catch(() => []) ?? [];
    await this.visitors.refresh();
    const first = (itemId && this.visitors.catalogue.find((i) => i.id === itemId)) || this.visitors.catalogue[0];
    if (this.draft && (!itemId || this.draft.savedId === itemId)) this.render();
    else if (first) this.open(first);
    else this.render();
  }

  private get api() {
    return this.visitors.api!;
  }

  private open(item: CatalogItem | null, text?: string) {
    const { disabled: _d, updatedAt: _u, updatedBy: _b, ...clean } = item ?? ({} as CatalogItem);
    this.draft = { savedId: item && text === undefined ? item.id : null, text: text ?? JSON.stringify(clean, null, 2) };
    this.status = '';
    this.confirmDelete = false;
    this.issues = [];
    this.render();
    void this.validate();
  }

  private render() {
    if (this.auth?.role !== 'admin') {
      this.el.innerHTML = `<div class="cat-denied"><h1 class="draft-h big">Catalogue</h1><p>Only admins can edit the item catalogue. ${
        this.auth?.loginAvailable && !this.auth.user ? 'Sign in with an admin account to continue.' : ''
      }</p></div>`;
      return;
    }
    this.el.innerHTML = `
      <div class="cat-register">
        <div class="cat-head">
          <h1 id="cat-h" class="draft-h big">Item catalogue</h1>
          <p class="sub">Every item visitors may airdrop. Turn items on per world in World settings.</p>
        </div>
        <div class="cat-new">
          <label for="cat-template" class="draft-label-legend">New from template</label>
          <div class="cat-new-row"><select id="cat-template" data-ref="template">${this.templates.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}</select>
          <button type="button" class="btn" data-act="new" ${this.templates.length ? '' : 'disabled'}>New item</button></div>
        </div>
        <div data-ref="register"></div>
      </div>
      <div class="cat-editor" data-ref="editor"></div>`;
    this.drawRegister();
    this.drawEditor();
  }

  private drawRegister() {
    const host = this.el.querySelector<HTMLElement>('[data-ref="register"]');
    if (!host) return;
    const cat = this.visitors.catalogue;
    const cur = this.draft?.savedId;
    host.innerHTML = cat.length
      ? `<table class="schedule register">
          <caption class="sr-only">Catalogue items</caption>
          <thead><tr><th scope="col">No.</th><th scope="col">Item</th><th scope="col">State</th></tr></thead>
          <tbody>${cat
            .map(
              (it, n) => `<tr class="${it.id === cur ? 'is-current' : ''}${it.disabled ? ' is-off' : ''}">
                <td class="c-num">${String(n + 1).padStart(2, '0')}</td>
                <td><button type="button" class="mark-btn reg-item" data-act="open" data-id="${esc(it.id)}" ${it.id === cur ? 'aria-current="true"' : ''}>${iconSvg(it.icon, 28)}<span><span class="item-name">${esc(it.name)}</span><span class="sub mono">${esc(it.id)}</span></span></button></td>
                <td>${it.disabled ? '<span class="state-chip off">Disabled</span>' : '<span class="state-chip">Enabled</span>'}</td>
              </tr>`,
            )
            .join('')}</tbody></table>`
      : `<p class="hint">${esc(this.visitors.unavailable || 'No items yet. Start one from a template.')}</p>`;
  }

  private drawEditor() {
    const host = this.el.querySelector<HTMLElement>('[data-ref="editor"]');
    if (!host) return;
    const d = this.draft;
    if (!d) {
      host.innerHTML = `<p class="hint">Choose an item from the register, or start a new one from a template.</p>`;
      return;
    }
    const saved = d.savedId ? this.visitors.catalogue.find((i) => i.id === d.savedId) : undefined;
    host.innerHTML = `
      <div class="cat-editor-head">
        <h2 class="draft-h">${saved ? `Editing <span class="mono">${esc(saved.id)}</span>` : 'New item (not saved)'}</h2>
        ${saved?.updatedAt ? `<p class="sub">Last saved ${esc(new Date(saved.updatedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }))}${saved.updatedBy ? ` by ${esc(saved.updatedBy)}` : ''}</p>` : ''}
      </div>
      <div class="cat-work">
        <div class="cat-source">
          <label for="cat-json" class="draft-label-legend">Item JSON</label>
          <div class="code-box">
            <pre class="gutter" data-ref="gutter" aria-hidden="true"></pre>
            <textarea id="cat-json" data-ref="json" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-describedby="cat-issues cat-keys" aria-invalid="false">${esc(d.text)}</textarea>
          </div>
          <p class="sub" id="cat-keys">Tab indents; press Escape then Tab to leave the editor. Ctrl+S saves.</p>
          <div id="cat-issues" data-ref="issues" aria-live="polite"></div>
          <div class="card-actions">
            <button type="button" class="btn" data-act="save">${saved ? 'Save' : 'Save new item'}</button>
            <button type="button" class="btn ghost" data-act="duplicate">Duplicate</button>
            ${saved ? `<button type="button" class="btn ghost" data-act="toggle">${saved.disabled ? 'Enable' : 'Disable'}</button>` : ''}
            ${saved ? `<button type="button" class="btn danger" data-act="delete">${this.confirmDelete ? 'Confirm delete' : 'Delete'}</button>` : ''}
          </div>
          <p class="save-state" data-ref="status" role="status">${esc(this.status)}</p>
        </div>
        <div class="cat-preview" data-ref="preview" aria-label="Preview"></div>
      </div>`;
    this.drawGutter();
    this.drawIssues();
    this.drawPreview();
  }

  private drawGutter() {
    const g = this.el.querySelector<HTMLElement>('[data-ref="gutter"]');
    if (!g || !this.draft) return;
    const n = this.draft.text.split('\n').length;
    const bad = new Set(this.issues.map((x) => x.line));
    let html = '';
    for (let i = 1; i <= n; i++) html += bad.has(i) ? `<span class="bad">${i}</span>\n` : `${i}\n`;
    g.innerHTML = html;
    const ta = this.el.querySelector<HTMLElement>('[data-ref="json"]');
    if (ta) g.scrollTop = ta.scrollTop;
  }

  private drawIssues() {
    const host = this.el.querySelector<HTMLElement>('[data-ref="issues"]');
    if (!host) return;
    const ta = this.el.querySelector<HTMLElement>('[data-ref="json"]');
    ta?.setAttribute('aria-invalid', String(this.issues.length > 0));
    host.innerHTML = this.issues.length
      ? `<p class="issues-h field-error">${this.issues.length} problem${this.issues.length === 1 ? '' : 's'}</p><ul class="issues">${this.issues
          .map((x) => `<li><button type="button" class="link-btn" data-act="goto" data-line="${x.line}">Line ${x.line}</button> <span class="mono">${esc(x.path || '(item)')}</span> ${esc(x.message)}</li>`)
          .join('')}</ul>`
      : this.valid
        ? `<p class="ok-note">Valid. The server accepts this item.</p>`
        : '';
  }

  private drawPreview() {
    const host = this.el.querySelector<HTMLElement>('[data-ref="preview"]');
    if (!host) return;
    const p = (this.valid ?? this.parsed) as Partial<CatalogItem> | null;
    const icon = typeof p?.icon === 'string' ? p.icon : '';
    const parsedIcon = icon ? parseIcon(icon) : null;
    const iconProblems = parsedIcon && !parsedIcon.ok ? parsedIcon.errors : [];
    const sizes = [96, 48, 24]
      .map((s) => `<figure class="icon-size"><div class="icon-frame" style="--s:${s}px">${iconSvg(icon, s, `${p?.name ?? 'Item'} icon at ${s} px`)}</div><figcaption class="sub">${s} px</figcaption></figure>`)
      .join('');
    let does: string[] = [];
    try {
      if (this.valid) does = describeItem(this.valid);
    } catch {
      does = [];
    }
    host.innerHTML = `
      <section aria-labelledby="pv-icon-h"><h3 id="pv-icon-h" class="draft-h">Icon</h3>
        <div class="icon-sizes">${sizes}</div>
        ${iconProblems.length ? `<ul class="issues">${iconProblems.map((x) => `<li><span class="mono">icon${x.path ? `.${esc(x.path)}` : ''}</span> ${esc(x.message)}</li>`).join('')}</ul>` : iconDoc(icon) ? '' : '<p class="hint">No icon yet.</p>'}
      </section>
      <section aria-labelledby="pv-card-h"><h3 id="pv-card-h" class="draft-h">Info card</h3>
        <div class="item-card preview-card">
          <div class="item-head">${iconSvg(icon, 48)}<div><p class="item-name">${esc(p?.name ?? 'Unnamed item')}</p><p class="item-desc">${esc(p?.description ?? '')}</p></div></div>
          ${does.length ? `<p class="draft-label-legend">What it does</p><ul class="plain-list">${does.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="hint">The plain-words summary appears once the item is valid.</p>'}
          ${p?.expiresAfter ? `<p class="sub">Expires ${esc(String(p.expiresAfter))} after it is dropped.</p>` : ''}
        </div>
      </section>`;
  }

  /** Local JSON parse first (syntax errors at their line), then the server's validator. */
  private async validate() {
    const d = this.draft;
    if (!d) return;
    const n = ++this.seq;
    const text = d.text;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      const msg = (e as Error).message;
      const pos = Number(/position (\d+)/.exec(msg)?.[1] ?? NaN);
      const lc = /line (\d+)/.exec(msg);
      const line = Number.isFinite(pos) ? text.slice(0, pos).split('\n').length : lc ? Number(lc[1]) : 1;
      this.issues = [{ path: '', message: `JSON syntax: ${msg.replace(/^JSON\.parse: /, '')}`, line }];
      this.valid = null;
      this.parsed = null;
      return this.redrawChecks();
    }
    this.parsed = raw;
    let errors: ValidationIssue[] = [];
    let valid: CatalogItem | null = null;
    try {
      const r = await this.api.validate(raw);
      if (r.ok) valid = r.item;
      else errors = r.errors;
    } catch (e) {
      errors = e instanceof VisitorError && e.errors.length ? e.errors : [{ path: '', message: `Couldn't validate: ${(e as Error).message}` }];
    }
    if (n !== this.seq) return; // a newer edit is in flight
    const map = locatePaths(text);
    this.issues = errors.map((x) => ({ ...x, line: lineOfPath(text, map, x.path) }));
    this.valid = valid;
    this.redrawChecks();
  }

  private redrawChecks() {
    this.drawGutter();
    this.drawIssues();
    this.drawPreview();
  }

  private setStatus(s: string) {
    this.status = s;
    const p = this.el.querySelector<HTMLElement>('[data-ref="status"]');
    if (p) p.textContent = s;
  }

  private async save() {
    const d = this.draft;
    if (!d) return;
    await this.validate();
    if (!this.valid) return this.setStatus('Fix the problems above before saving.');
    const item = this.valid;
    if (!d.savedId && this.visitors.catalogue.some((i) => i.id === item.id)) return this.setStatus(`An item with id “${item.id}” already exists. Choose another id.`);
    const before = d.savedId ? this.visitors.catalogue.find((i) => i.id === d.savedId) : undefined;
    this.setStatus('Saving…');
    try {
      const saved = await this.api.saveItem(item, before?.disabled);
      // Renaming the id saves a new item; the old id stays until it's deleted.
      await this.visitors.refresh();
      this.draft = { savedId: saved.id, text: d.text };
      this.status = before && before.id !== saved.id ? `Saved as ${saved.id}. The old item ${before.id} is still in the catalogue.` : 'Saved.';
      this.drawRegister();
      this.drawEditor();
    } catch (e) {
      this.setStatus(e instanceof VisitorError ? e.message : `Couldn't save: ${(e as Error).message}`);
    }
  }

  private async onClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!b) return;
    const act = b.dataset['act'];
    const d = this.draft;
    if (act === 'open') {
      const it = this.visitors.catalogue.find((i) => i.id === b.dataset['id']);
      if (it) {
        this.open(it);
        history.replaceState(null, '', withParam('item', it.id));
        this.el.querySelector<HTMLElement>('[data-ref="json"]')?.focus();
      }
    }
    if (act === 'new') {
      const t = this.templates[Number(this.el.querySelector<HTMLSelectElement>('[data-ref="template"]')!.value)];
      if (t) this.open(null, JSON.stringify({ ...t.item, id: uniqueId(`new-${t.item.id}`, this.visitors.catalogue) }, null, 2));
    }
    if (act === 'goto') {
      const ta = this.el.querySelector<HTMLTextAreaElement>('[data-ref="json"]')!;
      const line = Number(b.dataset['line']);
      const at = ta.value.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
      ta.focus();
      ta.setSelectionRange(at, at);
      ta.scrollTop = Math.max(0, (line - 4) * parseFloat(getComputedStyle(ta).lineHeight || '20'));
    }
    if (!d) return;
    if (act === 'save') await this.save();
    if (act === 'duplicate') {
      let base: Record<string, unknown> = {};
      try {
        base = JSON.parse(d.text) as Record<string, unknown>;
      } catch {
        return this.setStatus('Fix the JSON syntax before duplicating.');
      }
      const id = uniqueId(`${String(base['id'] ?? 'item')}-copy`, this.visitors.catalogue);
      this.open(null, JSON.stringify({ ...base, id, name: `${String(base['name'] ?? 'Item')} (copy)` }, null, 2));
      this.setStatus('Duplicated. Not saved yet.');
    }
    if (act === 'toggle' && d.savedId) {
      const it = this.visitors.catalogue.find((i) => i.id === d.savedId);
      if (!it) return;
      const { disabled, updatedAt: _u, updatedBy: _b, ...item } = it;
      try {
        await this.api.saveItem(item as CatalogItem, !disabled);
        await this.visitors.refresh();
        this.status = disabled ? 'Enabled. Worlds that list it in World settings can airdrop it again.' : 'Disabled. No world can airdrop it until it is enabled; items already dropped stay.';
        this.drawRegister();
        this.drawEditor();
      } catch (err) {
        this.setStatus((err as Error).message);
      }
    }
    if (act === 'delete' && d.savedId) {
      if (!this.confirmDelete) {
        this.confirmDelete = true;
        b.textContent = 'Confirm delete';
        return this.setStatus(`Press Confirm delete to remove ${d.savedId} from the catalogue.`);
      }
      try {
        await this.api.deleteItem(d.savedId);
        await this.visitors.refresh();
        const gone = d.savedId;
        this.draft = null;
        const next = this.visitors.catalogue[0];
        if (next) this.open(next);
        else this.render();
        this.setStatus(`Deleted ${gone}.`);
      } catch (err) {
        this.confirmDelete = false;
        this.setStatus((err as Error).message);
      }
    }
  }
}

function uniqueId(base: string, cat: CatalogItem[]): string {
  let id = base;
  for (let n = 2; cat.some((i) => i.id === id); n++) id = `${base}-${n}`;
  return id;
}

export function withParam(k: string, v: string | null): string {
  const p = new URLSearchParams(location.search);
  if (v === null) p.delete(k);
  else p.set(k, v);
  const q = p.toString();
  return `${location.pathname}${q ? `?${q}` : ''}`;
}

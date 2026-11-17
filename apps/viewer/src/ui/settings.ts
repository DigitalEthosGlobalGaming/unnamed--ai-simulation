/**
 * World settings: a spec table in the inspector. Rendered generically from the server's schema;
 * admins get standard inputs (number with unit, or a switch) that apply on commit and show the
 * server's confirmed value or its validation error inline. Everyone else sees the same table
 * read-only, because the energy rate and the daily cap explain how the robots behave.
 */
import { iconSvg } from '../icons/render.ts';
import { SettingsError, type AccountApi, type AuthState, type CatalogItem, type SettingField, type SettingValue, type WorldSettings } from '../types.ts';
import { esc, fmtAud, fmtPct } from './format.ts';

const REFRESH_MS = 15_000;

export class SettingsView {
  readonly el = document.createElement('div');
  private data: WorldSettings | null = null;
  private auth: AuthState | null = null;
  private builtKey = '';
  private timer: number | undefined;
  private failure = '';
  onSignOut: () => void = () => {};
  /** Catalogue items, for list settings such as which items may be airdropped (`catalogEnabled`). */
  catalogue: () => CatalogItem[] = () => [];

  constructor(private readonly account: AccountApi | undefined) {
    this.el.className = 'settings';
    this.el.addEventListener('change', (e) => void this.commit(e.target as HTMLInputElement));
    this.el.addEventListener('keydown', (e) => {
      // Enter commits a number field without leaving it.
      const t = e.target as HTMLInputElement;
      if (e.key === 'Enter' && t.type === 'number') {
        e.preventDefault();
        void this.commit(t);
      }
    });
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-acct="logout"]')) this.onSignOut();
    });
  }

  /** The catalogue changed: rebuild any item checklists. */
  catalogueChanged() {
    if (this.data) this.render();
  }

  setAuth(auth: AuthState | null) {
    this.auth = auth;
    this.builtKey = '';
    this.render();
  }

  /** Load (and keep fresh while shown) the world's settings. */
  async show() {
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.load(), REFRESH_MS);
    await this.load();
  }

  hide() {
    window.clearInterval(this.timer);
  }

  private async load() {
    if (!this.account) {
      this.failure = 'This data source has no world settings.';
      return this.render();
    }
    try {
      this.data = await this.account.settings();
      this.failure = '';
    } catch (e) {
      const err = e as SettingsError;
      this.failure = err.status === 404 ? 'This server does not serve world settings yet.' : `Couldn't load world settings: ${err.message}`;
    }
    this.render();
  }

  private get canEdit() {
    return this.auth?.role === 'admin';
  }

  private render() {
    if (!this.data) {
      this.el.innerHTML = `<p class="hint">${esc(this.failure || 'Loading world settings…')}</p>`;
      this.builtKey = '';
      return;
    }
    const fields = Object.keys(this.data.schema);
    const items = fields.some((f) => this.data!.schema[f]!.kind === 'string[]')
      ? this.catalogue().map((i) => `${i.id}:${i.name}:${i.icon.length}:${i.disabled ?? ''}`).join(',')
      : '';
    const key = `${this.canEdit}|${fields.join(',')}|${items}`;
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(fields);
    }
    this.updateValues();
  }

  private build(fields: string[]) {
    const d = this.data!;
    const edit = this.canEdit;
    const who = this.auth?.user;
    const rows = fields
      .map((f) => {
        const s = d.schema[f]!;
        const id = `set-${f}`;
        if (s.kind === 'string[]') return this.itemsRowHtml(f, s, edit);
        const control = edit ? this.controlHtml(f, s, id) : `<span class="set-ro" data-ro="${f}"></span>`;
        return `<tr data-field="${f}">
          <th scope="row">${edit ? `<label for="${id}">${esc(s.label)}</label>` : esc(s.label)}${s.help ? `<span class="sub" id="help-${f}">${esc(s.help)}</span>` : ''}</th>
          <td class="c-num set-cell">${control}<span class="set-state" data-state="${f}" aria-live="polite"></span>
            <p class="field-error" id="err-${f}" data-err="${f}" hidden></p></td>
        </tr>`;
      })
      .join('');
    const note = edit
      ? 'Changes apply when you leave a field or press Enter. Values shown are what the server confirmed.'
      : this.auth?.loginAvailable && !who
        ? 'Read only. Sign in as an admin to change these.'
        : 'Read only. Only admins can change these.';
    this.el.innerHTML = `
      <p class="settings-derived" data-ref="derived"></p>
      <p class="belief-note">${note}</p>
      <p class="field-error" data-err="_" hidden></p>
      <table class="schedule settings-schedule">
        <caption class="sr-only">World settings${edit ? '' : ' (read only)'}</caption>
        <thead><tr><th scope="col">Setting</th><th scope="col" class="c-num">Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${who ? `<p class="settings-account">Signed in as <strong>${esc(who.name)}</strong> · ${esc(this.auth!.role)} <button type="button" class="btn ghost" data-acct="logout">Sign out</button></p>` : ''}`;
  }

  /** A list setting over catalogue items: a checklist with icons (read-only: the enabled items). */
  private itemsRowHtml(f: string, s: SettingField, edit: boolean): string {
    const cat = this.catalogue();
    const help = s.help ? `<span class="sub" id="help-${f}">${esc(s.help)}</span>` : '';
    const body = !cat.length
      ? `<span class="set-ro" data-ro="${f}"></span>`
      : edit
        ? `<fieldset class="item-checks" aria-describedby="${s.help ? `help-${f} ` : ''}err-${f}"><legend class="sr-only">${esc(s.label)}</legend>
            <label class="check-row"><input type="checkbox" data-field="${f}" data-item="*"><span><strong>Every item</strong> <span class="sub">including ones added to the catalogue later</span></span></label>
            ${cat
              .map(
                (i) => `<label class="check-row"><input type="checkbox" data-field="${f}" data-item="${esc(i.id)}">${iconSvg(i.icon, 24)}<span>${esc(i.name)}${i.disabled ? ' <span class="sub">disabled in the catalogue</span>' : ''}</span></label>`,
              )
              .join('')}
          </fieldset>`
        : `<ul class="item-checks ro" data-items-ro="${f}"></ul>`;
    return `<tr data-field="${f}" class="items-head"><th scope="row" colspan="2">${esc(s.label)}${help}</th></tr>
      <tr class="items-body"><td colspan="2">${body}<span class="set-state" data-state="${f}" aria-live="polite"></span>
        <p class="field-error" id="err-${f}" data-err="${f}" hidden></p></td></tr>`;
  }

  private controlHtml(f: string, s: SettingField, id: string): string {
    const described = `${s.help ? `help-${f} ` : ''}err-${f}`;
    if (s.kind === 'boolean')
      return `<label class="switch"><input type="checkbox" role="switch" id="${id}" data-field="${f}" aria-describedby="${described}"><span class="switch-track" aria-hidden="true"></span><span class="switch-text" data-switch="${f}"></span></label>`;
    const attrs = [s.min !== undefined && `min="${s.min}"`, s.max !== undefined && `max="${s.max}"`, `step="${s.step ?? 'any'}"`].filter(Boolean).join(' ');
    // Money reads as A$2.00, so its unit goes before the field; other units follow it.
    const pre = s.unit === 'A$' ? `<span class="unit">A$</span>` : '';
    const post = s.unit && s.unit !== 'A$' ? `<span class="unit">${esc(s.unit)}</span>` : '';
    return `<span class="set-input">${pre}<input type="number" inputmode="decimal" id="${id}" data-field="${f}" ${attrs} aria-describedby="${described}">${post}</span>`;
  }

  private updateValues() {
    const d = this.data!;
    const der = d.derived;
    const parts = [
      der.batteryPerDecision !== null ? `≈ ${fmtPct(der.batteryPerDecision)} battery per decision${der.averageDecisionCostEstimated ? ' (estimated)' : ''}` : 'Battery per decision not measured yet',
      der.decisionsPerFullBattery !== null ? `~${der.decisionsPerFullBattery.toLocaleString('en-AU')} decisions per full battery` : null,
      `${fmtAud(der.spentTodayAud)} of ${fmtAud(der.dailyCapAud)} today`,
    ].filter(Boolean);
    const derived = this.el.querySelector<HTMLElement>('[data-ref="derived"]');
    if (derived) derived.textContent = parts.join(' · ');
    for (const [f, v] of Object.entries(d.values)) {
      const s = d.schema[f];
      if (!s) continue;
      if (s.kind === 'string[]') {
        const ids = Array.isArray(v) ? v : [];
        const all = ids.includes('*'); // `*` enables every catalogue item, present and future
        const ro = this.el.querySelector<HTMLElement>(`[data-ro="${f}"]`);
        if (ro) ro.textContent = all ? 'Every item' : ids.length ? ids.join(', ') : 'None';
        const list = this.el.querySelector<HTMLElement>(`[data-items-ro="${f}"]`);
        if (list) {
          const cat = this.catalogue().filter((i) => all || ids.includes(i.id));
          list.innerHTML = cat.length ? cat.map((i) => `<li class="check-row">${iconSvg(i.icon, 24)}<span>${esc(i.name)}</span></li>`).join('') : '<li class="hint">None</li>';
        }
        for (const box of this.el.querySelectorAll<HTMLInputElement>(`input[data-field="${f}"][data-item]`)) {
          const id = box.dataset['item']!;
          box.checked = id === '*' ? all : all || ids.includes(id);
          if (id !== '*') box.disabled = all;
        }
        continue;
      }
      const ro = this.el.querySelector<HTMLElement>(`[data-ro="${f}"]`);
      if (ro) ro.textContent = s.kind === 'boolean' ? (v ? 'On' : 'Off') : s.unit === 'A$' ? fmtAud(Number(v)) : `${v}${s.unit ? ` ${s.unit}` : ''}`;
      const input = this.el.querySelector<HTMLInputElement>(`input[data-field="${f}"]`);
      if (!input || document.activeElement === input || input.getAttribute('aria-invalid') === 'true') continue;
      if (s.kind === 'boolean') {
        input.checked = Boolean(v);
        const t = this.el.querySelector<HTMLElement>(`[data-switch="${f}"]`);
        if (t) t.textContent = v ? 'On' : 'Off';
      } else input.value = String(v);
    }
  }

  private setError(field: string, msg: string) {
    const target = this.el.querySelector<HTMLElement>(`[data-err="${field}"]`) ?? this.el.querySelector<HTMLElement>('[data-err="_"]');
    if (!target) return;
    target.textContent = msg;
    target.hidden = !msg;
    const input = this.el.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
    if (input) input.setAttribute('aria-invalid', String(Boolean(msg)));
  }

  private async commit(input: HTMLInputElement) {
    const f = input.dataset['field'];
    if (!f || !this.data || !this.account || !this.canEdit) return;
    const s = this.data.schema[f]!;
    let value: SettingValue;
    if (s.kind === 'string[]')
      value = input.dataset['item'] === '*' && input.checked ? ['*'] : [...this.el.querySelectorAll<HTMLInputElement>(`input[data-field="${f}"][data-item]:checked`)].map((b) => b.dataset['item']!).filter((id) => id !== '*');
    else if (s.kind === 'boolean') value = input.checked;
    else {
      value = input.valueAsNumber;
      if (!Number.isFinite(value)) return this.setError(f, `${s.label} needs a number.`);
      if (value === this.data.values[f]) return this.setError(f, '');
    }
    const state = this.el.querySelector<HTMLElement>(`[data-state="${f}"]`);
    this.setError(f, '');
    this.setError('_', '');
    input.disabled = true;
    if (state) state.textContent = 'Saving…';
    try {
      this.data = await this.account.updateSettings({ [f]: value });
      input.disabled = false;
      input.removeAttribute('aria-invalid');
      // The server's own summary of the change, else a plain confirmation.
      if (state) state.textContent = this.data.effects?.length ? `Saved · ${this.data.effects.join(' · ')}` : 'Saved';
      window.setTimeout(() => {
        if (state?.textContent?.startsWith('Saved')) state.textContent = '';
      }, 4000);
      this.updateValues();
      // the server may have adjusted the value: show what it kept
      if (s.kind === 'number') input.value = String(this.data.values[f]); // e.g. a one-shot top-up reads back 0
    } catch (e) {
      input.disabled = false;
      if (state) state.textContent = '';
      if (s.kind === 'boolean') input.checked = Boolean(this.data.values[f]); // a refused switch flips back
      if (s.kind === 'string[]') input.checked = !input.checked;
      const err = e as SettingsError;
      const msg = err.status === 401 ? 'Your session ended. Sign in again to change settings.' : err.status === 403 ? 'Only admins can change world settings.' : err.message;
      this.setError(err.field && this.data.schema[err.field] ? err.field : f, msg);
    }
  }
}

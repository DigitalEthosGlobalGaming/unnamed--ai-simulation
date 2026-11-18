/**
 * The object card (iteration 2, docs/architecture/objects.md): what the robot sees first (its
 * appearance texts), then the real state values against their ranges, product slots, verbs, and
 * who planted it. Updates live while open.
 */
import type { ViewerStore } from '../client/store.ts';
import { iconSvg } from '../icons/render.ts';
import type { ObjectView } from '../types.ts';
import { clockOf, esc } from './format.ts';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string) => (n === 1 ? one : one.endsWith('s') ? one : `${one}s`);
const hours = (h: number) => (h < 1 ? 'under an hour' : h < 36 ? `~${Math.round(h)} h` : `~${Math.round(h / 24)} days`);

export function objectCard(store: ViewerStore, objectId: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'object-card';
  let last = '';
  const draw = () => {
    const w = store.world;
    const o = w?.objects.find((x) => x.id === objectId);
    if (!w || !o) {
      if (last !== 'gone') el.innerHTML = `<p class="hint">This object is no longer in the world.</p>`;
      last = 'gone';
      return;
    }
    const key = JSON.stringify([o.state, o.appearance, o.products, o.heldBy, store.objectDefs.has(o.type)]);
    if (key === last) return;
    last = key;
    el.innerHTML = html(store, o);
  };
  const off = store.on(() => {
    if (!el.isConnected && last) return off();
    draw();
  });
  draw();
  return el;
}

function html(store: ViewerStore, o: ObjectView): string {
  const w = store.world!;
  const def = store.objectDefs.get(o.type);
  const name = def?.name ?? store.objectLabel(o.type);
  const ck = (t: number) => {
    const c = clockOf(t, w.clock);
    return `day ${c.day}, ${c.time}`;
  };
  const sees = o.appearance?.length
    ? `<ul class="sees">${o.appearance.map((t) => `<li>“${esc(cap(t))}”</li>`).join('')}</ul>`
    : `<p class="hint">${o.appearance ? 'Nothing it can describe.' : 'This server doesn’t describe objects yet.'}</p>`;
  // Real values against their ranges. Booleans (0/1) read as yes/no.
  const spec = o.stateSpec ?? Object.fromEntries(Object.entries(def?.state ?? {}).map(([k, v]) => [k, { min: v.min, max: v.max }]));
  const rows = Object.keys(spec)
    .filter((k) => typeof o.state[k] === 'number')
    .map((k) => {
      const v = o.state[k] as number;
      const { min, max } = spec[k]!;
      const f = max > min ? (v - min) / (max - min) : 0;
      const shown = max === 1 && min === 0 ? `${Math.round(v * 100)}%` : `${+v.toFixed(2)} of ${max}`;
      return `<div class="sv" role="meter" aria-label="${esc(cap(k))}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${v}" aria-valuetext="${shown}">
        <span class="sv-k">${esc(cap(k))}</span>
        <span class="sv-bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(1, f)) * 100}%"></i></span>
        <span class="sv-v">${shown}</span>
      </div>`;
    })
    .join('');
  const prods = (o.products ?? [])
    .map((p) => {
      const item = store.objectDefs.get(p.item)?.name.toLowerCase() ?? p.item;
      if (p.ready > 0) return `<li><strong>${p.ready} ${esc(plural(p.ready, item))} ready</strong> · ${esc(p.verb)}</li>`;
      if (p.nextInHours !== undefined) return `<li>Next ${esc(item)} in ${hours(p.nextInHours)}</li>`;
      const pd = def?.products?.find((x) => x.slot === p.slot);
      // Bounds in the same units as the bars above (a 0..1 value reads as a percentage).
      const fmt = (k: string, b: number) => (spec[k] && spec[k]!.min === 0 && spec[k]!.max === 1 ? `${Math.round(b * 100)}%` : String(b));
      const need = pd?.when ? Object.entries(pd.when).map(([k, ops]) => `${k} ${Object.entries(ops).map(([op, b]) => `${{ lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=' }[op] ?? op} ${fmt(k, b)}`).join(' ')}`).join(', ') : '';
      return `<li>No ${esc(plural(2, item))} yet${need ? ` <span class="sub">(needs ${esc(need)})</span>` : ''}</li>`;
    })
    .join('');
  // Product verbs only work with something ready: those without are shown muted.
  const idle = new Set((o.products ?? []).filter((p) => p.ready < 1).map((p) => p.verb));
  const verbs = [...(def?.portable ? ['pickup', 'drop'] : []), ...Object.keys(def?.verbs ?? {}), ...(o.products ?? []).map((p) => p.verb)];
  const verbList = verbs.length ? verbs : store.objectVerbs(o.type);
  const made = o.createdBy ? `<p class="made made-after">Planted by <strong>${esc(store.nameOf(o.createdBy.entityId))}</strong>, ${ck(o.createdBy.tick)}.</p>` : '';
  const held = o.heldBy ? `<p class="made">Carried by <strong>${esc(store.nameOf(o.heldBy))}</strong>.</p>` : '';
  return `
    <div class="item-head">${def?.icon ? iconSvg(def.icon, 48, `${name} icon`) : ''}<div>${def?.description ? `<p class="item-desc">${esc(def.description)}</p>` : ''}</div></div>
    <section aria-labelledby="sees-h"><h3 id="sees-h" class="draft-h">What the robot sees</h3>${sees}</section>
    ${made}${held}
    ${rows ? `<section aria-labelledby="state-h"><h3 id="state-h" class="draft-h">State <span class="h-note">real values, hidden from the robot</span></h3><div class="state-values">${rows}</div></section>` : ''}
    ${prods ? `<section aria-labelledby="prod-h"><h3 id="prod-h" class="draft-h">Products</h3><ul class="plain-list prods">${prods}</ul></section>` : ''}
    ${verbList.length ? `<section aria-labelledby="verbs-h"><h3 id="verbs-h" class="draft-h">Verbs</h3><p class="verb-chips">${verbList.map((v) => (idle.has(v) ? `<span class="verb-chip is-idle" title="Nothing ready yet">${esc(v)}<span class="sr-only"> (nothing ready yet)</span></span>` : `<span class="verb-chip">${esc(v)}</span>`)).join('')}</p></section>` : ''}`;
}

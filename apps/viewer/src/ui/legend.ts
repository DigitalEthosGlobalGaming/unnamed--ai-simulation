/** Sheet legend: every symbol used on the plan, drawn the same way. */
const sym = (body: string) =>
  `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${body}</svg>`;

const ITEMS: [string, string][] = [
  ['Robot (eye = heading)', '<rect x="7" y="7" width="14" height="14" rx="4" stroke-width="2"/><circle cx="17.5" cy="14" r="2" fill="currentColor" stroke="none"/><path d="M9 4.5h7M9 23.5h7" stroke-width="2.4" stroke-linecap="round"/>'],
  ['Solar pad', '<rect x="5" y="5" width="18" height="18" stroke-width="2"/><path d="M11 5v18M17 5v18M5 11h18M5 17h18" stroke-width="1" opacity=".8"/>'],
  ['Dock', '<path d="M5 24V5h18v19" stroke-width="2.4"/><rect x="11" y="5" width="6" height="3.5" fill="currentColor" stroke="none"/>'],
  ['Ball', '<circle cx="14" cy="14" r="6" stroke-width="2"/><path d="M8.5 10.5a8 8 0 0 1 0 7" stroke-width="1"/>'],
  ['Fountain', '<circle cx="14" cy="14" r="10" stroke-width="2"/><circle cx="14" cy="14" r="6"/><circle cx="14" cy="14" r="1.6" fill="currentColor" stroke="none"/>'],
  ['Piano', '<rect x="3" y="8" width="22" height="13" stroke-width="2"/><path d="M3 16h22M8 16v5M12 16v5M16 16v5M20 16v5" stroke-width="1"/>'],
  ['Wall', '<path d="M3 14h22" stroke-width="8"/><path d="M3 14h22" stroke="var(--sheet)" stroke-width="5"/>'],
  ['Rock', '<path d="M5 15 8.5 7.5 15.5 6.5 23 13.5 20 21.5 8 21.5Z" stroke-width="1.75"/><path d="M10 18l4-7M14 19l4-6" stroke-width=".8" opacity=".7"/>'],
  ['Water', '<rect x="4" y="4" width="20" height="20" stroke-width="1.6"/><path d="M4 10l6-6M4 16l12-12M4 22l18-18M10 24l14-14M16 24l8-8" stroke-width="1" opacity=".7"/>'],
  ['Path (shaded)', '<rect x="4" y="8" width="20" height="12" fill="currentColor" fill-opacity=".16" stroke-dasharray="3 3" stroke-width="1"/>'],
  ['Sight · hearing', '<circle cx="14" cy="14" r="10" stroke-dasharray="3.5 3"/><circle cx="14" cy="14" r="2" fill="currentColor" stroke="none"/>'],
  ['Noise + notes', '<circle cx="8" cy="14" r="2" fill="currentColor" stroke="none"/><path d="M13 8a8 8 0 0 1 0 12M18 5a12 12 0 0 1 0 18"/>'],
  ['Trail', '<path d="M3 20c5-10 10 2 22-10" stroke-dasharray="3 3.5" stroke-width="1.2"/>'],
];

export function legendHtml(): string {
  const rows = ITEMS.map(([label, body]) => `<li>${sym(body)}<span>${label}</span></li>`).join('');
  const alert = `<li class="legend-red">${sym('<path d="M14 4.5a3.5 3.5 0 0 1 6 2.5 3.5 3.5 0 0 1 3 5 3.5 3.5 0 0 1-1 6 3.5 3.5 0 0 1-5 4 3.5 3.5 0 0 1-6 0 3.5 3.5 0 0 1-5-4 3.5 3.5 0 0 1-1-6 3.5 3.5 0 0 1 3-5 3.5 3.5 0 0 1 6-2.5z" stroke-width="1.8"/>')}<span>Red pen: attention</span></li>`;
  return `<h2 class="legend-h">Legend</h2><ul class="legend-list">${rows}${alert}</ul>
    <p class="legend-hint">Drag pans · scroll, pinch or double-click zooms · keys: + − zoom, arrows pan, 0 fits</p>`;
}

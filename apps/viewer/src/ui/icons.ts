/** Authored line icons: 24-unit grid, 1.75 stroke, round joins, currentColor. */
const wrap = (body: string, label?: string) =>
  `<svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${
    label ? `role="img" aria-label="${label}"` : 'aria-hidden="true" focusable="false"'
  }>${body}</svg>`;

export const icons = {
  play: () => wrap('<path d="M8 5.5v13l10.5-6.5z"/>'),
  pause: () => wrap('<path d="M8.5 5.5v13M15.5 5.5v13"/>'),
  soundOn: () => wrap('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>'),
  soundOff: () => wrap('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  legend: () => wrap('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M7.5 8.5h2M12 8.5h4.5M7.5 12h2M12 12h4.5M7.5 15.5h2M12 15.5h4.5"/>'),
  back: () => wrap('<path d="M14.5 6l-6 6 6 6"/>'),
  chevronUp: () => wrap('<path d="M6 14.5l6-6 6 6"/>'),
  chevronDown: () => wrap('<path d="M6 9.5l6 6 6-6"/>'),
  reconnect: () => wrap('<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.5 4.5v4h-4"/>'),
  live: () => wrap('<circle cx="12" cy="12" r="3.5"/><path d="M6.6 6.6a7.6 7.6 0 0 0 0 10.8M17.4 6.6a7.6 7.6 0 0 1 0 10.8"/>'),
  revision: () => wrap('<path d="M12 4.5l8 14H4z"/><path d="M12 10v4"/><path d="M12 16.6v.01"/>'),
  sun: () => wrap('<circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6"/>'),
  moon: () => wrap('<path d="M18.5 14.5A7 7 0 0 1 9.5 5.5a7 7 0 1 0 9 9z"/>'),
  zoomIn: () => wrap('<path d="M12 5v14M5 12h14"/>'),
  zoomOut: () => wrap('<path d="M5 12h14"/>'),
  fit: () => wrap('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8.5" y="8.5" width="7" height="7"/>'),
  follow: () => wrap('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>'),
  /** Sign-in provider mark (Vercel's triangle), drawn as a plain filled triangle. */
  vercel: () => wrap('<path d="M12 4.5 20.5 19.5H3.5Z" fill="currentColor" stroke="none"/>'),
  robot: () => wrap('<rect x="5" y="6.5" width="14" height="11" rx="3.5"/><circle cx="15" cy="12" r="1.6" fill="currentColor"/>'),
};

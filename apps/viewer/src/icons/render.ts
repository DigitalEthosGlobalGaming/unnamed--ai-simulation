/**
 * Renderers for the icon language: SVG for HTML (stroke = currentColor, so it follows the theme
 * tokens of wherever it is placed) and Pixi for the plan (the scene's ink colour). Both use the
 * same outlines and hatching geometry, and strokes keep their screen-pixel weight at any size.
 */
import type { Graphics } from 'pixi.js';
import { hatchSegments, outlinesOf, parseIcon, WEIGHT_PX, type IconDoc } from './iconlang.ts';

const cache = new Map<string, IconDoc | null>();

/** Parse once per source string; null when the icon doesn't validate. */
export function iconDoc(src: string | undefined): IconDoc | null {
  if (!src) return null;
  let d = cache.get(src);
  if (d === undefined) {
    const r = parseIcon(src);
    d = r.ok ? r.icon : null;
    cache.set(src, d);
  }
  return d;
}

const f = (n: number) => Math.round(n * 100) / 100;

/** An inline SVG of the icon at `size` px. Invalid icons render as a dashed placeholder square. */
export function iconSvg(src: string | undefined, size = 24, label?: string): string {
  const doc = iconDoc(src);
  const k = 24 / size; // icon units per screen px
  const a11y = label ? `role="img" aria-label="${label.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : 'aria-hidden="true" focusable="false"';
  if (!doc) {
    return `<svg class="item-icon" viewBox="0 0 24 24" width="${size}" height="${size}" ${a11y}><rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" stroke-width="${f(1.25 * k)}" stroke-dasharray="${f(3 * k)} ${f(2.5 * k)}"/></svg>`;
  }
  const parts: string[] = [];
  for (const s of doc.shapes) {
    const w = f(WEIGHT_PX[s.weight] * k);
    const dash = s.dashed ? ` stroke-dasharray="${f(3 * k)} ${f(2.5 * k)}"` : '';
    for (const o of outlinesOf(s)) {
      if (o.closed && s.shade !== 'none') {
        const h = hatchSegments(o.pts, s.shade)
          .map(([x1, y1, x2, y2]) => `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`)
          .join('');
        if (h) parts.push(`<path d="${h}" stroke-width="${f(0.75 * k)}" opacity="0.8"/>`);
      }
      const d = o.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('') + (o.closed ? 'Z' : '');
      parts.push(`<path d="${d}" stroke-width="${w}"${dash}/>`);
    }
  }
  return `<svg class="item-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${parts.join('')}</svg>`;
}

/** Draw the icon into a Pixi Graphics, centred on (cx, cy), `size` px across. */
export function drawIcon(g: Graphics, src: string | undefined, cx: number, cy: number, size: number, color: number, alpha = 1) {
  const doc = iconDoc(src);
  const s = size / 24;
  const X = (x: number) => cx + (x - 12) * s;
  const Y = (y: number) => cy + (y - 12) * s;
  if (!doc) {
    g.rect(X(3), Y(3), 18 * s, 18 * s).stroke({ width: 1.25, color, alpha });
    return;
  }
  for (const sh of doc.shapes) {
    for (const o of outlinesOf(sh)) {
      if (o.closed && sh.shade !== 'none') {
        for (const [x1, y1, x2, y2] of hatchSegments(o.pts, sh.shade)) g.moveTo(X(x1), Y(y1)).lineTo(X(x2), Y(y2));
        g.stroke({ width: 0.75, color, alpha: 0.8 * alpha });
      }
      const pts = o.pts;
      if (sh.dashed) {
        for (let i = 1; i < pts.length + (o.closed ? 1 : 0); i++) {
          const a = pts[i - 1]!;
          const b = pts[i % pts.length]!;
          dashLine(g, X(a[0]), Y(a[1]), X(b[0]), Y(b[1]), 3, 2.5);
        }
      } else {
        g.moveTo(X(pts[0]![0]), Y(pts[0]![1]));
        for (let i = 1; i < pts.length; i++) g.lineTo(X(pts[i]![0]), Y(pts[i]![1]));
        if (o.closed) g.closePath();
      }
      g.stroke({ width: WEIGHT_PX[sh.weight], color, alpha, cap: 'round', join: 'round' });
    }
  }
}

function dashLine(g: Graphics, x1: number, y1: number, x2: number, y2: number, on: number, off: number) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.5) return;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  for (let t = 0; t < len; t += on + off) {
    const e = Math.min(len, t + on);
    g.moveTo(x1 + ux * t, y1 + uy * t).lineTo(x1 + ux * e, y1 + uy * e);
  }
}

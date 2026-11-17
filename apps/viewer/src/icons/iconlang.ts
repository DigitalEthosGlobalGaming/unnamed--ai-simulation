/**
 * The restricted icon language for catalogue items (docs/architecture/visitors.md). Parsing is
 * the shared whitelist parser in `@uas/core` (the server validates with the same code); this
 * module adds the viewer's geometry: outlines and diagonal hatching for both renderers.
 */
import { parseIcon as coreParseIcon, type IconShape, type PathCommand, type Shade, type Weight } from '@uas/core';

export type { IconShape, Shade, Weight };

export interface IconDoc {
  shapes: IconShape[];
}

export type IconResult = { ok: true; icon: IconDoc } | { ok: false; errors: { path: string; message: string }[] };

export function parseIcon(src: string): IconResult {
  const r = coreParseIcon(src);
  return r.ok ? { ok: true, icon: { shapes: r.shapes } } : r;
}

/* ------------------------------------------------------------ geometry
   Shared by the SVG and Pixi renderers: outlines as point lists in icon units, and diagonal
   hatching clipped to a closed outline. */

const STEPS = 28;

/** Polygon outlines (closed) or open polylines, in icon units. */
export function outlinesOf(s: IconShape): { pts: [number, number][]; closed: boolean }[] {
  switch (s.kind) {
    case 'line':
      return [{ pts: [[s.x1, s.y1], [s.x2, s.y2]], closed: false }];
    case 'polyline': {
      const p = s.points;
      const closed = p.length > 2 && p[0]![0] === p[p.length - 1]![0] && p[0]![1] === p[p.length - 1]![1];
      return [{ pts: p, closed }];
    }
    case 'rect': {
      const { x, y, w, h } = s;
      const r = Math.min(s.r, w / 2, h / 2);
      if (r <= 0) return [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
      const pts: [number, number][] = [];
      const corner = (cx: number, cy: number, a0: number) => {
        for (let i = 0; i <= 6; i++) {
          const a = a0 + (i / 6) * (Math.PI / 2);
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
      };
      corner(x + w - r, y + r, -Math.PI / 2);
      corner(x + w - r, y + h - r, 0);
      corner(x + r, y + h - r, Math.PI / 2);
      corner(x + r, y + r, Math.PI);
      return [{ pts, closed: true }];
    }
    case 'circle':
    case 'ellipse': {
      const rx = s.kind === 'circle' ? s.r : s.rx;
      const ry = s.kind === 'circle' ? s.r : s.ry;
      const pts: [number, number][] = [];
      for (let i = 0; i < STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2;
        pts.push([s.cx + Math.cos(a) * rx, s.cy + Math.sin(a) * ry]);
      }
      return [{ pts, closed: true }];
    }
    case 'path': {
      const out: { pts: [number, number][]; closed: boolean }[] = [];
      let cur: [number, number][] = [];
      let x = 0;
      let y = 0;
      const flush = (closed: boolean) => {
        if (cur.length > 1) out.push({ pts: cur, closed });
        cur = [];
      };
      for (const c of s.d) {
        if (c.c === 'M') {
          flush(false);
          x = c.x;
          y = c.y;
          cur.push([x, y]);
        } else if (c.c === 'L' || c.c === 'H' || c.c === 'V') {
          x = c.c === 'V' ? x : c.x;
          y = c.c === 'H' ? y : c.y;
          cur.push([x, y]);
        } else if (c.c === 'A') {
          for (const p of arcPoints(x, y, c)) cur.push(p);
          x = c.x;
          y = c.y;
        } else if (c.c === 'Z') {
          if (cur[0]) cur.push([cur[0][0], cur[0][1]]);
          flush(true);
        }
      }
      flush(false);
      return out;
    }
  }
}

/** SVG endpoint arc → points (rotation honoured), per the SVG implementation notes. */
function arcPoints(x1: number, y1: number, a: Extract<PathCommand, { c: 'A' }>): [number, number][] {
  let { rx, ry } = a;
  const { x: x2, y: y2 } = a;
  if (rx === 0 || ry === 0) return [[x2, y2]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (a.rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const large = a.largeArc === 1;
  const sweep = a.sweep === 1;
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * yp * yp + ry * ry * xp * xp)));
  const cxp = (co * rx * yp) / ry;
  const cyp = (-co * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= Math.PI * 2;
  if (sweep && dt < 0) dt += Math.PI * 2;
  const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 12)));
  const pts: [number, number][] = [];
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    pts.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  return pts;
}

/** Hatch spacing in icon units (DESIGN.md: hatching is diagonal, like the pond's). */
export const HATCH_GAP: Record<Shade, number> = { none: 0, light: 4, medium: 2.6, dense: 1.6 };

/** Diagonal (↙ 45°) hatch segments clipped to a closed polygon, in icon units. */
export function hatchSegments(poly: [number, number][], shade: Shade): [number, number, number, number][] {
  const gap = HATCH_GAP[shade];
  if (!gap || poly.length < 3) return [];
  const segs: [number, number, number, number][] = [];
  // lines x + y = k; parametrise along x
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, y] of poly) {
    lo = Math.min(lo, x + y);
    hi = Math.max(hi, x + y);
  }
  for (let k = Math.ceil(lo / gap) * gap; k <= hi; k += gap) {
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i]!;
      const [bx, by] = poly[(i + 1) % poly.length]!;
      const fa = ax + ay - k;
      const fb = bx + by - k;
      if ((fa < 0 && fb >= 0) || (fa >= 0 && fb < 0)) {
        const t = fa / (fa - fb);
        xs.push(ax + (bx - ax) * t);
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) segs.push([xs[i]!, k - xs[i]!, xs[i + 1]!, k - xs[i + 1]!]);
  }
  return segs;
}

/** Stroke widths in screen px (DESIGN.md weights: thin 1, regular ≈ object outline, heavy). */
export const WEIGHT_PX: Record<Weight, number> = { thin: 1, regular: 1.75, heavy: 2.5 };

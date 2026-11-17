/**
 * The icon language: a tiny, whitelisted drawing format for catalogue items, shared by the
 * server (validation) and the viewer (rendering). `<icon>` root, 24×24 units, children only
 * line, polyline, rect, circle, ellipse and a simple path, with `shade`, `weight` and `dashed`.
 * No colours, text, images, scripts or other attributes; anything else is rejected.
 */

export type Shade = 'none' | 'light' | 'medium' | 'dense';
export type Weight = 'thin' | 'regular' | 'heavy';
export interface ShapeStyle {
  shade: Shade;
  weight: Weight;
  dashed: boolean;
}
export type IconShape =
  | ({ kind: 'line'; x1: number; y1: number; x2: number; y2: number } & ShapeStyle)
  | ({ kind: 'polyline'; points: [number, number][] } & ShapeStyle)
  | ({ kind: 'rect'; x: number; y: number; w: number; h: number; r: number } & ShapeStyle)
  | ({ kind: 'circle'; cx: number; cy: number; r: number } & ShapeStyle)
  | ({ kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number } & ShapeStyle)
  | ({ kind: 'path'; d: PathCommand[] } & ShapeStyle);
export type PathCommand =
  | { c: 'M' | 'L'; x: number; y: number }
  | { c: 'H'; x: number }
  | { c: 'V'; y: number }
  | { c: 'A'; rx: number; ry: number; rotation: number; largeArc: 0 | 1; sweep: 0 | 1; x: number; y: number }
  | { c: 'Z' };

export const ICON_SIZE = 24;
export const ICON_MAX_SHAPES = 32;
export const ICON_MAX_LENGTH = 8000;

export interface IconError {
  path: string;
  message: string;
}
export type IconResult = { ok: true; shapes: IconShape[] } | { ok: false; errors: IconError[] };

const SHAPE_ATTRS: Record<IconShape['kind'], string[]> = {
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  rect: ['x', 'y', 'w', 'h', 'r'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  path: ['d'],
};
const OPTIONAL = new Set(['r']);
const STYLE_ATTRS = ['shade', 'weight', 'dashed'];

/** Parse and validate an icon. Pure: no DOM, no XML parser, only the whitelisted grammar. */
export function parseIcon(source: string): IconResult {
  const errors: IconError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  if (typeof source !== 'string') return { ok: false, errors: [{ path: '', message: 'icon must be a string' }] };
  if (source.length > ICON_MAX_LENGTH) return { ok: false, errors: [{ path: '', message: `icon is longer than ${ICON_MAX_LENGTH} characters` }] };
  const m = /^\s*<icon\s*>([\s\S]*)<\/icon\s*>\s*$/.exec(source);
  if (!m) return { ok: false, errors: [{ path: '', message: 'must be <icon>…</icon> with nothing outside it' }] };
  const body = m[1]!;
  const shapes: IconShape[] = [];
  const elementRe = /<([a-z]+)((?:\s+[a-zA-Z0-9]+\s*=\s*"[^"<>]*")*)\s*\/>/gy;
  let pos = 0;
  let index = 0;
  for (;;) {
    while (pos < body.length && /\s/.test(body[pos]!)) pos++;
    if (pos >= body.length) break;
    elementRe.lastIndex = pos;
    const em = elementRe.exec(body);
    if (!em) {
      err(`shapes[${index}]`, `unexpected content near "${body.slice(pos, pos + 20)}" (only self-closing <line/>, <polyline/>, <rect/>, <circle/>, <ellipse/>, <path/>)`);
      break;
    }
    pos = elementRe.lastIndex;
    const where = `shapes[${index}]`;
    const kind = em[1]! as IconShape['kind'];
    index++;
    if (!(kind in SHAPE_ATTRS)) {
      err(where, `<${kind}> is not allowed`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const am of em[2]!.matchAll(/([a-zA-Z0-9]+)\s*=\s*"([^"]*)"/g)) {
      if (attrs[am[1]!] !== undefined) err(`${where}.${am[1]}`, 'duplicate attribute');
      attrs[am[1]!] = am[2]!;
    }
    for (const a of Object.keys(attrs)) {
      if (!SHAPE_ATTRS[kind].includes(a) && !STYLE_ATTRS.includes(a)) err(`${where}.${a}`, `attribute "${a}" is not allowed on <${kind}>`);
    }
    const style = parseStyle(attrs, where, err);
    const num = (a: string, min = 0, max = ICON_SIZE): number => {
      const v = attrs[a];
      if (v === undefined) {
        if (!OPTIONAL.has(a) || kind !== 'rect') err(`${where}.${a}`, 'required');
        return 0;
      }
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n) || n < min || n > max) err(`${where}.${a}`, `must be a number from ${min} to ${max}`);
      return n;
    };
    switch (kind) {
      case 'line':
        shapes.push({ kind, x1: num('x1'), y1: num('y1'), x2: num('x2'), y2: num('y2'), ...style });
        break;
      case 'rect':
        shapes.push({ kind, x: num('x'), y: num('y'), w: num('w'), h: num('h'), r: attrs.r === undefined ? 0 : num('r', 0, 12), ...style });
        break;
      case 'circle':
        shapes.push({ kind, cx: num('cx'), cy: num('cy'), r: num('r', 0, 12), ...style });
        break;
      case 'ellipse':
        shapes.push({ kind, cx: num('cx'), cy: num('cy'), rx: num('rx', 0, 12), ry: num('ry', 0, 12), ...style });
        break;
      case 'polyline': {
        const points = parsePoints(attrs.points, `${where}.points`, err);
        shapes.push({ kind, points, ...style });
        break;
      }
      case 'path': {
        const d = parsePath(attrs.d, `${where}.d`, err);
        shapes.push({ kind, d, ...style });
        break;
      }
    }
  }
  if (index > ICON_MAX_SHAPES) err('', `at most ${ICON_MAX_SHAPES} shapes (got ${index})`);
  if (index === 0 && errors.length === 0) err('', 'an icon needs at least one shape');
  return errors.length ? { ok: false, errors } : { ok: true, shapes };
}

function parseStyle(attrs: Record<string, string>, where: string, err: (p: string, m: string) => void): ShapeStyle {
  const shade = (attrs.shade ?? 'none') as Shade;
  const weight = (attrs.weight ?? 'regular') as Weight;
  const dashed = attrs.dashed ?? 'false';
  if (!['none', 'light', 'medium', 'dense'].includes(shade)) err(`${where}.shade`, 'must be none, light, medium or dense');
  if (!['thin', 'regular', 'heavy'].includes(weight)) err(`${where}.weight`, 'must be thin, regular or heavy');
  if (dashed !== 'true' && dashed !== 'false') err(`${where}.dashed`, 'must be true or false');
  return { shade, weight, dashed: dashed === 'true' };
}

const inRange = (n: number, max = ICON_SIZE) => Number.isFinite(n) && n >= 0 && n <= max;

function parsePoints(v: string | undefined, path: string, err: (p: string, m: string) => void): [number, number][] {
  if (v === undefined) {
    err(path, 'required');
    return [];
  }
  const nums = v.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.length < 4 || nums.length % 2 !== 0 || nums.length > 64 || !nums.every((n) => inRange(n))) {
    err(path, 'must be 2 to 32 "x,y" pairs, each 0 to 24');
    return [];
  }
  const out: [number, number][] = [];
  for (let i = 0; i < nums.length; i += 2) out.push([nums[i]!, nums[i + 1]!]);
  return out;
}

function parsePath(v: string | undefined, path: string, err: (p: string, m: string) => void): PathCommand[] {
  if (v === undefined) {
    err(path, 'required');
    return [];
  }
  const tokens = v.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  if (tokens.join('').replace(/\s|,/g, '') !== v.replace(/[\s,]/g, '')) {
    err(path, 'only M, L, H, V, A and Z with numbers');
    return [];
  }
  const out: PathCommand[] = [];
  let i = 0;
  const n = (max = ICON_SIZE, min = 0): number => {
    const t = tokens[i++];
    const x = Number(t);
    if (t === undefined || !Number.isFinite(x) || x < min || x > max) throw new Error('bad number');
    return x;
  };
  try {
    while (i < tokens.length) {
      const c = tokens[i++]!;
      switch (c) {
        case 'M':
        case 'L':
          out.push({ c, x: n(), y: n() });
          break;
        case 'H':
          out.push({ c, x: n() });
          break;
        case 'V':
          out.push({ c, y: n() });
          break;
        case 'A': {
          const rx = n(24);
          const ry = n(24);
          const rotation = n(360, -360);
          const largeArc = n(1) as 0 | 1;
          const sweep = n(1) as 0 | 1;
          if ((largeArc !== 0 && largeArc !== 1) || (sweep !== 0 && sweep !== 1)) throw new Error('flag');
          out.push({ c, rx, ry, rotation, largeArc, sweep, x: n(), y: n() });
          break;
        }
        case 'Z':
        case 'z':
          out.push({ c: 'Z' });
          break;
        default:
          err(path, `command "${c}" is not allowed (only M, L, H, V, A, Z; absolute)`);
          return [];
      }
    }
  } catch {
    err(path, 'each command needs its numbers, all within 0 to 24 (arc flags 0 or 1)');
    return [];
  }
  if (out[0]?.c !== 'M') err(path, 'must start with M');
  if (out.length > 64) err(path, 'at most 64 commands');
  return out;
}

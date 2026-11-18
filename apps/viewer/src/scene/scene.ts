/**
 * The world drawn as a construction blueprint with Pixi. Only what is drawn
 * here is diegetic: fixtures, robots, callouts, construction circles, sound
 * arcs and red-pen markup. All controls live in HTML.
 */
import { Application, Container, Graphics, Text } from 'pixi.js';
import type { CharacterView, ObjectView, Vec2, WorldView } from '../types.ts';
import type { NoiseEvent, ViewerStore } from '../client/store.ts';
import { NoisePlayer } from '../ui/audio.ts';
import { C, FONT_DRAFT } from './palette.ts';
import { clockOf } from '../ui/format.ts';
import type { VisitorStore } from '../client/visitors.ts';
import { drawIcon } from '../icons/render.ts';


export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Layout {
  w: number;
  h: number;
  /** tile size in screen px at the current zoom */
  ts: number;
  /** tile size at fit (zoom 1) */
  baseTs: number;
  maxZoom: number;
  /** screen point the camera centre maps to */
  sx: number;
  sy: number;
  rot: boolean;
  W: number;
  H: number;
  compact: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Camera: zoom relative to fit, centre in tile coordinates. */
interface Cam {
  zoom: number;
  cx: number;
  cy: number;
}

const MIN_ZOOM = 0.9;
const TAP_SLOP_MOUSE = 5;
const TAP_SLOP_TOUCH = 10;
const DOUBLE_TAP_MS = 450;

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

interface Label {
  t: Text;
  used: boolean;
}

export class Scene {
  app = new Application();
  private paper = new Graphics();
  /** The sheet's outer border: never clipped. Everything else is the plan, masked to the drawing area. */
  private frameG = new Graphics();
  private planLayer = new Container();
  private maskG = new Graphics();
  private staticShown = new Set<string>();
  private maskRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private statics = new Graphics();
  private objectsG = new Graphics();
  private dyn = new Graphics();
  private labelBg = new Graphics();
  private textLayer = new Container();
  /** The selected robot's callout sits above every other scene label. */
  private overG = new Graphics();
  private overText = new Container();
  private labels = new Map<string, Label>();
  private L: Layout | null = null;
  private disp = new Map<string, Vec2>();
  private staticKey = '';
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private hoverId: string | null = null;
  private cam: Cam = { zoom: 1, cx: Number.NaN, cy: Number.NaN };
  private camTarget: Cam | null = null;
  private lastCamKey = '';
  private pendingView: Cam | null = null;
  private reserved: Rect[] = [];
  follow = false;
  onSelect: (id: string | null) => void = () => {};
  /** Visitor layer: airdropped items and the mailbox (set by main when the source has visitors). */
  visitors: VisitorStore | null = null;
  onSelectDrop: (dropId: string) => void = () => {};
  onOpenMail: () => void = () => {};
  /** Airdrop placement: the item being placed, the chosen tile, and where the pointer hovers. */
  placing: { icon: string; name: string } | null = null;
  placeAt: Vec2 | null = null;
  private placeHover: Vec2 | null = null;
  onPlace: (tile: Vec2) => void = () => {};
  /** Drop highlighted from the HTML item schedule (focus) or the open item card. */
  focusDrop: string | null = null;
  /** The object whose card is open: ringed, and the mast shows its signal range. */
  focusObject: string | null = null;
  onSelectObject: (objectId: string) => void = () => {};
  private objectPts: { id: string; x: number; y: number; r: number }[] = [];
  private hoverDrop: string | null = null;
  private dropPts: { id: string; x: number; y: number }[] = [];
  private mailboxPt: Vec2 | null = null;
  /** Fired when zoom or centre changes (for the title block scale). */
  onViewChange: () => void = () => {};
  /** Fired when follow turns off because the user panned. */
  onFollowChange: (on: boolean) => void = () => {};

  constructor(
    private host: HTMLElement,
    private store: ViewerStore,
  ) {}

  async init() {
    await this.app.init({
      background: C.sheet,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: 'webgl',
      resizeTo: this.host,
    });
    const canvas = this.app.canvas;
    canvas.setAttribute('aria-hidden', 'true');
    this.host.prepend(canvas);
    this.planLayer.addChild(this.paper, this.statics, this.objectsG, this.dyn, this.labelBg, this.textLayer, this.overG, this.overText);
    this.app.stage.addChild(this.frameG, this.planLayer, this.maskG);
    this.planLayer.mask = this.maskG;
    this.app.stage.eventMode = 'none';
    this.bindGestures(canvas);
    // Pixi's resizeTo only follows window resizes; follow the sheet element itself too.
    new ResizeObserver(() => this.app.resize()).observe(this.host);
    this.app.ticker.add(() => this.frame());
  }

  setInsets(i: Insets) {
    this.insets = i;
    this.staticKey = '';
  }

  /** Screen areas (sheet coordinates) drawn-on content should keep clear of: the camera buttons. */
  setReserved(r: Rect[]) {
    this.reserved = r;
    this.staticKey = '';
  }

  /* ----------------------------------------------------------- camera */

  get zoom(): number {
    return this.cam.zoom;
  }

  /** e.g. "250% · 1 tile = 82 px" — a real, current value. */
  scaleText(): string {
    if (!this.L) return '1 square = 1 tile';
    return `${Math.round(this.cam.zoom * 100)}% · ${Math.round(this.L.ts)} px/tile`;
  }

  /** Screen position of a robot (sheet coordinates); used by the interaction checks. */
  screenOf(id: string): Vec2 | null {
    const d = this.disp.get(id);
    return d && this.L ? this.center(d) : null;
  }

  /** Canvas position of a tile's centre (tests and screenshots tap tiles through this). */
  screenOfTile(x: number, y: number): Vec2 | null {
    return this.L ? this.center({ x, y }) : null;
  }

  viewParam(): string {
    return `${this.cam.cx.toFixed(1)},${this.cam.cy.toFixed(1)},${this.cam.zoom.toFixed(2)}`;
  }

  setView(cx: number, cy: number, zoom: number) {
    this.pendingView = { cx, cy, zoom };
  }

  fit() {
    if (!this.L) return;
    this.setFollow(false);
    this.animateTo({ zoom: 1, cx: this.L.W / 2, cy: this.L.H / 2 });
  }

  /** Zoom by a factor around a screen point (default: view centre). */
  zoomBy(f: number, at?: { x: number; y: number }, animate = true) {
    if (!this.L) return;
    const from = this.camTarget ?? this.cam;
    const z = this.clampZoom(from.zoom * f);
    let cx = from.cx;
    let cy = from.cy;
    if (at && !this.follow) {
      const wp = this.toWorld(at.x, at.y);
      const k = this.cam.zoom / z;
      cx = wp.x - (wp.x - this.cam.cx) * k;
      cy = wp.y - (wp.y - this.cam.cy) * k;
    }
    const next = { zoom: z, cx, cy };
    if (animate) this.animateTo(next);
    else {
      this.camTarget = null;
      this.cam = this.clampCam(next);
    }
  }

  /** Pan by a screen-space delta (px). User pans switch off follow. */
  panBy(dx: number, dy: number) {
    if (!this.L) return;
    this.setFollow(false);
    const ts = this.L.ts;
    const rx = dx / ts;
    const ry = dy / ts;
    const d = this.L.rot ? { x: ry, y: -rx } : { x: rx, y: ry };
    this.camTarget = null;
    this.cam = this.clampCam({ zoom: this.cam.zoom, cx: this.cam.cx - d.x, cy: this.cam.cy - d.y });
  }

  setFollow(on: boolean) {
    if (this.follow === on) return;
    this.follow = on;
    if (on && this.L && this.cam.zoom < 1.8) this.animateTo({ ...this.cam, zoom: this.clampZoom(2.2) });
    this.onFollowChange(on);
  }

  private animateTo(c: Cam) {
    const t = this.clampCam(c);
    if (this.reduced.matches) {
      this.camTarget = null;
      this.cam = t;
    } else this.camTarget = t;
  }

  private clampZoom(z: number): number {
    return Math.max(MIN_ZOOM, Math.min(this.L?.maxZoom ?? 6, z));
  }

  /** Below fit the sheet stays centred; zoomed in, the centre may roam to the sheet edge, never beyond. */
  private clampCam(c: Cam): Cam {
    const L = this.L;
    if (!L) return c;
    const zoom = this.clampZoom(c.zoom);
    const roam = Math.max(0, Math.min(1, (zoom - 1) / 0.6));
    const hx = (L.W / 2) * roam;
    const hy = (L.H / 2) * roam;
    return {
      zoom,
      cx: Math.max(L.W / 2 - hx, Math.min(L.W / 2 + hx, c.cx)),
      cy: Math.max(L.H / 2 - hy, Math.min(L.H / 2 + hy, c.cy)),
    };
  }

  private stepCamera(dt: number) {
    const L = this.L!;
    if (Number.isNaN(this.cam.cx)) this.cam = { zoom: 1, cx: L.W / 2, cy: L.H / 2 };
    if (this.pendingView) {
      this.cam = this.clampCam(this.pendingView);
      this.pendingView = null;
    }
    const reduced = this.reduced.matches;
    if (this.follow) {
      const sel = this.store.character(this.store.selectedId);
      const d = sel ? this.disp.get(sel.id) : undefined;
      if (!sel || !d) this.setFollow(false);
      else {
        const k = reduced ? 1 : 1 - Math.exp(-dt * 6);
        const tx = d.x + 0.5;
        const ty = d.y + 0.5;
        if (this.camTarget) {
          this.camTarget.cx = tx;
          this.camTarget.cy = ty;
        } else {
          this.cam.cx += (tx - this.cam.cx) * k;
          this.cam.cy += (ty - this.cam.cy) * k;
        }
      }
    }
    if (this.camTarget) {
      const t = this.camTarget;
      const k = reduced ? 1 : 1 - Math.exp(-dt * 14);
      const lz = Math.log(this.cam.zoom) + (Math.log(t.zoom) - Math.log(this.cam.zoom)) * k;
      this.cam = { zoom: Math.exp(lz), cx: this.cam.cx + (t.cx - this.cam.cx) * k, cy: this.cam.cy + (t.cy - this.cam.cy) * k };
      if (Math.abs(this.cam.zoom - t.zoom) < 0.002 && Math.hypot(this.cam.cx - t.cx, this.cam.cy - t.cy) < 0.01) {
        this.cam = { ...t };
        this.camTarget = null;
      }
    }
    this.cam = this.clampCam(this.cam);
    const key = `${this.cam.zoom.toFixed(3)}:${this.cam.cx.toFixed(3)}:${this.cam.cy.toFixed(3)}:${L.baseTs}`;
    if (key !== this.lastCamKey) {
      this.lastCamKey = key;
      this.onViewChange();
    }
  }

  private toWorld(sx: number, sy: number): Vec2 {
    const L = this.L!;
    const rx = (sx - L.sx) / L.ts;
    const ry = (sy - L.sy) / L.ts;
    const d = L.rot ? { x: ry, y: -rx } : { x: rx, y: ry };
    return { x: this.cam.cx + d.x, y: this.cam.cy + d.y };
  }

  /* --------------------------------------------------------- gestures */

  private bindGestures(canvas: HTMLCanvasElement) {
    const pts = new Map<number, { x: number; y: number }>();
    let press: { id: number; x: number; y: number; moved: boolean; touch: boolean; t: number } | null = null;
    let pinch: { dist: number; mid: { x: number; y: number } } | null = null;
    let lastTap: { t: number; x: number; y: number } | null = null;
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pinchInfo = () => {
      const [a, b] = [...pts.values()];
      return { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } };
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      canvas.setPointerCapture(e.pointerId);
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1) press = { id: e.pointerId, ...p, moved: false, touch: e.pointerType !== 'mouse', t: e.timeStamp };
      else if (pts.size === 2) {
        pinch = pinchInfo();
        if (press) press.moved = true; // a pinch is never a tap
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (!pts.has(e.pointerId)) {
        // hover
        if (this.placing) {
          this.placeHover = this.tileAt(p.x, p.y);
          canvas.style.cursor = 'crosshair';
          return;
        }
        const id = this.hit(p.x, p.y);
        const drop = id ? null : this.hitDrop(p.x, p.y);
        if (id !== this.hoverId || drop !== this.hoverDrop) {
          this.hoverId = id;
          this.hoverDrop = drop;
          canvas.style.cursor = id || drop || (!id && (this.hitMailbox(p.x, p.y) || this.hitObject(p.x, p.y))) ? 'pointer' : 'grab';
        }
        return;
      }
      const prev = pts.get(e.pointerId)!;
      pts.set(e.pointerId, p);
      if (pts.size >= 2 && pinch) {
        const now = pinchInfo();
        this.zoomBy(now.dist / Math.max(1, pinch.dist), now.mid, false);
        this.panBy(now.mid.x - pinch.mid.x, now.mid.y - pinch.mid.y);
        pinch = now;
        return;
      }
      if (press && press.id === e.pointerId) {
        if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) > (press.touch ? TAP_SLOP_TOUCH : TAP_SLOP_MOUSE)) {
          press.moved = true;
          canvas.style.cursor = 'grabbing';
          this.panBy(p.x - press.x, p.y - press.y);
        } else if (press.moved) this.panBy(p.x - prev.x, p.y - prev.y);
      }
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e);
      const wasTap = !cancelled && press && press.id === e.pointerId && !press.moved && pts.size === 1;
      const downT = press?.t ?? e.timeStamp;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 1) {
        // lifting one finger of a pinch: carry on panning with the other, never tap
        const [id, q] = [...pts.entries()][0]!;
        press = { id, ...q, moved: true, touch: true, t: e.timeStamp };
      } else if (pts.size === 0) press = null;
      canvas.style.cursor = this.hoverId ? 'pointer' : 'grab';
      if (!wasTap) return;
      // Second press must start soon after the first release (input timestamps, so a busy frame can't split it).
      const now = e.timeStamp;
      if (lastTap && downT - lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24) {
        lastTap = null;
        this.zoomBy(1.8, p, true);
        return;
      }
      lastTap = { t: now, ...p };
      const spot = this.hotspots.find((h) => p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h);
      if (spot) {
        this.onRevision(spot.key, spot.id);
        return;
      }
      if (this.placing) {
        const t = this.tileAt(p.x, p.y);
        if (t) {
          this.placeAt = t;
          this.onPlace(t);
        }
        return;
      }
      const robot = this.hit(p.x, p.y);
      if (!robot) {
        const drop = this.hitDrop(p.x, p.y);
        if (drop) return this.onSelectDrop(drop);
        if (this.hitMailbox(p.x, p.y)) return this.onOpenMail();
        const obj = this.hitObject(p.x, p.y);
        if (obj) return this.onSelectObject(obj);
      }
      this.onSelect(robot);
    };
    canvas.addEventListener('pointerup', (e) => end(e, false));
    canvas.addEventListener('pointercancel', (e) => end(e, true));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
        const f = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0018));
        this.zoomBy(f, local(e), false);
      },
      { passive: false },
    );
    canvas.style.cursor = 'grab';
  }

  /* ----------------------------------------------------------- layout */

  private layout(world: WorldView): Layout {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const compact = w < 720;
    const { width: MW, height: MH } = world.map;
    const availW = w - this.insets.left - this.insets.right;
    const availH = h - this.insets.top - this.insets.bottom;
    const rot = availH > availW * 1.15;
    const cols = rot ? MH : MW;
    const rows = rot ? MW : MH;
    const pad = compact ? 22 : 34;
    // Top margin holds the grid refs (and overall dimensions on desktop); bottom holds the drawing title and scale bar.
    const padTop = compact ? 24 : 44;
    const padBottom = compact ? 44 : 56;
    const baseTs = Math.max(8, Math.floor(Math.min((availW - pad * 2) / cols, (availH - padTop - padBottom) / rows)));
    // Max zoom: about five tiles across a phone, about nine across a desktop sheet.
    const maxTs = availW / (compact ? 5 : 9);
    const maxZoom = Math.max(1.5, maxTs / baseTs);
    const zoom = Math.max(MIN_ZOOM, Math.min(maxZoom, this.cam.zoom));
    const ts = zoom === 1 ? baseTs : baseTs * zoom;
    const sx = Math.round(this.insets.left + availW / 2);
    const sy = Math.round(this.insets.top + padTop + (availH - padTop - padBottom) / 2);
    return { w, h, ts, baseTs, maxZoom, sx, sy, rot, W: MW, H: MH, compact };
  }

  /** Tile-space point (tile i spans [i, i+1]) to screen, through the camera. */
  private P(x: number, y: number): Vec2 {
    const L = this.L!;
    const dx = x - this.cam.cx;
    const dy = y - this.cam.cy;
    return L.rot ? { x: L.sx - dy * L.ts, y: L.sy + dx * L.ts } : { x: L.sx + dx * L.ts, y: L.sy + dy * L.ts };
  }

  private ang(a: number): number {
    return this.L!.rot ? a + Math.PI / 2 : a;
  }

  private center(p: Vec2): Vec2 {
    return this.P(p.x + 0.5, p.y + 0.5);
  }

  private hit(sx: number, sy: number): string | null {
    const w = this.store.world;
    if (!w || !this.L) return null;
    let best: string | null = null;
    let bestD = Math.max(16, Math.min(this.L.ts * 0.85, 60));
    for (const c of w.characters) {
      const p = this.center(this.disp.get(c.id) ?? c.pos);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    return best;
  }

  /* ----------------------------------------------------------- labels */

  private label(key: string, text: string, x: number, y: number, o: { size?: number; color?: number; anchorX?: number; anchorY?: number; bg?: boolean; weight?: '500' | '600' | '700'; alpha?: number; spacing?: number; top?: boolean } = {}) {
    let l = this.labels.get(key);
    const size = o.size ?? 13;
    const weight = o.weight ?? '600';
    const color = o.color ?? C.ink;
    if (!l) {
      const t = new Text({ text, style: { fontFamily: FONT_DRAFT, fontSize: size, fontWeight: weight, fill: color, letterSpacing: o.spacing ?? 0.6 } });
      l = { t, used: true };
      this.labels.set(key, l);
      (o.top ? this.overText : this.textLayer).addChild(t);
    }
    const t = l.t;
    if (t.text !== text) t.text = text;
    if (t.style.fontSize !== size) t.style.fontSize = size;
    if (t.style.fill !== color) t.style.fill = color;
    if (t.style.fontWeight !== weight) t.style.fontWeight = weight;
    t.anchor.set(o.anchorX ?? 0.5, o.anchorY ?? 0.5);
    t.position.set(Math.round(x), Math.round(y));
    t.alpha = o.alpha ?? 1;
    t.visible = true;
    l.used = true;
    if (o.bg !== false) {
      // Knockout exactly under the label: the text's top-left is position minus anchor × size.
      const left = Math.round(x) - t.anchor.x * t.width;
      const top = Math.round(y) - t.anchor.y * t.height;
      this.labelBg.rect(Math.round(left - 3), Math.round(top), Math.round(t.width + 6), Math.round(t.height)).fill({ color: C.sheet, alpha: 0.9 * (o.alpha ?? 1) });
    }
    return t;
  }

  /* ----------------------------------------------------------- static */

  private drawStatic(world: WorldView) {
    const L = this.L!;
    const g = this.statics;
    const p = this.paper;
    g.clear();
    p.clear();
    const { W, H, ts } = L;
    const c0 = this.P(0, 0);
    const c1 = this.P(W, H);
    const x0 = Math.min(c0.x, c1.x);
    const y0 = Math.min(c0.y, c1.y);
    const mapW = (L.rot ? H : W) * ts;
    const mapH = (L.rot ? W : H) * ts;

    // Sheet frame: outer border and inner drawing frame.
    const inset = L.compact ? 6 : 10;
    this.frameG.clear();
    this.frameG.rect(inset, inset, L.w - inset * 2, L.h - inset * 2).stroke({ width: 1, color: C.ink2, alpha: 0.35 });
    // Clip the plan to the drawing area: inside the frame, above the legend / title-block band (or drawer).
    const top = Math.max(inset + 1, this.insets.top);
    const bottom = Math.min(L.h - inset - 1, L.h - this.insets.bottom);
    this.maskG.clear();
    this.maskRect = { x: inset + 1, y: top, w: L.w - inset * 2 - 2, h: Math.max(0, bottom - top) };
    this.maskG.rect(this.maskRect.x, this.maskRect.y, this.maskRect.w, this.maskRect.h).fill({ color: 0xffffff });

    // Tile grid with heavier lines every five tiles.
    const cols = L.rot ? H : W;
    const rows = L.rot ? W : H;
    for (let i = 0; i <= cols; i++) {
      const heavy = (L.rot ? H - i : i) % 5 === 0;
      p.moveTo(x0 + i * ts, y0).lineTo(x0 + i * ts, y0 + mapH);
      p.stroke({ width: 1, color: C.grid, alpha: heavy ? 0.3 : 0.11 });
    }
    for (let j = 0; j <= rows; j++) {
      const heavy = j % 5 === 0;
      p.moveTo(x0, y0 + j * ts).lineTo(x0 + mapW, y0 + j * ts);
      p.stroke({ width: 1, color: C.grid, alpha: heavy ? 0.3 : 0.11 });
    }
    p.rect(x0, y0, mapW, mapH).stroke({ width: 1.5, color: C.ink2, alpha: 0.7 });

    // Paths, water, walls.
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 'out' : world.map.tiles[y * W + x]);
    const tileRect = (x: number, y: number) => {
      const a = this.P(x, y);
      const b = this.P(x + 1, y + 1);
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), s: ts };
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (at(x, y) !== 'path') continue;
        const r = tileRect(x, y);
        g.rect(r.x, r.y, ts, ts).fill({ color: C.ink, alpha: 0.08 });
      }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const k = at(x, y);
        if (k === 'water') {
          const r = tileRect(x, y);
          for (let d = 0.25; d < 2; d += 0.25) {
            const dd = d * ts;
            if (dd <= ts) g.moveTo(r.x + dd, r.y).lineTo(r.x, r.y + dd);
            else g.moveTo(r.x + ts, r.y + dd - ts).lineTo(r.x + dd - ts, r.y + ts);
          }
        }
      }
    g.stroke({ width: 1, color: C.ink2, alpha: 0.42 });
    // Rocks: a boulder symbol (outline with hatching), one per tile.
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (at(x, y) !== 'rock') continue;
        const c = this.center({ x, y });
        const r = ts * 0.34;
        g.poly([c.x - r, c.y + r * 0.2, c.x - r * 0.5, c.y - r * 0.8, c.x + r * 0.4, c.y - r * 0.9, c.x + r, c.y - r * 0.1, c.x + r * 0.6, c.y + r * 0.8, c.x - r * 0.6, c.y + r * 0.8])
          .fill({ color: C.sheet })
          .stroke({ width: 1.75, color: C.ink, join: 'round' });
        g.moveTo(c.x - r * 0.4, c.y + r * 0.5).lineTo(c.x + r * 0.2, c.y - r * 0.5).moveTo(c.x, c.y + r * 0.6).lineTo(c.x + r * 0.55, c.y - r * 0.2);
        g.stroke({ width: 0.75, color: C.ink2, alpha: 0.7 });
      }
    // Edges of paths (dashed) and water (solid).
    const edges = (kind: string, dashed: boolean) => {
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          if (at(x, y) !== kind) continue;
          const sides: [number, number, number, number, number, number][] = [
            [0, -1, x, y, x + 1, y],
            [0, 1, x, y + 1, x + 1, y + 1],
            [-1, 0, x, y, x, y + 1],
            [1, 0, x + 1, y, x + 1, y + 1],
          ];
          for (const [dx, dy, ax, ay, bx, by] of sides) {
            const n = at(x + dx, y + dy);
            if (n === kind || n === 'out' || n === 'wall') continue;
            const a = this.P(ax, ay);
            const b = this.P(bx, by);
            if (dashed) dash(g, a.x, a.y, b.x, b.y, 4, 4);
            else g.moveTo(a.x, a.y).lineTo(b.x, b.y);
          }
        }
    };
    edges('path', true);
    g.stroke({ width: 1, color: C.ink2, alpha: 0.55 });
    edges('water', false);
    g.stroke({ width: 1.75, color: C.ink, alpha: 0.85 });

    // Walls: double line (outer ink, inner paper), square caps.
    const wallSegs: [Vec2, Vec2][] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (at(x, y) !== 'wall') continue;
        const c = this.center({ x, y });
        let linked = false;
        if (at(x + 1, y) === 'wall') {
          wallSegs.push([c, this.center({ x: x + 1, y })]);
          linked = true;
        }
        if (at(x, y + 1) === 'wall') {
          wallSegs.push([c, this.center({ x, y: y + 1 })]);
          linked = true;
        }
        if (!linked && at(x - 1, y) !== 'wall' && at(x, y - 1) !== 'wall') wallSegs.push([c, { x: c.x + 0.01, y: c.y }]);
      }
    const ww = Math.max(6, Math.min(16, ts * 0.34));
    for (const [a, b] of wallSegs) g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    g.stroke({ width: ww, color: C.ink, cap: 'square', join: 'miter' });
    for (const [a, b] of wallSegs) g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    g.stroke({ width: ww - 4, color: C.sheet, cap: 'square', join: 'miter' });
    // Poché hatch inside walls.
    for (const [a, b] of wallSegs) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / (len || 1);
      const uy = (b.y - a.y) / (len || 1);
      const half = (ww - 4) / 2;
      for (let s = -half; s <= len + half; s += 5) {
        const px = a.x + ux * s;
        const py = a.y + uy * s;
        g.moveTo(px - uy * half, py + ux * half).lineTo(px + uy * half + ux * 2, py - ux * half + uy * 2);
      }
    }
    g.stroke({ width: 0.75, color: C.ink2, alpha: 0.45 });

    this.staticBoxes = [];
    // Grid references: on the border at fit; pinned to the visible edges when panned in.
    const step = ts < 18 ? 2 : 1;
    const vis = { l: this.insets.left + 4, t: this.insets.top + 4, r: L.w - 4, b: L.h - this.insets.bottom - 4 };
    const refSize = ts > 40 ? 13 : 12;
    const topY = Math.max(y0 - 9, vis.t + 10);
    const leftX = Math.max(x0 - 9, vis.l + 10);
    const pinnedTop = topY !== y0 - 9;
    const pinnedLeft = leftX !== x0 - 9;
    const clearOf = (x: number, y: number) => !this.reserved.some((r) => overlap(r, { x: x - 10, y: y - 8, w: 20, h: 16 }));
    for (let i = 0; i < cols; i += step) {
      const x = x0 + (i + 0.5) * ts;
      if (x < vis.l + 22 || x > vis.r - 6 || !clearOf(x, topY)) continue;
      const txt = L.rot ? String(H - i) : colName(i);
      this.label(`ref-c${i}`, txt, x, topY, { size: refSize, color: pinnedTop ? C.ink2 : C.ink3, weight: pinnedTop ? '600' : '500' });
      this.staticBoxes.push({ x, y: topY, w: txt.length * 8 + 6, h: 16 });
    }
    for (let j = 0; j < rows; j += step) {
      const y = y0 + (j + 0.5) * ts;
      if (y < vis.t + 22 || y > vis.b - 6 || !clearOf(leftX, y)) continue;
      const txt = L.rot ? colName(j) : String(j + 1);
      this.label(`ref-r${j}`, txt, leftX, y, { size: refSize, color: pinnedLeft ? C.ink2 : C.ink3, weight: pinnedLeft ? '600' : '500' });
      this.staticBoxes.push({ x: leftX, y, w: txt.length * 8 + 6, h: 16 });
    }
    // Area names.
    // Area names placed from the map itself: the walled building and the open water.
    const bbox = (kind: string) => {
      let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
      world.map.tiles.forEach((k, i) => {
        if (k !== kind) return;
        const x = i % W;
        const y = Math.floor(i / W);
        bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x + 1); by1 = Math.max(by1, y + 1);
      });
      return bx1 < 0 ? null : { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    };
    const hutBox = bbox('wall');
    if (hutBox && hutBox.x1 - hutBox.x0 >= 3 && hutBox.y1 - hutBox.y0 >= 3) {
      // An interior spot clear of fixtures, preferring the top middle of the building.
      const spots: Vec2[] = [];
      for (let yy = hutBox.y0 + 1; yy < hutBox.y1 - 1; yy++)
        for (let xx = hutBox.x0 + 1; xx < hutBox.x1 - 1; xx++) spots.push({ x: xx + 0.5, y: yy + 0.5 });
      const mid = (hutBox.x0 + hutBox.x1) / 2;
      spots.sort((a, b) => a.y - b.y || Math.abs(a.x - mid) - Math.abs(b.x - mid));
      const free = spots.find((p) => !world.objects.some((o) => Math.abs(o.pos.x + 0.5 - p.x) < 1.6 && Math.abs(o.pos.y + 0.5 - p.y) < 1.2));
      const at = free ?? { x: mid, y: hutBox.y0 + 1.5 };
      const hut = this.P(at.x, at.y);
      this.label('area-hut', 'HUT', hut.x, hut.y, { size: 13, color: C.ink3, bg: false, spacing: 3 });
      this.staticBoxes.push({ x: hut.x, y: hut.y, w: 44, h: 16 });
    }
    const pondBox = this.largestRegion(world, 'water');
    if (pondBox) {
      // The water tile nearest the middle of the water's extent (ponds are rarely rectangles).
      const mx = (pondBox.x0 + pondBox.x1) / 2;
      const my = (pondBox.y0 + pondBox.y1) / 2;
      let best = { x: mx, y: my, d: Infinity };
      world.map.tiles.forEach((k, i) => {
        if (k !== 'water') return;
        const x = (i % W) + 0.5;
        const y = Math.floor(i / W) + 0.5;
        const d = Math.hypot(x - mx, y - my);
        if (d < best.d) best = { x, y, d };
      });
      const pond = this.P(best.x, best.y);
      this.label('area-pond', 'POND', pond.x, pond.y, { size: 13, color: C.ink, spacing: 3 });
      this.staticBoxes.push({ x: pond.x, y: pond.y, w: 56, h: 16 });
    }
    this.mapRect = { x: x0, y: y0, w: mapW, h: mapH };
    this.drawDimensions(world, vis);
    this.drawTitleAndScale(vis);
    this.drawNorth();
  }

  /** Bounding box of the largest 4-connected region of a tile kind (a map can hold several ponds). */
  private largestRegion(world: WorldView, kind: string): { x0: number; y0: number; x1: number; y1: number } | null {
    const { width: W, height: H, tiles } = world.map;
    const seen = new Uint8Array(W * H);
    let best: { n: number; x0: number; y0: number; x1: number; y1: number } | null = null;
    for (let i = 0; i < tiles.length; i++) {
      if (seen[i] || tiles[i] !== kind) continue;
      const stack = [i];
      seen[i] = 1;
      const r = { n: 0, x0: W, y0: H, x1: -1, y1: -1 };
      while (stack.length) {
        const k = stack.pop()!;
        const x = k % W;
        const y = Math.floor(k / W);
        r.n++;
        r.x0 = Math.min(r.x0, x); r.y0 = Math.min(r.y0, y); r.x1 = Math.max(r.x1, x + 1); r.y1 = Math.max(r.y1, y + 1);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          const j = ny * W + nx;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[j] || tiles[j] !== kind) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
      if (!best || r.n > best.n) best = r;
    }
    return best;
  }

  /* ------------------------------------------------- drafting devices */

  /** A dimension string between screen points a and b, offset along unit normal n. */
  private dimension(key: string, a: Vec2, b: Vec2, n: Vec2, off0: number, text: string, avoid: Rect[] = []) {
    const g = this.statics;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 24) return;
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    // Push the dimension line out past any label it would cross; skip it if that fails.
    const crosses = (k: number) => {
      for (let i = 0; i <= 20; i++) {
        const px = a.x + (b.x - a.x) * (i / 20) + n.x * k;
        const py = a.y + (b.y - a.y) * (i / 20) + n.y * k;
        if (avoid.some((r) => px > r.x - 4 && px < r.x + r.w + 4 && py > r.y - 4 && py < r.y + r.h + 4)) return true;
      }
      return false;
    };
    const off = [off0, off0 * 1.8, off0 * 2.6].find((k) => !crosses(k));
    if (off === undefined) return;
    const at = (p: Vec2, k: number) => ({ x: p.x + n.x * k, y: p.y + n.y * k });
    // extension lines (small gap at the object, overshoot past the dimension line)
    for (const p of [a, b]) {
      const s0 = at(p, 3);
      const s1 = at(p, off + 4);
      g.moveTo(s0.x, s0.y).lineTo(s1.x, s1.y);
    }
    const a2 = at(a, off);
    const b2 = at(b, off);
    g.moveTo(a2.x, a2.y).lineTo(b2.x, b2.y);
    // 45° architectural ticks
    const t = { x: (d.x + n.x) * 4, y: (d.y + n.y) * 4 };
    for (const p of [a2, b2]) g.moveTo(p.x - t.x, p.y - t.y).lineTo(p.x + t.x, p.y + t.y);
    g.stroke({ width: 1, color: C.ink2, alpha: 0.9 });
    const m = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
    this.label(key, text, m.x, m.y, { size: 12, color: C.ink2, weight: '600' });
  }

  private drawDimensions(world: WorldView, vis: { l: number; t: number; r: number; b: number }) {
    const L = this.L!;
    const { W, H, ts } = L;
    const unit = (x: number, y: number, dx: number, dy: number) => {
      const p = this.P(x, y);
      const q = this.P(x + dx, y + dy);
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      return { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
    };
    // Fixture symbols and their labels: dimension strings must not run through them.
    const avoid: Rect[] = [];
    for (const o of world.objects) {
      const c = this.center(o.pos);
      avoid.push({ x: c.x - ts / 2, y: c.y - ts / 2, w: ts, h: ts });
      const sp = this.fixtureLabelSpot(o, c, false);
      if (sp) avoid.push({ x: sp.x - sp.nameW / 2, y: Math.min(sp.nameY, sp.verbY ?? sp.nameY) - 8, w: Math.max(sp.nameW, sp.vtxt.length * 6), h: Math.abs((sp.verbY ?? sp.nameY) - sp.nameY) + 16 });
    }
    const feature = (key: string, x0: number, y0: number, x1: number, y1: number) => {
      const off = Math.max(14, Math.min(28, ts * 0.45));
      // width along the south side, depth along the east side (world directions; the plan may be rotated)
      this.dimension(`dim-${key}-w`, this.P(x0, y1), this.P(x1, y1), unit(x0, y1, 0, 1), off, String(x1 - x0), avoid);
      this.dimension(`dim-${key}-h`, this.P(x1, y0), this.P(x1, y1), unit(x1, y0, 1, 0), off, String(y1 - y0), avoid);
    };
    // Feature dimensions only once tiles are big enough for the strings to read.
    if (ts >= 28) {
      const box = (kind: string) => {
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        world.map.tiles.forEach((k, i) => {
          if (k !== kind) return;
          const x = i % W;
          const y = Math.floor(i / W);
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
        });
        return x1 < 0 ? null : { x0, y0, x1, y1 };
      };
      const hut = box('wall');
      if (hut) feature('hut', hut.x0, hut.y0, hut.x1, hut.y1);
      const pond = this.largestRegion(world, 'water');
      if (pond) feature('pond', pond.x0, pond.y0, pond.x1, pond.y1);
    }
    // Overall extents above and left of the grid refs, while those plan edges are on screen.
    const mr = this.mapRect;
    if (!L.compact && mr.y - 30 > vis.t + 6 && mr.x - 34 > vis.l) {
      const clear = this.reserved.map((r) => ({ ...r }));
      this.dimension('dim-all-w', { x: mr.x, y: mr.y }, { x: mr.x + mr.w, y: mr.y }, { x: 0, y: -1 }, 26, `${L.rot ? H : W} tiles`, clear);
      this.dimension('dim-all-h', { x: mr.x, y: mr.y }, { x: mr.x, y: mr.y + mr.h }, { x: -1, y: 0 }, 30, `${L.rot ? W : H}`, clear);
    }
  }

  private drawTitleAndScale(vis: { l: number; t: number; r: number; b: number }) {
    const L = this.L!;
    const g = this.statics;
    const mr = this.mapRect;
    const ts = L.ts;
    // Drawing title under the plan (moves with the plan).
    const ty = mr.y + mr.h + (L.compact ? 16 : 20);
    if (ty + 18 < vis.b && ty > vis.t && mr.x + 200 > vis.l) {
      const cx = mr.x + 10;
      // Detail bubble: drawing 1 on sheet A, lettered at the 12px floor.
      g.circle(cx + 2, ty, 13).stroke({ width: 1.5, color: C.ink });
      g.moveTo(cx - 11, ty).lineTo(cx + 15, ty).stroke({ width: 1, color: C.ink });
      this.label('dt-num', '1', cx + 2, ty - 6, { size: 12, weight: '700', bg: false });
      this.label('dt-a', 'A', cx + 2, ty + 6, { size: 12, weight: '700', bg: false });
      const t = this.label('dt-title', 'GROUND PLAN', cx + 22, ty - 6, { size: 15, weight: '700', anchorX: 0, bg: false, spacing: 1.2 });
      g.moveTo(cx + 22, ty + 3).lineTo(cx + 22 + t.width, ty + 3).stroke({ width: 1.5, color: C.ink });
      g.moveTo(cx + 22, ty + 6).lineTo(cx + 22 + t.width, ty + 6).stroke({ width: 0.75, color: C.ink });
      if (!L.compact) this.label('dt-sub', `${(this.store.world?.name ?? '').toUpperCase()} · DIMENSIONS IN TILES`, cx + 22, ty + 15, { size: 12, color: C.ink3, weight: '600', anchorX: 0, bg: false });
    }
    // Graphic scale bar: segments of one tile, re-measured at every zoom; pinned to the visible plan.
    const segs = Math.max(1, Math.min(5, Math.floor(170 / ts)));
    const barW = segs * ts;
    const right = Math.min(mr.x + mr.w, L.w - this.insets.right - 44);
    const x0 = right - barW;
    const y = Math.min(mr.y + mr.h + (L.compact ? 22 : 26), vis.b - 10);
    if (x0 < vis.l + 10 || y < vis.t + 30) return;
    if (y < mr.y + mr.h) g.rect(x0 - 8, y - 22, barW + 16 + 40, 30).fill({ color: C.sheet, alpha: 0.9 });
    this.staticBoxes.push({ x: x0 + barW / 2 + 20, y: y - 8, w: barW + 56, h: 30 });
    for (let i = 0; i < segs; i++) {
      const r = g.rect(x0 + i * ts, y - 4, ts, 5);
      if (i % 2 === 0) r.fill({ color: C.ink });
      r.stroke({ width: 1, color: C.ink });
      this.label(`sb-${i}`, String(i), x0 + i * ts, y - 13, { size: 12, color: C.ink2, bg: false });
    }
    this.label(`sb-${segs}`, String(segs), x0 + barW, y - 13, { size: 12, color: C.ink2, bg: false });
    this.label('sb-unit', segs === 1 ? 'TILE' : 'TILES', x0 + barW + 8, y + 1, { size: 12, color: C.ink2, anchorX: 0, bg: false, weight: '600' });
  }

  private mapRect = { x: 0, y: 0, w: 0, h: 0 };
  /** Label boxes placed this frame (centre x/y, width, height) for collision checks. */
  private placed: { x: number; y: number; w: number; h?: number; pin?: boolean }[] = [];
  /** Boxes of static drawing text (area names, drawing title, scale bar) that live labels must avoid. */
  private staticBoxes: { x: number; y: number; w: number; h?: number }[] = [];
  private robotPts: { id: string; x: number; y: number }[] = [];
  /** Red-pen notes on the plan that link to their brain-feed row. */
  private hotspots: (Rect & { key: string; id: string })[] = [];
  onRevision: (key: string, characterId: string) => void = () => {};

  private drawNorth() {
    const L = this.L!;
    const p = this.paper;
    const r = L.compact ? 10 : 12;
    // Pinned above the camera buttons so it stays readable at any zoom or pan.
    const anchor = this.reserved[0];
    const cx = anchor ? anchor.x + anchor.w / 2 + 6 : L.w - 34;
    const cy = anchor ? anchor.y + r + 6 : 34;
    p.circle(cx, cy, r + 4).fill({ color: C.sheet, alpha: 0.9 });
    const a = this.ang(-Math.PI / 2);
    p.circle(cx, cy, r).stroke({ width: 1, color: C.ink2, alpha: 0.7 });
    const tip = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    const l = { x: cx + Math.cos(a + 2.5) * r * 0.6, y: cy + Math.sin(a + 2.5) * r * 0.6 };
    const rr = { x: cx + Math.cos(a - 2.5) * r * 0.6, y: cy + Math.sin(a - 2.5) * r * 0.6 };
    p.poly([tip.x, tip.y, l.x, l.y, cx, cy, rr.x, rr.y]).fill({ color: C.ink, alpha: 0.9 });
    this.label('north', 'N', cx - r - 8, cy, { size: 12, color: C.ink2, bg: false, anchorX: 1 });
  }

  /* ---------------------------------------------------------- objects */

  /** The tile under a screen point, or null outside the map. */
  private tileAt(sx: number, sy: number): Vec2 | null {
    if (!this.L) return null;
    const w = this.toWorld(sx, sy);
    const x = Math.floor(w.x);
    const y = Math.floor(w.y);
    return x >= 0 && y >= 0 && x < this.L.W && y < this.L.H ? { x, y } : null;
  }

  private hitDrop(sx: number, sy: number): string | null {
    const r = Math.max(14, Math.min((this.L?.ts ?? 30) * 0.5, 40));
    let best: string | null = null;
    let bd = r;
    for (const d of this.dropPts) {
      const dist = Math.hypot(d.x - sx, d.y - sy);
      if (dist < bd) {
        bd = dist;
        best = d.id;
      }
    }
    return best;
  }

  private hitMailbox(sx: number, sy: number): boolean {
    const m = this.mailboxPt;
    return !!m && Math.hypot(m.x - sx, m.y - sy) < Math.max(14, Math.min((this.L?.ts ?? 30) * 0.55, 40));
  }

  /** Airdropped items: icon, a dashed drop ring with a ▼ drop mark, an expiry arc, and a name label on hover/focus. */
  private drawDrops(world: WorldView) {
    const g = this.objectsG;
    const L = this.L!;
    const ts = L.ts;
    this.dropPts = [];
    const v = this.visitors;
    if (!v) return;
    for (const d of v.airdrops) {
      const ent = world.objects.find((o) => o.id === d.entityId);
      if (ent?.heldBy) continue; // carried: drawn with its carrier as an object
      const c = this.center(ent?.pos ?? d.pos);
      const size = Math.max(18, Math.min(ts * 0.78, 44));
      const r = size * 0.62;
      this.dropPts.push({ id: d.id, x: c.x, y: c.y });
      this.placed.push({ x: c.x, y: c.y, w: r * 2, h: r * 2 });
      g.circle(c.x, c.y, r).fill({ color: C.sheet, alpha: 0.85 });
      dashCircle(g, c.x, c.y, r, 3, 3);
      g.stroke({ width: 1, color: C.ink2, alpha: 0.8 });
      // expiry: the remaining share of its life, as an arc on the ring
      if (d.expiresTick && d.expiresTick > d.droppedTick) {
        const left = Math.max(0, Math.min(1, (d.expiresTick - world.clock.tick) / (d.expiresTick - d.droppedTick)));
        const a0 = -Math.PI / 2;
        g.moveTo(c.x + Math.cos(a0) * r, c.y + Math.sin(a0) * r);
        g.arc(c.x, c.y, r, a0, a0 + left * Math.PI * 2);
        g.stroke({ width: 2, color: C.ink, cap: 'round' });
      }
      // drop mark: a small chevron above the ring, as if it came from above
      g.poly([c.x - 4, c.y - r - 9, c.x + 4, c.y - r - 9, c.x, c.y - r - 3]).fill({ color: C.ink });
      drawIcon(g, d.item.icon, c.x, c.y, size, C.ink);
      const lit = this.focusDrop === d.id || this.hoverDrop === d.id;
      if (lit || ts >= 44) {
        const name = d.item.name.toUpperCase();
        const w = name.length * 8 + 10;
        // below the ring, else above its drop mark, else beside it: whichever is clear
        const spots = [{ x: c.x, y: c.y + r + 12 }, { x: c.x, y: c.y - r - 20 }, { x: c.x + r + 8 + w / 2, y: c.y }, { x: c.x - r - 8 - w / 2, y: c.y }];
        const at = spots.find((p) => !this.collides(p.x, p.y, w, 16)) ?? spots[0]!;
        this.label(`drop-${d.id}`, name, at.x, at.y, { size: 13, spacing: 1, weight: lit ? '700' : '600' });
        this.placed.push({ x: at.x, y: at.y, w, h: 16 });
      }
      if (lit) g.circle(c.x, c.y, r + 5).stroke({ width: 1.5, color: C.ink });
    }
  }

  /** Placement preview: the chosen (or hovered) tile outlined, the item's icon dashed into it. */
  private drawPlacement(g: Graphics) {
    if (!this.placing) return;
    const t = this.placeAt ?? this.placeHover;
    if (!t) return;
    const ts = this.L!.ts;
    const a = this.P(t.x, t.y);
    const b = this.P(t.x + 1, t.y + 1);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    g.rect(x, y, ts, ts).stroke({ width: 2, color: C.focus });
    const c = this.center(t);
    drawIcon(g, this.placing.icon, c.x, c.y, Math.max(18, Math.min(ts * 0.78, 44)), C.focus, this.placeAt ? 1 : 0.6);
    const label = this.placeAt ? `DROP HERE · ${this.placing.name.toUpperCase()}` : this.placing.name.toUpperCase();
    const w = label.length * 8 + 10;
    const spots = [{ x: c.x, y: y - 12 }, { x: c.x, y: y + ts + 12 }, { x: x + ts + 6 + w / 2, y: c.y }, { x: x - 6 - w / 2, y: c.y }];
    const at = spots.find((p) => !this.collides(p.x, p.y, w, 16)) ?? spots[0]!;
    this.label('place-tag', label, at.x, at.y, { size: 13, weight: '700', color: C.focus, spacing: 0.8 });
  }

  private drawObjects(world: WorldView) {
    const g = this.objectsG;
    g.clear();
    const L = this.L!;
    const ts = L.ts;
    const daylight = clockOf(world.clock.tick, world.clock).daylight;
    // Activity is read from what the robots are doing, so it is the same for any pack state shape.
    const busy = (id: string, verb: string) => world.characters.some((c) => c.action?.verb === verb && c.action.targetId === id);
    this.mailboxPt = null;
    this.objectPts = [];
    // Footprints first (the garden bed), so what grows in them draws on top.
    for (const o of world.objects) if (o.type !== 'airdrop' && !o.heldBy && this.footprintOf(o)) this.drawFootprint(g, o, world);
    for (const o of world.objects) {
      if (o.type === 'airdrop') continue; // drawn by drawDrops from the visitor layer
      // A carried object rides with its carrier (at the carrier's glide position), slightly ahead of it.
      const carrier = o.heldBy ? this.disp.get(o.heldBy) : undefined;
      if (o.heldBy && !carrier) continue;
      const c = carrier ? this.center({ x: carrier.x + 0.3, y: carrier.y - 0.3 }) : this.center(o.pos);
      const fp = this.footprintOf(o);
      if (fp) {
        // Its footprint is drawn already; label it at the footprint's centre.
        const fc = this.center({ x: o.pos.x + (fp.w - 1) / 2, y: o.pos.y + (fp.h - 1) / 2 });
        this.objectPts.push({ id: o.id, x: fc.x, y: fc.y, r: ts * Math.max(fp.w, fp.h) * 0.5 });
        const spot = this.fixtureLabelSpot(o, { x: fc.x, y: fc.y - (L.rot ? fp.w : fp.h) * ts * 0.5 + ts * 0.5 }, true);
        if (spot) {
          this.label(`obj-${o.id}`, spot.name, spot.x, spot.nameY, { size: L.compact ? 12 : 13, spacing: 1.2 });
          this.placed.push({ x: spot.x, y: spot.nameY, w: spot.nameW, h: 14 });
        }
        continue;
      }
      if (!carrier) this.objectPts.push({ id: o.id, x: c.x, y: c.y, r: ts * 0.5 });
      this.placed.push({ x: c.x, y: c.y, w: ts * 0.95, h: ts * 0.95 });
      if (this.focusObject === o.id) g.circle(c.x, c.y, ts * 0.62).stroke({ width: 1.5, color: C.ink });
      const s = (x: number, y: number) => {
        // local unit coords → screen, rotating with the plan
        const [rx, ry] = L.rot ? [-y, x] : [x, y];
        return { x: c.x + rx * ts, y: c.y + ry * ts };
      };
      const poly = (pts: [number, number][]) => pts.flatMap(([x, y]) => {
        const q = s(x, y);
        return [q.x, q.y];
      });
      switch (o.type) {
        case 'solarPad': {
          g.poly(poly([[-0.42, -0.42], [0.42, -0.42], [0.42, 0.42], [-0.42, 0.42]])).fill({ color: C.ink, alpha: busy(o.id, 'charge') && daylight ? 0.22 : 0.06 });
          g.poly(poly([[-0.42, -0.42], [0.42, -0.42], [0.42, 0.42], [-0.42, 0.42]])).stroke({ width: 2, color: C.ink });
          for (const v of [-0.14, 0.14]) {
            const a = s(v, -0.42), b = s(v, 0.42), d = s(-0.42, v), e = s(0.42, v);
            g.moveTo(a.x, a.y).lineTo(b.x, b.y).moveTo(d.x, d.y).lineTo(e.x, e.y);
          }
          g.stroke({ width: 1, color: C.ink2, alpha: 0.8 });
          if (daylight) {
            for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
              const a = s(x * 0.5, y * 0.5), b = s(x * 0.64, y * 0.64);
              g.moveTo(a.x, a.y).lineTo(b.x, b.y);
            }
            g.stroke({ width: 1.5, color: C.ink, alpha: 0.9 });
          }
          break;
        }
        case 'dock': {
          const pts = poly([[-0.44, 0.46], [-0.44, -0.44], [0.44, -0.44], [0.44, 0.46]]);
          g.moveTo(pts[0]!, pts[1]!);
          for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i]!, pts[i + 1]!);
          g.stroke({ width: 2.5, color: C.ink, join: 'miter' });
          g.poly(poly([[-0.14, -0.44], [0.14, -0.44], [0.14, -0.28], [-0.14, -0.28]])).fill({ color: C.ink, alpha: 0.9 });
          const a = s(-0.44, 0.46), b = s(0.44, 0.46);
          dash(g, a.x, a.y, b.x, b.y, 3, 3);
          g.stroke({ width: 1, color: C.ink2, alpha: 0.8 });
          break;
        }
        case 'ball': {
          g.circle(c.x, c.y, ts * 0.22).fill({ color: C.sheet }).stroke({ width: 2, color: C.ink });
          const ax = c.x - ts * 0.3;
          g.moveTo(ax + Math.cos(-0.62) * ts * 0.3, c.y + Math.sin(-0.62) * ts * 0.3);
          g.arc(ax, c.y, ts * 0.3, -0.62, 0.62).stroke({ width: 1, color: C.ink2 });
          break;
        }
        case 'fountain': {
          g.circle(c.x, c.y, ts * 0.44).stroke({ width: 2, color: C.ink });
          g.circle(c.x, c.y, ts * 0.27).stroke({ width: 1.25, color: C.ink2 });
          g.circle(c.x, c.y, ts * 0.07).fill({ color: C.ink });
          if (o.state['flowing'] !== false) {
            for (let k = 0; k < 8; k++) {
              const a = (k / 8) * Math.PI * 2;
              g.moveTo(c.x + Math.cos(a) * ts * 0.11, c.y + Math.sin(a) * ts * 0.11).lineTo(c.x + Math.cos(a) * ts * 0.2, c.y + Math.sin(a) * ts * 0.2);
            }
            g.stroke({ width: 1, color: C.ink2, alpha: 0.85 });
          }
          break;
        }
        case 'mailbox': {
          // A post box (plan view: box with a slot) and a flag that rises while mail is waiting.
          const waiting = this.visitors?.mail ? this.visitors.waiting : Number(o.state['waiting'] ?? 0);
          this.mailboxPt = c;
          g.poly(poly([[-0.34, -0.26], [0.34, -0.26], [0.34, 0.3], [-0.34, 0.3]])).fill({ color: C.sheet }).stroke({ width: 2, color: C.ink });
          const s0 = s(-0.18, -0.06), s1 = s(0.18, -0.06);
          g.moveTo(s0.x, s0.y).lineTo(s1.x, s1.y).stroke({ width: 2.5, color: C.ink, cap: 'round' });
          const pole0 = s(0.34, 0.2), pole1 = s(0.34, waiting ? -0.62 : -0.1);
          g.moveTo(pole0.x, pole0.y).lineTo(pole1.x, pole1.y).stroke({ width: 1.5, color: C.ink });
          if (waiting) {
            g.poly(poly([[0.34, -0.62], [0.66, -0.52], [0.34, -0.42]])).fill({ color: C.ink });
            // count callout: a circled number on a short leader
            // placed on whichever diagonal is clear of other things on the plan
            const others = [...world.objects.filter((x) => x.id !== o.id && x.type !== 'airdrop').map((x) => x.pos), ...(this.visitors?.airdrops.map((d) => d.pos) ?? [])].map((p) => this.center(p));
            const cands = [[1, -1], [-1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({ x: c.x + sx! * (ts * 0.62 + 12), y: c.y + sy! * (ts * 0.62 + 8) }));
            const cc = cands.find((q) => !this.collides(q.x, q.y, 24, 24) && others.every((p) => Math.hypot(p.x - q.x, p.y - q.y) > Math.max(22, ts * 0.6))) ?? cands[0]!;
            const tip = cc.x > c.x ? s(0.62, -0.5) : { x: c.x - ts * 0.34, y: cc.y > c.y ? c.y + ts * 0.3 : c.y - ts * 0.26 };
            const ang = Math.atan2(tip.y - cc.y, tip.x - cc.x);
            g.moveTo(tip.x, tip.y).lineTo(cc.x + Math.cos(ang) * 11, cc.y + Math.sin(ang) * 11).stroke({ width: 1, color: C.ink2 });
            g.circle(cc.x, cc.y, 11).fill({ color: C.sheet }).stroke({ width: 1.5, color: C.ink });
            this.label(`mail-count`, String(waiting), cc.x, cc.y + 1, { size: 13, weight: '700', bg: false });
            this.placed.push({ x: cc.x, y: cc.y, w: 24, h: 24 });
          }
          break;
        }
        case 'plant':
          this.drawPlant(g, o, s, ts);
          break;
        case 'seed': {
          const a = s(-0.1, -0.16), b = s(0.1, 0.16);
          g.ellipse(c.x, c.y, Math.abs(b.x - a.x) / 2 + 1, Math.abs(b.y - a.y) / 2 + 1).fill({ color: C.ink2 }).stroke({ width: 1.25, color: C.ink });
          break;
        }
        case 'flower':
          this.drawBloom(g, c.x, c.y, ts * 0.16, Number(o.state['fresh'] ?? 1) < 0.3);
          break;
        case 'watering-can': {
          // Body in plan view, spout to one side; the water level fills it from the bottom.
          const lvl = Math.max(0, Math.min(1, Number(o.state['water'] ?? 0)));
          g.poly(poly([[-0.28, -0.26], [0.18, -0.26], [0.18, 0.3], [-0.28, 0.3]])).fill({ color: C.sheet }).stroke({ width: 2, color: C.ink });
          if (lvl > 0.02) {
            g.poly(poly([[-0.28, 0.3 - 0.56 * lvl], [0.18, 0.3 - 0.56 * lvl], [0.18, 0.3], [-0.28, 0.3]])).fill({ color: C.ink2 });
            const w0 = s(-0.28, 0.3 - 0.56 * lvl), w1 = s(0.18, 0.3 - 0.56 * lvl);
            g.moveTo(w0.x, w0.y).lineTo(w1.x, w1.y).stroke({ width: 1.5, color: C.ink }); // waterline
          }
          const sp0 = s(0.18, -0.02), sp1 = s(0.46, -0.3);
          g.moveTo(sp0.x, sp0.y).lineTo(sp1.x, sp1.y).stroke({ width: 2, color: C.ink, cap: 'round' });
          break;
        }
        case 'antenna-mast': {
          g.poly(poly([[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]])).fill({ color: C.sheet }).stroke({ width: 2, color: C.ink });
          for (const [x0, y0, x1, y1] of [[-0.3, -0.3, 0.3, 0.3], [0.3, -0.3, -0.3, 0.3]] as const) {
            const a = s(x0, y0), b = s(x1, y1);
            g.moveTo(a.x, a.y).lineTo(b.x, b.y);
          }
          g.stroke({ width: 1, color: C.ink2 });
          g.circle(c.x, c.y, ts * 0.09).fill({ color: C.ink });
          // Signal range (from its definition's `nearby` rule) when it's selected.
          if (this.focusObject === o.id) {
            const range = this.store.objectDefs.get(o.type)?.rules?.find((r) => r.nearby)?.nearby?.range ?? 3;
            dashCircle(g, c.x, c.y, (range + 0.5) * ts, 6, 5);
            g.stroke({ width: 1.25, color: C.ink2 });
            const R = (range + 0.5) * ts;
            const txt = `SIGNAL · ${range} TILES`;
            const tw = txt.length * 7 + 10;
            const cands = [{ x: c.x, y: c.y + R + 10 }, { x: c.x, y: c.y - R - 10 }, { x: c.x + R + tw / 2 + 6, y: c.y }, { x: c.x - R - tw / 2 - 6, y: c.y }];
            const inside = (q: Vec2) => q.y > 30 && q.y < L.h - this.insets.bottom - 10 && q.x - tw / 2 > 8 && q.x + tw / 2 < L.w - 8;
            const at = cands.find((q) => inside(q) && !this.collides(q.x, q.y, tw, 14)) ?? cands.find(inside) ?? cands[0]!;
            this.label(`mast-range-${o.id}`, txt, at.x, at.y, { size: 12, color: C.ink2 });
            this.placed.push({ x: at.x, y: at.y, w: tw, h: 14 });
          }
          break;
        }
        case 'piano': {
          g.poly(poly([[-0.48, -0.34], [0.48, -0.34], [0.48, 0.34], [-0.48, 0.34]])).fill({ color: C.ink, alpha: busy(o.id, 'play') ? 0.16 : 0.04 }).stroke({ width: 2, color: C.ink });
          const k0 = s(-0.48, 0.1), k1 = s(0.48, 0.1);
          g.moveTo(k0.x, k0.y).lineTo(k1.x, k1.y);
          for (let i = 1; i < 8; i++) {
            const x = -0.48 + i * 0.12;
            const a = s(x, 0.1), b = s(x, 0.34);
            g.moveTo(a.x, a.y).lineTo(b.x, b.y);
          }
          g.stroke({ width: 1, color: C.ink2 });
          for (const i of [1, 2, 4, 5, 6]) {
            const x = -0.48 + i * 0.12;
            g.poly(poly([[x - 0.03, 0.1], [x + 0.03, 0.1], [x + 0.03, 0.24], [x - 0.03, 0.24]])).fill({ color: C.ink, alpha: 0.85 });
          }
          break;
        }
        default: {
          // Any other object (pack or catalogue): its definition's icon, in line ink.
          const d = this.store.objectDefs.get(o.type);
          if (d?.icon) drawIcon(g, d.icon, c.x, c.y, Math.max(16, Math.min(ts * 0.8, 40)), C.ink);
          else g.rect(c.x - ts * 0.3, c.y - ts * 0.3, ts * 0.6, ts * 0.6).stroke({ width: 1.5, color: C.ink2 });
        }
      }
      // Plants in a bed and loose seeds stay unlabelled unless chosen: the bed's label names the place.
      if (o.type === 'plant' || o.type === 'seed') continue;
      const spot = carrier ? undefined : this.fixtureLabelSpot(o, c, true);
      if (spot) {
        const { name, nameY, x, vtxt, verbY } = spot;
        this.label(`obj-${o.id}`, name, x, nameY, { size: L.compact ? 12 : 13, spacing: 1.2 });
        this.placed.push({ x, y: nameY, w: spot.nameW, h: 14 });
        if (verbY !== null && !this.collides(x, verbY, vtxt.length * 6, 14)) {
          this.placed.push({ x, y: verbY, w: vtxt.length * 6, h: 14 });
          this.label(`objv-${o.id}`, vtxt, x, verbY, { size: 12, color: C.ink3, weight: '500', spacing: 0.3 });
        }
      }
    }
  }

  private footprintOf(o: ObjectView): { w: number; h: number } | null {
    const fp = o.footprint ?? this.store.objectDefs.get(o.type)?.footprint;
    return fp && (fp.w > 1 || fp.h > 1) ? fp : null;
  }

  /** A footprint object (the garden bed): a ruled bed of soil over its tiles, lightly hatched. */
  private drawFootprint(g: Graphics, o: ObjectView, _world: WorldView) {
    const fp = this.footprintOf(o)!;
    const a = this.P(o.pos.x + 0.08, o.pos.y + 0.08);
    const b = this.P(o.pos.x + fp.w - 0.08, o.pos.y + fp.h - 0.08);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    g.rect(x, y, w, h).fill({ color: C.sheet, alpha: 0.6 });
    // soil: sparse diagonal hatch, like the pond's but lighter
    const gap = Math.max(6, this.L!.ts * 0.22);
    for (let k = gap; k < w + h; k += gap) {
      const x0 = x + Math.max(0, k - h);
      const y0 = y + Math.min(k, h);
      const x1 = x + Math.min(k, w);
      const y1 = y + Math.max(0, k - w);
      g.moveTo(x0, y0).lineTo(x1, y1);
    }
    g.stroke({ width: 0.75, color: C.ink2, alpha: 0.35 });
    g.rect(x, y, w, h).stroke({ width: 2.5, color: C.ink, join: 'miter' });
    if (this.focusObject === o.id) g.rect(x - 5, y - 5, w + 10, h + 10).stroke({ width: 1.5, color: C.ink });
  }

  /** A plant by growth band: soil, shoot, leafy, bud, flower (docs/architecture/objects.md). */
  private drawPlant(g: Graphics, o: ObjectView, s: (x: number, y: number) => Vec2, ts: number) {
    const growth = Number(o.state['growth'] ?? 0);
    const water = Number(o.state['water'] ?? 1);
    const flowering = growth >= 1 || (o.products?.some((p) => p.slot === 'flower' && p.ready > 0) ?? false);
    const c = s(0, 0);
    // A dried-out planting hole shows as a dashed ring (the bed's hatch is the soil).
    if (water < 0.15) {
      dashCircle(g, c.x, c.y, ts * 0.32, 2, 3);
      g.stroke({ width: 1, color: C.ink2 });
    }
    if (growth < 0.1) {
      g.circle(c.x, c.y, ts * 0.06).fill({ color: C.ink2 });
      return;
    }
    // Top-down: leaves as pointed lenses in alternate pairs of unequal length (never a regular
    // rosette, which would read as a flower); two for a shoot, four when leafy. Minimum sizes keep
    // the bands apart at the default zoom.
    const unit = Math.max(ts, 30);
    const spec: [number, number][] = growth < 0.4 ? [[0.35, 0.22], [3.5, 0.17]] : [[0.35, 0.36], [3.5, 0.3], [1.95, 0.24], [5.1, 0.19]];
    for (const [a, len] of spec) {
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const wid = len * 0.4;
      const L = (k: number) => (k * unit) / ts; // local units scaled so the leaf keeps a minimum size
      const tip = s(L(ux * len), L(uy * len));
      const l = s(L(ux * len * 0.5 - uy * wid), L(uy * len * 0.5 + ux * wid));
      const r = s(L(ux * len * 0.5 + uy * wid), L(uy * len * 0.5 - ux * wid));
      g.moveTo(c.x, c.y).quadraticCurveTo(l.x, l.y, tip.x, tip.y).quadraticCurveTo(r.x, r.y, c.x, c.y);
      g.fill({ color: C.ink, alpha: 0.18 }).stroke({ width: 1.5, color: C.ink });
    }
    if (flowering) this.drawBloom(g, c.x, c.y, Math.max(5, ts * 0.13), false);
    else if (growth >= 0.7) {
      // a bud: a closed teardrop pointing up the plan
      const r = Math.max(5, ts * 0.14);
      const top = s(0, -(r * 1.6) / ts);
      g.moveTo(top.x, top.y).quadraticCurveTo(c.x + r * 1.1, c.y + r * 0.2, c.x, c.y + r * 0.7).quadraticCurveTo(c.x - r * 1.1, c.y + r * 0.2, top.x, top.y);
      g.fill({ color: C.sheet }).stroke({ width: 1.5, color: C.ink });
    } else g.circle(c.x, c.y, Math.max(2, ts * 0.04)).fill({ color: C.ink });
  }

  /** Five petals round a dense centre; a wilting flower droops (dashed petals). */
  private drawBloom(g: Graphics, x: number, y: number, r: number, wilting: boolean) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      g.circle(px, py, r * 0.62).fill({ color: C.sheet });
      if (wilting) dashCircle(g, px, py, r * 0.62, 2, 2);
      else g.circle(px, py, r * 0.62);
    }
    g.stroke({ width: 1.25, color: C.ink });
    g.circle(x, y, r * 0.45).fill({ color: C.ink });
  }

  /** The object under a canvas point (footprints count their whole area); robots and drops win first. */
  private hitObject(sx: number, sy: number): string | null {
    let best: { id: string; d: number } | null = null;
    for (const p of this.objectPts) {
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d <= Math.max(p.r, 14) && (!best || d < best.d)) best = { id: p.id, d };
    }
    return best?.id ?? null;
  }

  /** True if any of three points across a label's width lands on a wall tile. */
  private labelOnWall(x: number, y: number, w: number): boolean {
    const L = this.L!;
    const tiles = this.store.world?.map.tiles;
    if (!tiles) return false;
    return [x - w / 2 + 2, x, x + w / 2 - 2].some((px) => {
      for (const py of [y - 5, y + 5]) {
        const t = this.toWorld(px, py);
        if (tiles[Math.floor(t.y) * L.W + Math.floor(t.x)] === 'wall') return true;
      }
      return false;
    });
  }

  /**
   * Where a fixture's name (and verb list, when zoomed in) goes: above by default (robots park
   * south), else below, right or left, never over a wall. With `live`, also clear of this
   * frame's labels; without, walls only (used to keep dimension strings off fixture labels).
   */
  private fixtureLabelSpot(o: { type: string }, c: Vec2, live: boolean) {
    const L = this.L!;
    const ts = L.ts;
    const verbs = ts >= (L.compact ? 44 : 30);
    // Label and verb list come from the world's pack catalog.
    const name = this.store.objectLabel(o.type).toUpperCase();
    const vtxt = this.store.objectVerbs(o.type).join(' · ');
    const nameW = name.length * (L.compact ? 7 : 8) + 10;
    const blockW = Math.max(nameW, verbs ? vtxt.length * 6 : 0);
    const gap = L.compact ? 7 : 9;
    const half = ts * 0.5;
    const cands = [
      { x: c.x, nameY: c.y - half - gap - (verbs ? 15 : 0), verbY: verbs ? c.y - half - gap : null },
      { x: c.x, nameY: c.y + half + gap, verbY: verbs ? c.y + half + gap + 15 : null },
      { x: c.x + half + 8 + blockW / 2, nameY: c.y - (verbs ? 7 : 0), verbY: verbs ? c.y + 8 : null },
      { x: c.x - half - 8 - blockW / 2, nameY: c.y - (verbs ? 7 : 0), verbY: verbs ? c.y + 8 : null },
    ];
    // Live placement also keeps clear of robots (positions from the previous frame), e.g. robots parked at the dock.
    const onRobot = (k: (typeof cands)[number]) =>
      this.robotPts.some((q) => Math.abs(q.x - k.x) < nameW / 2 + ts * 0.42 && Math.abs(q.y - k.nameY) < ts * 0.42 + 8);
    const ok = (k: (typeof cands)[number]) =>
      !this.labelOnWall(k.x, k.nameY, nameW) && (!live || (!this.collides(k.x, k.nameY, nameW, 14) && !onRobot(k)));
    const k = cands.find(ok) ?? (live ? undefined : cands[0]);
    return k ? { ...k, name, nameW, vtxt } : undefined;
  }

  private collides(x: number, y: number, w: number, h: number): boolean {
    const r = { x: x - w / 2, y: y - h / 2, w, h };
    return this.placed.some((b) => overlap(r, { x: b.x - b.w / 2, y: b.y - (b.h ?? 14) / 2, w: b.w, h: b.h ?? 14 })) || this.reserved.some((q) => overlap(r, q));
  }

  /* ------------------------------------------------------------ frame */

  private lastFrame = performance.now();

  private frame() {
    const world = this.store.world;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!world) return;
    this.L = this.layout(world);
    this.stepCamera(dt);
    this.L = this.layout(world);
    const key = `${this.L.w}x${this.L.h}:${this.L.baseTs}:${this.lastCamKey}:${this.L.rot}:${world.worldId}:${world.map.tiles.length}:${this.insets.top},${this.insets.bottom},${this.insets.right}`;
    for (const l of this.labels.values()) l.used = false;
    this.labelBg.clear();
    if (key !== this.staticKey) {
      this.staticKey = key;
      this.drawStatic(world);
      this.staticShown = new Set([...this.labels].filter(([k, l]) => l.used && /^(ref-|area-|dim-|dt-|sb-|north)/.test(k)).map(([k]) => k));
    } else {
      // keep the static labels from the last static pass alive (and visible again if a callout hid them)
      for (const k of this.staticShown) {
        const l = this.labels.get(k);
        if (!l) continue;
        l.used = true;
        l.t.visible = true;
        if (k.startsWith('dim-')) this.redrawLabelBg(l.t);
      }
      const pond = this.labels.get('area-pond');
      if (pond) this.redrawLabelBg(pond.t);
    }
    this.placed = [...this.staticBoxes];
    this.drawObjects(world);
    this.drawDrops(world);
    this.drawDynamic(world, dt, now);
    // A label sliced by the drawing-area edge reads as a fragment: hide it until it is fully in view.
    const m = this.maskRect;
    for (const l of this.labels.values()) {
      if (!l.used) continue;
      const t = l.t;
      const x = t.x - t.anchor.x * t.width;
      const y = t.y - t.anchor.y * t.height;
      if (x < m.x || y < m.y || x + t.width > m.x + m.w || y + t.height > m.y + m.h) l.used = false;
    }
    for (const l of this.labels.values()) if (!l.used) l.t.visible = false;
  }

  private redrawLabelBg(t: Text) {
    const left = t.x - t.anchor.x * t.width;
    const top = t.y - t.anchor.y * t.height;
    this.labelBg.rect(Math.round(left - 3), Math.round(top), Math.round(t.width + 6), Math.round(t.height)).fill({ color: C.sheet, alpha: 0.9 });
  }

  private drawDynamic(world: WorldView, dt: number, now: number) {
    const g = this.dyn;
    g.clear();
    this.overG.clear();
    const L = this.L!;
    const ts = L.ts;
    const reduced = this.reduced.matches;
    const selected = this.store.selectedId;

    // Smooth display positions toward the 10 Hz sim positions.
    for (const c of world.characters) {
      const d = this.disp.get(c.id);
      const tgt = this.parkedPos(c, world);
      const st = c.step;
      const parked = tgt.x !== c.pos.x || tgt.y !== c.pos.y;
      if (st && !parked && !reduced && d && st.to.x === c.pos.x && st.to.y === c.pos.y) {
        // Glide a whole-tile step over the world's step time (moveTicksPerTile ticks at the effective tick rate).
        const ms = (world.clock.moveTicksPerTile / Math.max(0.1, this.store.ticksPerRealSecond)) * 1000;
        const t = Math.min(1, (now - st.at) / ms);
        this.disp.set(c.id, { x: st.from.x + (st.to.x - st.from.x) * t, y: st.from.y + (st.to.y - st.from.y) * t });
      } else if (!d || reduced || Math.hypot(d.x - tgt.x, d.y - tgt.y) > 2) this.disp.set(c.id, { ...tgt });
      else {
        const k = Math.min(1, dt * 12);
        d.x += (tgt.x - d.x) * k;
        d.y += (tgt.y - d.y) * k;
      }
    }

    // Trails: faint dashed paths.
    for (const c of world.characters) {
      const pts = [...c.trail, this.disp.get(c.id)!];
      const isSel = c.id === selected;
      for (let i = 1; i < pts.length; i++) {
        const a = this.center(pts[i - 1]!);
        const b = this.center(pts[i]!);
        if (Math.hypot(a.x - b.x, a.y - b.y) > ts * 1.6) continue;
        dash(g, a.x, a.y, b.x, b.y, 3, 4);
      }
      g.stroke({ width: 1, color: C.ink2, alpha: isSel ? 0.6 : 0.3 });
    }

    // Selected: construction circles and dimension line to the target.
    const sel = world.characters.find((c) => c.id === selected);
    const ringLabels: { key: string; name: string; x: number; y: number; r: number }[] = [];
    if (sel) {
      const p = this.center(this.disp.get(sel.id)!);
      const asleep = sel.mind.asleep;
      for (const [r, name] of [
        [sel.sightRange * (asleep ? 0.5 : 1), `SIGHT ${sel.sightRange * (asleep ? 0.5 : 1)}`],
        [sel.hearingRange, `HEARING ${sel.hearingRange}`],
      ] as const) {
        dashCircle(g, p.x, p.y, r * ts, 6, 5);
        g.stroke({ width: 1.25, color: C.ink2, alpha: 0.7 });
        ringLabels.push({ key: `ring-${name}`, name, x: p.x, y: p.y, r: r * ts });
      }
      const target = sel.action?.targetId ? world.objects.find((o) => o.id === sel.action!.targetId) ?? world.characters.find((x) => x.id === sel.action!.targetId) : undefined;
      if (target) {
        const tp = this.center(this.disp.get(target.id) ?? target.pos);
        dash(g, p.x, p.y, tp.x, tp.y, 7, 4);
        g.stroke({ width: 1.25, color: C.ink, alpha: 0.75 });
        g.circle(tp.x, tp.y, ts * 0.6).stroke({ width: 1, color: C.ink, alpha: 0.6 });
      }
    }

    // Sound arcs first: note labels must always show, so robot labels make way for them.
    this.robotPts = world.characters.map((c) => ({ id: c.id, ...this.center(this.disp.get(c.id)!) }));
    for (const n of this.store.noises) this.drawNoise(g, n, now, reduced, world);

    // Robots parked together at the dock share one stacked, leader-lined tag, so none goes unnamed at fit.
    this.groupLabelled = this.drawParkedTag(g, world);

    // Robots.
    // The selected robot claims its label spot first; the others make way.
    for (const c of [...world.characters].sort((a, b) => Number(b.id === selected) - Number(a.id === selected)))
      this.drawRobot(g, c, c.id === selected, c.id === this.hoverId);

    this.drawPlacement(g);

    // Red pen alerts (revision clouds) and the selected callout.
    this.hotspots = [];
    for (const c of world.characters) if (c.alerts.length) this.drawAlerts(g, c);
    if (sel) {
      const box = this.drawCallout(this.overG, sel);
      // Never let a fragment of a label peek out beside the callout: hide anything it partly covers.
      const pad = { x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 };
      for (const [k, l] of this.labels) {
        if (!l.used || !l.t.visible || k.startsWith('co-') || l.t.parent !== this.textLayer) continue;
        const t = l.t;
        const r = { x: t.x - t.anchor.x * t.width, y: t.y - t.anchor.y * t.height, w: t.width, h: t.height };
        if (overlap(r, pad)) l.used = false;
      }
      // Ring labels: first angle whose spot is on screen, off water, off the callout and other labels.
      for (const r of ringLabels) {
        const w = r.name.length * 7 + 8;
        for (const a of [(3 * Math.PI) / 4, Math.PI / 4, (-3 * Math.PI) / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
          const x = r.x + Math.cos(a) * r.r;
          const y = r.y + Math.sin(a) * r.r + (Math.sin(a) >= 0 ? 10 : -10);
          const mr = this.mapRect;
          if (x - w / 2 < Math.max(8, mr.x) || x + w / 2 > Math.min(L.w - 8, mr.x + mr.w) || y < Math.max(this.insets.top + 10, mr.y + 8) || y > Math.min(L.h - this.insets.bottom - 10, mr.y + mr.h - 8)) continue;
          const t = this.toWorld(x, y);
          const tile = world.map.tiles[Math.floor(t.y) * L.W + Math.floor(t.x)];
          if (tile === 'water' || tile === 'wall') continue;
          if (overlap({ x: x - w / 2, y: y - 8, w, h: 16 }, box) || this.collides(x, y, w, 16)) continue;
          this.placed.push({ x, y, w, h: 16 });
          this.label(r.key, r.name, x, y, { size: 12, color: C.ink2, weight: '600' });
          break;
        }
      }
    }
  }

  /**
   * Robots resting at the dock are drawn parked in a row in front of the bay's opening
   * (display only: the sim keeps their real tiles), so they never sit on the dock symbol.
   */
  private parkedPos(c: CharacterView, world: WorldView): Vec2 {
    const a = c.action;
    const dock = world.objects.find((o) => o.type === 'dock');
    if (!dock || !(c.mind.asleep || (a?.verb === 'rest' && a.targetId === dock.id))) return c.pos;
    if (Math.abs(c.pos.x - dock.pos.x) > 1.1 || Math.abs(c.pos.y - dock.pos.y) > 1.1) return c.pos;
    const parked = world.characters
      .filter((o) => {
        const oa = o.action;
        return (o.mind.asleep || (oa?.verb === 'rest' && oa.targetId === dock.id)) && Math.abs(o.pos.x - dock.pos.x) <= 1.1 && Math.abs(o.pos.y - dock.pos.y) <= 1.1;
      })
      .map((o) => o.id)
      .sort();
    const i = parked.indexOf(c.id);
    const n = parked.length;
    return { x: dock.pos.x + (i - (n - 1) / 2) * 1.05, y: dock.pos.y + 1.1 };
  }

  private groupLabelled = new Set<string>();

  /** One tag naming every robot parked at the dock ("RB-01 · RB-02 · RB-03"), on a leader. */
  private drawParkedTag(g: Graphics, world: WorldView): Set<string> {
    const L = this.L!;
    const ts = L.ts;
    const parked = world.characters.filter((c) => {
      const p = this.parkedPos(c, world);
      return p.x !== c.pos.x || p.y !== c.pos.y;
    });
    if (parked.length < 2) return new Set();
    const pts = parked.map((c) => this.center(this.disp.get(c.id) ?? c.pos));
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const spread = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    const size = L.compact ? 12 : 13;
    const names = parked.map((c) => c.name);
    const h = size + 4;
    const w = names.join(' · ').length * size * 0.58 + 8;
    const r = spread + ts * 0.5;
    const cands: { x: number; y: number }[] = [];
    for (const d of [1, 1.8, 2.6]) {
      cands.push({ x: cx, y: cy + r * d + h }, { x: cx, y: cy - r * d - h }, { x: cx + r * d + w / 2, y: cy - h }, { x: cx - r * d - w / 2, y: cy - h });
    }
    for (const d of [3.4, 4.4]) cands.push({ x: cx + r * d + w / 2, y: cy }, { x: cx - r * d - w / 2, y: cy }, { x: cx, y: cy + r * d + h }, { x: cx, y: cy - r * d - h });
    const m = this.maskRect;
    const inView = (k: { x: number; y: number }) => k.x - w / 2 > m.x + 4 && k.x + w / 2 < m.x + m.w - 4 && k.y - h / 2 > m.y + 4 && k.y + h / 2 < m.y + m.h - 4;
    // Prefer a clear spot off the walls; if the dock is boxed in, accept a wall (the tag's knockout keeps it legible).
    const spot = cands.find((k) => inView(k) && !this.collides(k.x, k.y, w, h) && !this.labelOnWall(k.x, k.y, w)) ?? cands.find((k) => inView(k) && !this.collides(k.x, k.y, w, h));
    if (!spot) return new Set();
    // leader from the group to the tag, ending in a short shoulder under the text
    const ex = spot.x + (spot.x >= cx ? -w / 2 : w / 2);
    g.moveTo(cx, cy).lineTo(ex, spot.y + h / 2 - 1).lineTo(spot.x + (spot.x >= cx ? w / 2 : -w / 2), spot.y + h / 2 - 1);
    g.stroke({ width: 1, color: C.ink2, alpha: 0.8 });
    g.circle(cx, cy, 2.5).fill({ color: C.ink2 });
    // pinned: the selected robot's callout must not cover the only place these robots are named
    this.placed.push({ x: spot.x, y: spot.y, w, h, pin: true });
    this.label('rb-group', names.join(' · '), spot.x, spot.y, { size, weight: '700', spacing: 0.8 });
    return new Set(parked.map((c) => c.id));
  }

  private drawRobot(g: Graphics, c: CharacterView, selected: boolean, hover: boolean) {
    const L = this.L!;
    const ts = L.ts;
    const p = this.center(this.disp.get(c.id)!);
    const a = this.ang(c.heading);
    const half = ts * 0.32;
    const rot = (x: number, y: number) => ({ x: p.x + x * Math.cos(a) - y * Math.sin(a), y: p.y + x * Math.sin(a) + y * Math.cos(a) });
    // wheels
    for (const sy of [-1, 1]) {
      const w0 = rot(-half * 0.6, sy * (half + 2.5));
      const w1 = rot(half * 0.6, sy * (half + 2.5));
      g.moveTo(w0.x, w0.y).lineTo(w1.x, w1.y);
    }
    g.stroke({ width: Math.max(2.5, Math.min(5, ts * 0.09)), color: C.ink, cap: 'round' });
    // body: rounded square, rotated
    const corners: number[] = [];
    const r = half * 0.42;
    const steps = 5;
    const cornerC: [number, number, number][] = [
      [half - r, half - r, 0],
      [-(half - r), half - r, Math.PI / 2],
      [-(half - r), -(half - r), Math.PI],
      [half - r, -(half - r), (3 * Math.PI) / 2],
    ];
    for (const [cx, cy, a0] of cornerC)
      for (let i = 0; i <= steps; i++) {
        const t = a0 + (i / steps) * (Math.PI / 2);
        const q = rot(cx + Math.cos(t) * r, cy + Math.sin(t) * r);
        corners.push(q.x, q.y);
      }
    g.poly(corners).fill({ color: selected ? C.ink : C.sheet }).stroke({ width: selected ? 2.5 : 2.25, color: C.ink, join: 'round' });
    // sensor eye = heading mark
    const eye = rot(half * 0.48, 0);
    g.circle(eye.x, eye.y, Math.max(2.5, Math.min(7, ts * 0.085))).fill({ color: selected ? C.sheet : C.ink });
    const t0 = rot(half + 3, 0);
    const t1 = rot(half + 3 + ts * 0.16, 0);
    g.moveTo(t0.x, t0.y).lineTo(t1.x, t1.y).stroke({ width: 1.5, color: C.ink });
    // selection brackets
    if (selected || hover) {
      const b = half + 8;
      const k = 6;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        g.moveTo(p.x + sx * b, p.y + sy * (b - k)).lineTo(p.x + sx * b, p.y + sy * b).lineTo(p.x + sx * (b - k), p.y + sy * b);
      }
      g.stroke({ width: 1.5, color: C.ink, alpha: selected ? 1 : 0.6 });
    }
    // name + current verb (robots in the parked group are named by its shared tag)
    if (this.groupLabelled.has(c.id)) return;
    const verb = c.mind.asleep ? 'STANDBY' : c.action ? c.action.verb.toUpperCase() : 'IDLE';
    // Zoomed in, phones also get the current verb; at fit they show the name only.
    const txt = L.compact && ts < 30 ? c.name : `${c.name} · ${verb}`;
    const size = L.compact ? 12 : 13;
    const wEst = txt.length * size * 0.55 + 8;
    const gap = L.compact ? 11 : 14;
    // Try below, right, left, above; first spot clear of other labels and robots wins.
    const spots = [
      { x: p.x, y: p.y + half + gap },
      { x: p.x + half + 6 + wEst / 2, y: p.y },
      { x: p.x - half - 6 - wEst / 2, y: p.y },
      { x: p.x, y: p.y - half - gap },
      { x: p.x, y: p.y + half + gap + size + 4 },
      { x: p.x + half + 6 + wEst / 2, y: p.y + size + 4 },
    ];
    const h = size + 4;
    const onWall = (x: number, y: number) => {
      const t = this.toWorld(x, y);
      return this.store.world?.map.tiles[Math.floor(t.y) * L.W + Math.floor(t.x)] === 'wall';
    };
    const mr = this.mapRect;
    const clear = (s: { x: number; y: number }) =>
      s.x - wEst / 2 > Math.max(4, mr.x + 2) &&
      s.x + wEst / 2 < Math.min(L.w - 4, mr.x + mr.w - 2) &&
      s.y - h / 2 > Math.max(this.insets.top + 4, mr.y + 2) &&
      s.y + h / 2 < Math.min(L.h - this.insets.bottom - 4, mr.y + mr.h - 2) &&
      !this.collides(s.x, s.y, wEst, h) &&
      !this.robotPts.some((q) => q.id !== c.id && Math.abs(q.x - s.x) < wEst / 2 + half && Math.abs(q.y - s.y) < half + h / 2) &&
      !onWall(s.x - wEst / 2 + 2, s.y) &&
      !onWall(s.x, s.y) &&
      !onWall(s.x + wEst / 2 - 2, s.y);
    let spot = spots.find(clear);
    let leader = false;
    if (!spot) {
      // Leader-lined stack out to the side, like a drafter's tag.
      const dx = half + 34 + wEst / 2;
      for (let k = 0; k < 6 && !spot; k++) {
        for (const side of [1, -1]) {
          const cand = { x: p.x + side * dx, y: p.y - ts * 0.5 - 16 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (h + 2) };
          if (clear(cand)) {
            spot = cand;
            leader = true;
            break;
          }
        }
      }
    }
    // Still crowded at this zoom: hide rather than overprint; zooming in brings it back.
    if (!spot && !selected) return;
    spot ??= spots[0]!;
    if (leader) {
      const ex = spot.x - Math.sign(spot.x - p.x) * (wEst / 2 + 2);
      g.moveTo(p.x + Math.sign(spot.x - p.x) * half, p.y - half * 0.5).lineTo(ex, spot.y + h / 2 - 2).lineTo(spot.x + Math.sign(spot.x - p.x) * (wEst / 2), spot.y + h / 2 - 2);
      g.stroke({ width: 1, color: C.ink2, alpha: 0.8 });
    }
    this.placed.push({ x: spot.x, y: spot.y, w: wEst, h });
    this.label(`rb-${c.id}`, txt, spot.x, spot.y, { size, weight: '700', spacing: 0.8 });
  }

  private drawNoise(g: Graphics, n: NoiseEvent, now: number, reduced: boolean, world: WorldView) {
    const L = this.L!;
    const ts = L.ts;
    const durs = n.notes.map((x) => NoisePlayer.duration([x]));
    const chain = durs.reduce((a, b) => a + b, 0);
    const life = chain + 2.6;
    const e = (now - n.at) / 1000;
    if (e > life) return;
    const c = world.characters.find((x) => x.id === n.characterId);
    const p = this.center(c ? this.disp.get(c.id) ?? n.pos : n.pos);
    const heading = this.ang(c?.heading ?? 0);
    let t = 0;
    n.notes.forEach((_, i) => {
      const start = t;
      t += durs[i]!;
      if (e < start && !reduced) return;
      const age = Math.max(0, e - start);
      const radius = reduced ? ts * (0.75 + i * 0.38) : ts * (0.7 + Math.min(age, 1.4) * 1.5);
      const alpha = reduced ? 0.9 : Math.max(0, 1 - age / (life - start));
      for (const side of [0, Math.PI]) {
        const a0 = heading + side - 0.7;
        g.moveTo(p.x + Math.cos(a0) * radius, p.y + Math.sin(a0) * radius);
        g.arc(p.x, p.y, radius, a0, a0 + 1.4);
      }
      g.stroke({ width: 1.75, color: C.ink, alpha });
    });
    const fade = e > life - 0.6 ? Math.max(0, (life - e) / 0.6) : 1;
    // Note label on a short leader: above if clear, else further up, below or to a side.
    const txt = n.notes.join(' · ');
    const w = txt.length * 7 + 10;
    const up = ts * 0.6 + (L.compact ? 22 : 30);
    const cands = [
      { x: p.x, y: p.y - up },
      { x: p.x, y: p.y - up - 18 },
      { x: p.x, y: p.y + up },
      { x: p.x + w / 2 + ts * 0.8, y: p.y - up * 0.6 },
      { x: p.x - w / 2 - ts * 0.8, y: p.y - up * 0.6 },
    ];
    const spot = cands.find((s) => !this.collides(s.x, s.y, w, 16) && !this.robotPts.some((q) => Math.abs(q.x - s.x) < w / 2 + ts * 0.35 && Math.abs(q.y - s.y) < ts * 0.35 + 8)) ?? cands[0]!;
    this.placed.push({ x: spot.x, y: spot.y, w, h: 16 });
    this.label(`noise-${n.id}`, txt, spot.x, spot.y, { size: 13, weight: '600', color: C.ink, alpha: fade, spacing: 0.4 });
    const ey = spot.y > p.y ? spot.y - 8 : spot.y + 8;
    g.moveTo(p.x, p.y + Math.sign(spot.y - p.y) * ts * 0.45).lineTo(spot.x, ey).stroke({ width: 1, color: C.ink2, alpha: 0.6 * fade });
  }

  private drawAlerts(g: Graphics, c: CharacterView) {
    const L = this.L!;
    const ts = L.ts;
    const p = this.center(this.disp.get(c.id)!);
    const r = ts * 0.78;
    // The cloud carries the revision number of the feed row it refers to (latest fallback or refusal).
    const entry = this.store.alertEntry(c.id);
    const rev = entry ? this.store.rev(entry) : 0;
    const lit = !!entry && this.store.highlight === `${entry.tick}:${entry.characterId}`;
    cloud(g, p.x, p.y, r, 11);
    g.stroke({ width: lit ? 3.5 : 2, color: C.red, join: 'round' });
    const lines = c.alerts.map((a) => a.text);
    const tr = 8;
    const right = p.x + r + 10 + tr * 2 + 140 < L.w - 70;
    const sx = right ? 1 : -1;
    const nx = right ? p.x + r + 10 : p.x - r - 10 - tr * 2;
    const ny = p.y + r * 0.5;
    g.moveTo(p.x + sx * r * 0.75, p.y + r * 0.55).lineTo(right ? nx : nx + tr * 2, ny + 4).stroke({ width: 1.25, color: C.red });
    // revision delta
    const tri = [nx + tr, ny - tr * 0.5, nx + tr * 2, ny + tr * 1.3, nx, ny + tr * 1.3];
    if (lit) g.poly(tri).fill({ color: C.red });
    g.poly(tri).stroke({ width: 1.5, color: C.red });
    const tx = right ? nx + tr * 2 + 6 : nx - 6;
    let wMax = 0;
    lines.forEach((txt, i) => {
      const t = this.label(`alert-${c.id}-${i}`, i === 0 && rev ? `${rev} · ${txt}` : txt, tx, ny + 5 + i * 16, {
        size: 13,
        color: C.red,
        weight: '700',
        anchorX: right ? 0 : 1,
        spacing: 0.8,
      });
      wMax = Math.max(wMax, t.width);
    });
    if (entry) {
      const x = right ? nx - 4 : tx - wMax - 4;
      this.hotspots.push({ x, y: ny - tr, w: wMax + tr * 2 + 14, h: lines.length * 16 + tr + 6, key: `${entry.tick}:${entry.characterId}`, id: c.id });
    }
  }

  private drawCallout(g: Graphics, c: CharacterView): { x: number; y: number; w: number; h: number } {
    const L = this.L!;
    const ts = L.ts;
    const p = this.center(this.disp.get(c.id)!);
    const compact = L.compact;
    const bw = compact ? 178 : 196;
    const rowH = compact ? 18 : 17;
    // Battery and needs, then (iteration 2) sleep pressure and fog, which read worse as they rise.
    const gauges: [string, number, number, boolean][] = [
      ['BAT', c.mind.energy, 0.2, false],
      ['COOL', c.mind.needs['cool'] ?? 0, 0.25, false],
      ['SIG', c.mind.needs['signal'] ?? 0, 0.3, false],
      ['CUR', c.mind.needs['curiosity'] ?? 0, 0.3, false],
      ...(c.mind.sleepPressure !== undefined ? ([['SLEEP', c.mind.sleepPressure, 0.85, true]] as [string, number, number, boolean][]) : []),
      ...(c.mind.fog !== undefined ? ([['FOG', c.mind.fog, 0.8, true]] as [string, number, number, boolean][]) : []),
    ];
    const bh = (compact ? 10 : 14) + rowH * (gauges.length + 1) + (compact ? 0 : rowH);
    const off = ts * 1.1 + 10;
    const mr = this.mapRect;
    const options = [
      { x: p.x + off, y: p.y - off - bh },
      { x: p.x - off - bw, y: p.y - off - bh },
      { x: p.x + off, y: p.y + off },
      { x: p.x - off - bw, y: p.y + off },
      { x: p.x + off, y: p.y - bh / 2 },
      { x: p.x - off - bw, y: p.y - bh / 2 },
      { x: p.x - bw / 2, y: p.y - off - bh },
      { x: p.x - bw / 2, y: p.y + off },
      { x: p.x + off * 2, y: p.y - off * 2 - bh },
      { x: p.x - off * 2 - bw, y: p.y - off * 2 - bh },
      { x: p.x - off * 2 - bw, y: p.y + off * 2 },
      { x: p.x + off * 2, y: p.y + off * 2 },
    ];
    const inside = (o: { x: number; y: number }) => o.x >= 8 && o.y >= this.insets.top + 8 && o.x + bw <= L.w - 8 && o.y + bh <= L.h - this.insets.bottom - 4;
    // Prefer a spot on screen that covers the fewest labels (object names, other robots) and no buttons.
    const cost = (o: { x: number; y: number }) => {
      const r = { x: o.x, y: o.y, w: bw, h: bh };
      let n = inside(o) ? 0 : 100;
      for (const b of this.placed) if (overlap(r, { x: b.x - b.w / 2, y: b.y - (b.h ?? 14) / 2, w: b.w, h: b.h ?? 14 })) n += b.pin ? 60 : b.h === 14 ? 6 : 3;
      for (const q of this.robotPts) if (q.id !== c.id && q.x > r.x - 10 && q.x < r.x + bw + 10 && q.y > r.y - 10 && q.y < r.y + bh + 10) n += 4;
      for (const q of this.reserved) if (overlap(r, q)) n += 50;
      return n;
    };
    const ranked = options.map((o) => ({ o, n: cost(o) })).sort((a, b) => a.n - b.n);
    const box = ranked[0]!.n < 100 ? ranked[0]!.o : { x: Math.max(8, Math.min(L.w - bw - 8, p.x + off)), y: Math.max(mr.y, p.y - bh / 2) };
    // leader with a dot at the robot
    const corner = { x: box.x < p.x ? box.x + bw : box.x, y: box.y < p.y ? box.y + bh : box.y };
    const start = { x: p.x + Math.sign(corner.x - p.x) * ts * 0.45, y: p.y + Math.sign(corner.y - p.y) * ts * 0.45 };
    g.circle(start.x, start.y, 2.5).fill({ color: C.ink });
    g.moveTo(start.x, start.y).lineTo(corner.x, corner.y).stroke({ width: 1.25, color: C.ink });
    g.rect(box.x, box.y, bw, bh).fill({ color: C.sheet, alpha: 0.94 }).stroke({ width: 1.5, color: C.ink });
    const padX = 8;
    let y = box.y + (compact ? 6 : 8) + rowH / 2;
    this.label('co-title', `${c.name} · ${c.mind.mood.toUpperCase()}`, box.x + padX, y, { size: 13, weight: '700', anchorX: 0, bg: false, spacing: 0.8, top: true });
    y += rowH;
    // Label column, tick strip and value column with clear gutters (COOL and 100% never touch the ticks).
    const gx = box.x + padX + (compact ? 46 : 44);
    const gw = bw - padX * 2 - (compact ? 46 : 44) - (compact ? 44 : 40);
    for (const [name, v, low, high] of gauges) {
      const red = high ? v >= low : v < low;
      const col = red ? C.red : C.ink;
      this.label(`co-g-${name}`, name, box.x + padX, y, { size: 12, weight: '600', anchorX: 0, bg: false, color: red ? C.red : C.ink2, top: true });
      const n = 10;
      const filled = Math.round(v * n);
      for (let i = 0; i < n; i++) {
        const x = gx + (i + 0.5) * (gw / n);
        const hgt = i < filled ? rowH * 0.62 : rowH * 0.24;
        g.moveTo(x, y + rowH * 0.3).lineTo(x, y + rowH * 0.3 - hgt);
      }
      g.stroke({ width: compact ? 2 : 2.5, color: col, alpha: 1 });
      g.moveTo(gx, y + rowH * 0.3 + 1).lineTo(gx + gw, y + rowH * 0.3 + 1).stroke({ width: 1, color: C.ink2, alpha: 0.7 });
      this.label(`co-v-${name}`, `${Math.round(v * 100)}%`, box.x + bw - padX, y, { size: 12, weight: '600', anchorX: 1, bg: false, color: col, top: true });
      y += rowH;
    }
    if (!compact) {
      const work = c.mind.sleepWork;
      const a = c.mind.asleep
        ? work
          ? `ASLEEP · ${SLEEP_STEP_TAG[work.step]}${work.step === 'consolidating' && work.total ? ` ${work.done ?? 0}/${work.total}` : ''}`
          : 'STANDBY · DOCKED'
        : c.action ? `${c.action.verb.toUpperCase()}${c.action.targetId ? ` · ${this.store.nameOf(c.action.targetId).toUpperCase()}` : ''}` : 'IDLE';
      g.moveTo(box.x, y - rowH * 0.25).lineTo(box.x + bw, y - rowH * 0.25).stroke({ width: 1, color: C.ink2, alpha: 0.6 });
      this.label('co-action', a, box.x + padX, y + 3, { size: 12, weight: '700', anchorX: 0, bg: false, spacing: 0.6, top: true });
    }
    return { x: box.x, y: box.y, w: bw, h: bh };
  }
}

/* ------------------------------------------------------------ helpers */

const SLEEP_STEP_TAG: Record<string, string> = { consolidating: 'MEMORIES', habits: 'HABITS', sheet: 'SHEET', refine: 'REVIEW', done: 'RESTING' };

function colName(i: number) {
  return String.fromCharCode(65 + i);
}

function dash(g: Graphics, x1: number, y1: number, x2: number, y2: number, on: number, off: number) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.5) return;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  for (let s = 0; s < len; s += on + off) {
    const e = Math.min(len, s + on);
    g.moveTo(x1 + ux * s, y1 + uy * s).lineTo(x1 + ux * e, y1 + uy * e);
  }
}

function dashCircle(g: Graphics, cx: number, cy: number, r: number, on: number, off: number) {
  const circ = 2 * Math.PI * r;
  const n = Math.max(8, Math.floor(circ / (on + off)));
  const step = (Math.PI * 2) / n;
  const arcOn = step * (on / (on + off));
  for (let i = 0; i < n; i++) {
    const a = i * step;
    g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    g.arc(cx, cy, r, a, a + arcOn);
  }
}

/** Revision cloud: scallops around a circle. */
function cloud(g: Graphics, cx: number, cy: number, r: number, n: number) {
  const s = r * Math.sin(Math.PI / n) * 1.08;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const sx = cx + Math.cos(a) * r;
    const sy = cy + Math.sin(a) * r;
    g.moveTo(sx + Math.cos(a - Math.PI / 2) * s, sy + Math.sin(a - Math.PI / 2) * s);
    g.arc(sx, sy, s, a - Math.PI / 2, a + Math.PI / 2);
  }
}


/**
 * Turns the server's snapshot `state` and its deltas into the viewer's view model. Everything
 * the plan draws (map, labels, verbs, ranges, thresholds) comes from the snapshot and the
 * world's catalog; nothing about the world is hard-coded here.
 */
import type { Character, WorldObject } from '@uas/client';
import type {
  Alert,
  CharacterView,
  Delta,
  ObjectView,
  TileKind,
  Vec2,
  WorldCatalog,
  WorldMap,
  WorldStateView,
  WorldView,
} from '../types.ts';

/** 'solarPad' → 'Solar pad'. Packs carry no display names, so labels derive from the type. */
export function labelOf(type: string): string {
  const words = type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function verbsOf(cat: WorldCatalog | null, type: string): string[] {
  return cat?.objects.find((o) => o.type === type)?.verbs ?? [];
}

export function archetypeOf(cat: WorldCatalog | null, type: string) {
  return cat?.archetypes.find((a) => a.type === type);
}

/** Need gauges for a character type: battery first, then the archetype's needs in pack order. */
export function gaugesFor(cat: WorldCatalog | null, type: string): { key: string; label: string; low: number; critical?: number }[] {
  const arch = archetypeOf(cat, type);
  const battery = { key: 'energy', label: labelOf(arch?.energy.label ?? 'battery'), low: cat?.energyFloor ?? 0.1 };
  const needs = Object.entries(arch?.needs ?? {}).map(([key, n]) => ({ key, label: labelOf(key), low: n.low ?? 0, ...(n.critical !== undefined && { critical: n.critical }) }));
  return [battery, ...needs];
}

/** Grid terrain key → what the plan draws. The pack's documented keys first, then properties. */
function tileKind(key: string, t: { walkable: boolean; blocksSight: boolean } | undefined): TileKind {
  if (key === '#') return 'wall';
  if (key === '~') return 'water';
  if (key === '*') return 'rock';
  if (key === ':') return 'path';
  if (!t || t.walkable) return 'floor';
  return t.blocksSight ? 'wall' : 'water';
}

export function mapOf(state: WorldStateView): WorldMap {
  const g = state.config.grid;
  return { width: g.width, height: g.height, tiles: g.tiles.map((k) => tileKind(k, g.terrain[k])) };
}

function objectView(e: WorldObject): ObjectView {
  return { id: e.id, kind: 'object', type: e.type, pos: { ...e.pos }, state: { ...e.state }, ...(e.heldBy && { heldBy: e.heldBy }) };
}

function characterView(e: Character, cat: WorldCatalog | null): CharacterView {
  const arch = archetypeOf(cat, e.type);
  const m = e.mind;
  const c: CharacterView = {
    id: e.id,
    kind: 'character',
    type: e.type,
    // Display name from the entity (`state.name`); visitors get a short tag rather than their long id.
    name: (e.state['visitor'] === true && !e.state['name'] ? `Visitor ${e.id.slice(-4)}` : String(e.state['name'] ?? e.id)).toUpperCase(),
    pos: { ...e.pos },
    heading: 0,
    mind: {
      energy: e.energy,
      needs: { ...e.needs },
      valence: m?.mood.valence ?? 0,
      arousal: m?.mood.arousal ?? 0,
      mood: m?.mood.word ?? '',
      asleep: m?.sleep === 'asleep',
    },
    action: e.current ? { verb: e.current.action.verb, ...(e.current.action.targetId && { targetId: e.current.action.targetId }), reason: e.current.action.reason, startedTick: e.current.startedTick } : null,
    beliefs: m?.beliefs ? m.beliefs.map((b) => ({ ...b })) : [],
    alerts: [],
    trail: [],
    sightRange: arch?.sightRange ?? 6,
    hearingRange: arch?.hearingRange ?? 8,
    visitor: e.state['visitor'] === true,
  };
  c.alerts = needAlerts(c, cat, 0);
  return c;
}

export function viewFromState(state: WorldStateView, cat: WorldCatalog | null, ticksPerSecond: number): WorldView {
  const objects: ObjectView[] = [];
  const characters: CharacterView[] = [];
  for (const e of Object.values(state.entities).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (e.kind === 'object') objects.push(objectView(e));
    else characters.push(characterView(e as Character, cat));
  }
  return {
    worldId: state.config.worldId,
    name: cat?.name || state.config.worldId,
    packs: cat?.packs ?? state.packVersions.split(',').map((p) => p.split('#')[0]!),
    clock: {
      tick: state.tick,
      ticksPerSecond,
      secondsPerTick: state.config.secondsPerTick,
      dayLengthSeconds: state.config.dayLengthSeconds,
      startSecond: state.config.startSecond,
    },
    map: mapOf(state),
    objects,
    characters,
    spendTodayAud: 0,
    capAud: cat?.dailyCapAud ?? null,
  };
}

const REJECT_ALERT_TICKS = 240;

/** Red-pen alerts from levels: battery under the energy floor, a need under its critical level. */
function needAlerts(c: CharacterView, cat: WorldCatalog | null, tick: number): Alert[] {
  const out: Alert[] = [];
  for (const g of gaugesFor(cat, c.type)) {
    const v = g.key === 'energy' ? c.mind.energy : c.mind.needs[g.key];
    if (v === undefined) continue;
    if (g.key === 'energy' && v < g.low) out.push({ kind: 'energy-low', text: `${g.label.toUpperCase()} ${Math.round(v * 100)}%`, tick });
    else if (g.critical !== undefined && v < g.critical) out.push({ kind: 'need-critical', text: `${g.label.toUpperCase()} CRITICAL`, tick });
  }
  return out;
}

function refreshAlerts(c: CharacterView, cat: WorldCatalog | null, tick: number) {
  const rejected = c.alerts.filter((a) => a.kind === 'action-rejected' && tick - a.tick < REJECT_ALERT_TICKS);
  c.alerts = [...needAlerts(c, cat, tick), ...rejected];
}

export interface DeltaEffects {
  noises: { id: string; notes: string[]; pos: Vec2 }[];
  beliefsChanged: string[];
}

/** Apply one tick of real deltas to the view, in place. */
export function applyDeltas(w: WorldView, tick: number, changes: Delta[], cat: WorldCatalog | null): DeltaEffects {
  const fx: DeltaEffects = { noises: [], beliefsChanged: [] };
  w.clock.tick = tick;
  const ch = (id: string) => w.characters.find((x) => x.id === id);
  const ob = (id: string) => w.objects.find((x) => x.id === id);
  for (const d of changes) {
    switch (d.kind) {
      case 'spawned': {
        const e = d.entity;
        if (e.kind === 'object') w.objects.push(objectView(e));
        else w.characters.push(characterView(e as Character, cat));
        break;
      }
      case 'despawned':
        w.objects = w.objects.filter((o) => o.id !== d.id);
        w.characters = w.characters.filter((c) => c.id !== d.id);
        break;
      case 'moved': {
        const c = ch(d.id);
        if (c) {
          const dx = d.to.x - d.from.x;
          const dy = d.to.y - d.from.y;
          if (dx || dy) c.heading = Math.atan2(dy, dx);
          c.pos = { ...d.to };
          const last = c.trail[c.trail.length - 1];
          if (!last || last.x !== d.to.x || last.y !== d.to.y) {
            c.trail.push({ ...d.to });
            if (c.trail.length > 48) c.trail.shift();
          }
        } else {
          const o = ob(d.id);
          if (o) o.pos = { ...d.to };
        }
        break;
      }
      case 'state': {
        const o = ob(d.id) ?? ch(d.id);
        if (o && 'state' in o) Object.assign(o.state, d.set);
        break;
      }
      case 'held': {
        const o = ob(d.id);
        if (o) {
          if (d.heldBy) o.heldBy = d.heldBy;
          else delete o.heldBy;
        }
        break;
      }
      case 'needs': {
        const c = ch(d.id);
        if (!c) break;
        for (const [k, v] of Object.entries(d.values)) {
          if (k === 'energy') c.mind.energy = v;
          else c.mind.needs[k] = v;
        }
        refreshAlerts(c, cat, tick);
        break;
      }
      case 'mood': {
        const c = ch(d.id);
        if (c) Object.assign(c.mind, { valence: d.valence, arousal: d.arousal, mood: d.word });
        break;
      }
      case 'sleep': {
        const c = ch(d.id);
        if (c) c.mind.asleep = d.phase === 'asleep';
        break;
      }
      case 'action': {
        const c = ch(d.id);
        if (!c) break;
        if (d.status === 'started') {
          c.action = { verb: d.action.verb, ...(d.action.targetId && { targetId: d.action.targetId }), reason: d.action.reason, startedTick: tick };
        } else if (d.status !== 'queued' && c.action?.verb === d.action.verb) {
          c.action = null;
        }
        if (d.status === 'rejected' || d.status === 'failed') {
          const why = d.reason ?? d.observation ?? d.status;
          c.alerts = [...c.alerts.filter((a) => a.kind !== 'action-rejected'), { kind: 'action-rejected', text: `${d.status.toUpperCase()}: ${d.action.verb} — ${why}`.toUpperCase().slice(0, 48), tick }];
        }
        break;
      }
      case 'vocalize':
        fx.noises.push({ id: d.id, notes: d.notes, pos: { ...d.pos } });
        break;
      case 'beliefs': {
        const c = ch(d.id);
        if (c) c.beliefs = d.beliefs.map((b) => ({ ...b }));
        fx.beliefsChanged.push(d.id);
        break;
      }
      default:
        break;
    }
  }
  // Expire old refusal notes even when nothing else about the robot changed.
  for (const c of w.characters) if (c.alerts.some((a) => a.kind === 'action-rejected' && tick - a.tick >= REJECT_ALERT_TICKS)) refreshAlerts(c, cat, tick);
  return fx;
}

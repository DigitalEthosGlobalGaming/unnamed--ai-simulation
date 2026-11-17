/**
 * SIMULATED DATA. A small deterministic stand-in for the real sim + mind +
 * model gateway, so the viewer has believable deltas and brain-feed entries
 * before the API (M7) exists. It is not the real brain: it fakes tiers,
 * models, costs and learning with simple utility rules and a seeded RNG.
 * Replace with `@uas/client` (snapshot + deltas + feed over WebSocket).
 */
import type {
  Alert,
  Belief,
  Change,
  CharacterView,
  CurrentAction,
  Entity,
  FeedAction,
  FeedEntry,
  MindView,
  NeedKey,
  Tier,
  TriggerKind,
  Usage,
  Vec2,
  WorldMap,
} from './types.ts';
import { next, pick, range, seedRng, type RngState } from './rng.ts';
import { emptyMap, sampleMap, sampleObjects, terrainAt } from './map.ts';

export const TICKS_PER_SECOND = 10;
export const SECONDS_PER_TICK = 6; // one in-world minute per real second at 1×
export const TICKS_PER_HOUR = 3600 / SECONDS_PER_TICK; // 600
export const TICKS_PER_DAY = TICKS_PER_HOUR * 24; // 14,400
const ENERGY_PER_AUD = 1.6;
const MOVE_PER_TICK = 0.25;
const TRAIL_LEN = 48;

type Phase = 'moving' | 'doing';

interface ActiveAction {
  verb: string;
  targetId?: string;
  reason: string;
  startedTick: number;
  phase: Phase;
  remaining: number;
  notes?: string[];
  feedTick: number;
  feedIdx: number;
}

interface PlannedAction {
  verb: string;
  targetId?: string;
  reason: string;
  notes?: string[];
  feedIdx: number;
}

interface Experience {
  good: number;
  bad: number;
  days: number[];
}

export interface RobotState {
  id: string;
  name: string;
  pos: Vec2;
  heading: number;
  path: Vec2[];
  energy: number;
  needs: Record<NeedKey, number>;
  valence: number;
  arousal: number;
  asleep: boolean;
  drainMul: number;
  chargeMul: number;
  current: ActiveAction | null;
  queue: PlannedAction[];
  feedTick: number;
  pending: TriggerKind | null;
  heard: { notes: string[]; from: string } | null;
  beliefs: Belief[];
  experience: Record<string, Experience>;
  boredom: Record<string, number>;
  alerts: Alert[];
  trail: Vec2[];
  reflectedDay: number;
  idleTicks: number;
  lastChainTick: number;
  lastNightFail: number;
}

export interface SimState {
  worldId: string;
  name: string;
  tick: number;
  map: WorldMap;
  objects: Entity[];
  robots: RobotState[];
  rng: { move: RngState; effects: RngState; brain: RngState };
  spendTodayAud: number;
  spendDay: number;
}

export interface StepOutput {
  tick: number;
  changes: Change[];
  feed: FeedEntry[];
  statusUpdates: { tick: number; characterId: string; idx: number; status: FeedAction['status'] }[];
}

export type Scenario = 'default' | 'lowbattery' | 'empty';

export function createSim(seed: number, scenario: Scenario): SimState {
  const map = scenario === 'empty' ? emptyMap() : sampleMap();
  const objects = scenario === 'empty' ? [] : sampleObjects();
  const mk = (id: string, name: string, x: number, y: number, drainMul: number): RobotState => ({
    id,
    name,
    pos: { x, y },
    heading: 0,
    path: [],
    energy: 0.62,
    needs: { cool: 0.8, signal: 0.6, curiosity: 0.5 },
    valence: 0.2,
    arousal: 0.4,
    asleep: true,
    drainMul,
    chargeMul: drainMul > 2 ? 0.4 : 1,
    current: null,
    queue: [],
    feedTick: -1,
    pending: 'woke-up',
    heard: null,
    beliefs: [],
    experience: {},
    boredom: {},
    alerts: [],
    trail: [],
    reflectedDay: 0,
    idleTicks: 0,
    lastChainTick: -1000,
    lastNightFail: -100000,
  });
  const robots =
    scenario === 'empty'
      ? []
      : [
          mk('rb-01', 'RB-01', 3, 3, 1.0),
          mk('rb-02', 'RB-02', 5, 2, 1.25),
          mk('rb-03', 'RB-03', 4, 4, scenario === 'lowbattery' ? 2.2 : 1.6),
        ];
  return {
    worldId: 'garden-01',
    name: 'Garden 01',
    tick: 0,
    map,
    objects,
    robots,
    rng: { move: seedRng(seed), effects: seedRng(seed + 1), brain: seedRng(seed + 2) },
    spendTodayAud: 0,
    spendDay: 1,
  };
}

/* ------------------------------------------------------------------ clock */

export function dayOf(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY) + 1;
}
export function hourOf(tick: number): number {
  return ((tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24;
}
export function isDaylight(tick: number): boolean {
  const h = hourOf(tick);
  return h >= 6 && h < 18.5;
}

/* ------------------------------------------------------------- geometry */

const tileOf = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function blocked(s: SimState, x: number, y: number): boolean {
  if (!terrainAt(s.map, x, y).walkable) return true;
  return s.objects.some((o) => o.type !== 'ball' && o.pos.x === x && o.pos.y === y);
}

/** BFS on 4-neighbour tiles. The grid is tiny, so A* buys nothing here. */
function findPath(s: SimState, from: Vec2, to: Vec2): Vec2[] | null {
  const w = s.map.width;
  const h = s.map.height;
  const start = tileOf(from);
  const key = (x: number, y: number) => y * w + x;
  const prev = new Int32Array(w * h).fill(-1);
  const seen = new Uint8Array(w * h);
  const q: number[] = [key(start.x, start.y)];
  seen[q[0]!] = 1;
  const goal = key(to.x, to.y);
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi]!;
    if (cur === goal) {
      const out: Vec2[] = [];
      let c = cur;
      while (c !== key(start.x, start.y)) {
        out.push({ x: c % w, y: Math.floor(c / w) });
        c = prev[c]!;
      }
      return out.reverse();
    }
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const k = key(nx, ny);
      if (seen[k] || blocked(s, nx, ny)) continue;
      seen[k] = 1;
      prev[k] = cur;
      q.push(k);
    }
  }
  return null;
}

/** Nearest walkable tile next to an object, preferring the actor's side. */
function standTile(s: SimState, _r: RobotState, target: Vec2, slot = 0): Vec2 | null {
  const options: Vec2[] = [];
  for (const [dx, dy] of [
    [0, 1],
    [1, 0],
    [-1, 0],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ] as const) {
    const x = target.x + dx;
    const y = target.y + dy;
    if (!blocked(s, x, y)) options.push({ x, y });
  }
  if (options.length === 0) return null;
  // Prefer the south side: fixture labels are drawn north of the symbol.
  return options[Math.min(slot, options.length - 1)]!;
}

/* ------------------------------------------------------------------ mind */

function moodWord(v: number, a: number): string {
  if (v > 0.35) return a > 0.55 ? 'excited' : 'content';
  if (v > -0.1) return a > 0.55 ? 'alert' : 'calm';
  if (v > -0.45) return a > 0.55 ? 'restless' : 'dull';
  return a > 0.55 ? 'agitated' : 'low';
}

function mindOf(r: RobotState): MindView {
  return {
    energy: round3(r.energy),
    needs: { cool: round3(r.needs.cool), signal: round3(r.needs.signal), curiosity: round3(r.needs.curiosity) },
    valence: round3(r.valence),
    arousal: round3(r.arousal),
    mood: moodWord(r.valence, r.arousal),
    asleep: r.asleep,
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function obj(s: SimState, type: string): Entity | undefined {
  return s.objects.find((o) => o.type === type);
}

function recentlyFailed(r: RobotState, tick: number): boolean {
  const e = r.experience['charge:solarPad:night'];
  return !!e && e.bad > 0 && r.lastNightFail > tick - TICKS_PER_HOUR * 8;
}

function believes(r: RobotState, key: string): Belief | undefined {
  return r.beliefs.find((b) => b.key === key);
}

function record(r: RobotState, key: string, good: boolean, day: number) {
  const e = (r.experience[key] ??= { good: 0, bad: 0, days: [] });
  if (good) e.good++;
  else e.bad++;
  if (!e.days.includes(day)) e.days.push(day);
}

/* -------------------------------------------------------------- noises */

const NOISES = ['beep', 'chirp', 'trill', 'buzz'] as const;
const PITCHES = ['C', 'D', 'E', 'G'] as const;

function chainFor(s: SimState, r: RobotState, mood: 'greet' | 'reply' | 'complain' | 'happy'): string[] {
  const rng = s.rng.brain;
  if (mood === 'complain') return ['buzz-C', pick(rng, ['buzz-C', 'buzz-D'])];
  if (mood === 'happy') return [`trill-${pick(rng, PITCHES)}`, `chirp-${pick(rng, ['E', 'G'] as const)}`];
  if (mood === 'reply' && r.heard) {
    const echo = r.heard.notes.slice(0, 2);
    return [...echo, `chirp-${pick(rng, PITCHES)}`].slice(0, 4);
  }
  const len = 1 + Math.floor(next(rng) * 3);
  const out: string[] = ['beep-C'];
  for (let i = 1; i < len; i++) out.push(`${pick(rng, NOISES.slice(0, 3))}-${pick(rng, PITCHES)}`);
  return out;
}

/* ---------------------------------------------------------- the "brain" */

interface Candidate {
  verb: string;
  target?: Entity | RobotState;
  score: number;
  key: string;
  reason: string;
  notes?: string[];
}

const MODELS = {
  decision: 'jev-1.13',
  localDm: 'tev1:0.8b',
  local: 'llama3.2:1b',
  small: 'claude-haiku-5-5',
  big: 'claude-sonnet-5-5',
};

function usageFor(s: SimState, tier: Tier, modelId: string): Usage | undefined {
  const rng = s.rng.brain;
  if (tier === 'autopilot' || tier === 'carry-on' || tier === 'fallback') return undefined;
  const big = modelId === MODELS.big;
  const inputTokens = Math.round(tier === 'llm' ? range(rng, 2400, 4200) : range(rng, 600, 1400));
  const cachedInputTokens = Math.round(inputTokens * range(rng, 0.55, 0.85));
  const outputTokens = Math.round(tier === 'llm' ? range(rng, 180, 520) : range(rng, 4, 24));
  let costAud: number;
  if (tier === 'local') costAud = 0.00002 + inputTokens * 0.00000002;
  else if (tier === 'decision') costAud = 0.00018 + (inputTokens - cachedInputTokens) * 0.0000006 + outputTokens * 0.000004;
  else costAud = (big ? 0.0046 : 0.0012) * (1 + (inputTokens - cachedInputTokens) / 1500) + outputTokens * (big ? 0.000023 : 0.0000077);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costAud: Math.round(costAud * 100000) / 100000,
    latencyMs: Math.round(tier === 'local' ? range(rng, 380, 1400) : tier === 'decision' ? range(rng, 90, 420) : range(rng, 1400, 5200)),
    modelId,
  };
}

function candidates(s: SimState, r: RobotState): Candidate[] {
  const out: Candidate[] = [];
  const day = isDaylight(s.tick);
  const rng = s.rng.brain;
  const bored = (k: string) => clamp01(r.boredom[k] ?? 0);
  const solar = obj(s, 'solarPad');
  const dock = obj(s, 'dock');
  const fountain = obj(s, 'fountain');
  const ball = obj(s, 'ball');
  const piano = obj(s, 'piano');
  const lowBat = 1 - r.energy;

  if (solar) {
    const b = believes(r, 'charge:solarPad');
    const knowsNight = b?.text.includes('light');
    let score = (r.energy < 0.6 ? lowBat * 2.1 : lowBat * 0.5) + (r.energy < 0.35 ? 0.9 : 0);
    if (!day && knowsNight) score *= 0.05; // learned: the pad is dark at night
    else if (!day && recentlyFailed(r, s.tick)) score *= 0.2; // short-term: the pad was dark just now
    else if (!day && r.energy < 0.85) score += 2.2; // has not learned that yet
    if (!b) score = lowBat * 1.4 + 0.15; // curious, untested
    out.push({
      verb: 'charge',
      target: solar,
      score,
      key: 'charge:solarPad',
      reason: !b
        ? 'the flat square hums; maybe it does something for me'
        : r.energy < 0.3
          ? 'battery feels thin, the pad helped before'
          : 'topping up while the pad is warm',
    });
  }
  if (dock) {
    const night = !day ? 1.4 : 0;
    out.push({
      verb: 'rest',
      target: dock,
      score: (1 - r.needs.cool) * 1.3 + lowBat * (day ? 0.3 : 1.1) + night,
      key: 'rest:dock',
      reason: !day ? 'it is dark; the dock is where I settle' : 'running warm, the dock cools me',
    });
  }
  if (fountain) {
    out.push({
      verb: 'rinse',
      target: fountain,
      score: (1 - r.needs.cool) * 1.5 * (1 - bored('rinse:fountain') * 0.5),
      key: 'rinse:fountain',
      reason: 'my casing is hot; the water was cold last time',
    });
    out.push({
      verb: 'splash',
      target: fountain,
      score: (1 - r.needs.curiosity) * 1.6 * (1 - bored('splash:fountain')) - (r.energy < 0.3 ? 0.6 : 0),
      key: 'splash:fountain',
      reason: bored('splash:fountain') > 0.5 ? 'splashing again, though it is getting dull' : 'splashing was fun',
    });
  }
  if (ball) {
    out.push({
      verb: pick(rng, ['chase', 'push'] as const),
      target: ball,
      score: (1 - r.needs.curiosity) * 1.4 * (1 - bored('chase:ball')),
      key: 'chase:ball',
      reason: 'the ball moves when I nudge it',
    });
  }
  if (piano) {
    out.push({
      verb: 'play',
      target: piano,
      score: (1 - r.needs.curiosity) * 1.3 * (1 - bored('play:piano')) + (believes(r, 'play:piano') ? 0 : 0.25),
      key: 'play:piano',
      reason: believes(r, 'play:piano') ? 'the piano makes sounds I have not heard' : 'the long box has many keys',
    });
  }
  for (const other of s.robots) {
    if (other.id === r.id || other.asleep) continue;
    out.push({
      verb: 'vocalize',
      target: other,
      score: (1 - r.needs.signal) * 1.6 + (r.heard?.from === other.id ? 0.8 : 0) - dist(r.pos, other.pos) * 0.03,
      key: 'vocalize:robot',
      reason: r.heard?.from === other.id ? `${other.name} called; answering` : `quiet out here; calling ${other.name}`,
      notes: chainFor(s, r, r.heard?.from === other.id ? 'reply' : 'greet'),
    });
  }
  out.push({ verb: 'scan', target: pick(rng, s.objects), score: 0.25 + (1 - r.needs.curiosity) * 0.2, key: 'scan', reason: 'looking around' });
  for (const c of out) c.score += range(rng, -0.12, 0.12);
  return out.sort((a, b) => b.score - a.score);
}

function decide(s: SimState, r: RobotState, trigger: TriggerKind, out: StepOutput) {
  const rng = s.rng.brain;
  const list = candidates(s, r);
  if (list.length === 0) return;
  const top = list[0]!;
  const margin = top.score - (list[1]?.score ?? 0);

  // Tier routing, mimicking the spec: autopilot for routine + believed,
  // local below the energy floor, decision model mostly, LLM on low confidence.
  let tier: Tier;
  let modelId: string | undefined;
  let confidence: number | undefined;
  let fallback = false;
  const known = !!believes(r, top.key);
  if (r.energy < 0.15) {
    if (next(rng) < 0.3) {
      tier = 'fallback';
      fallback = true;
    } else if (known && next(rng) < 0.5) tier = 'autopilot';
    else {
      tier = 'local';
      modelId = MODELS.localDm;
      confidence = round3(range(rng, 0.45, 0.75));
    }
  } else if (known && margin > 0.25 && trigger !== 'heard-noise' && next(rng) < 0.75) {
    tier = 'autopilot';
  } else {
    confidence = round3(range(rng, 0.5, 0.97));
    if (confidence < 0.545 && r.energy > 0.45) {
      tier = 'llm';
      modelId = MODELS.small;
      confidence = round3(range(rng, 0.7, 0.9));
    } else if (next(rng) < 0.08) {
      tier = 'local';
      modelId = MODELS.localDm;
    } else {
      tier = 'decision';
      modelId = MODELS.decision;
    }
  }

  const plan: Candidate[] = [top];
  if (r.energy < 0.2 && !r.asleep && next(rng) < 0.5) {
    plan.unshift({ verb: 'vocalize', score: 0, key: 'vocalize:self', reason: 'complaining about the battery', notes: chainFor(s, r, 'complain') });
  } else if ((top.key === 'play:piano' || top.key === 'chase:ball') && next(rng) < 0.4) {
    plan.push({ verb: 'vocalize', score: 0, key: 'vocalize:self', reason: 'that felt good', notes: chainFor(s, r, 'happy') });
  }

  const usage = modelId ? usageFor(s, tier, modelId) : undefined;
  const energyCost = usage ? round3(usage.costAud * ENERGY_PER_AUD * 10) / 10 : undefined;
  if (usage) {
    r.energy = clamp01(r.energy - (energyCost ?? 0));
    addSpend(s, usage.costAud, out);
  }

  const reasonFor = (c: Candidate) => {
    if (fallback) return `${c.reason} (model timed out; autopilot took over)`;
    if (tier === 'llm') return `${c.reason} (unsure, asked for a plan)`;
    return c.reason;
  };

  const entry: FeedEntry = {
    tick: s.tick,
    characterId: r.id,
    trigger,
    tier,
    ...(modelId ? { modelId } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    actions: plan.map((c) => ({ verb: c.verb, ...(c.target ? { targetId: c.target.id } : {}), reason: reasonFor(c), status: 'queued' as const })),
    ...(usage ? { usage, energyCost } : {}),
    ...(plan.some((c) => c.notes) ? { notes: plan.flatMap((c) => c.notes ?? []) } : {}),
  };
  out.feed.push(entry);
  r.feedTick = s.tick;
  r.queue = plan.map((c, i) => ({
    verb: c.verb,
    ...(c.target ? { targetId: c.target.id } : {}),
    reason: c.reason,
    ...(c.notes ? { notes: c.notes } : {}),
    feedIdx: i,
  }));
  r.heard = null;
}

function reflect(s: SimState, r: RobotState, out: StepOutput) {
  const rng = s.rng.brain;
  const day = dayOf(s.tick);
  const modelId = r.energy < 0.3 ? MODELS.small : MODELS.big;
  const usage = usageFor(s, 'llm', modelId)!;
  const energyCost = round3(usage.costAud * ENERGY_PER_AUD * 10) / 10;
  r.energy = clamp01(r.energy - energyCost);
  addSpend(s, usage.costAud, out);

  const formed: string[] = [];
  const upsert = (key: string, text: string, deltas: Record<string, number>, valence: number, support: number) => {
    const existing = believes(r, key);
    if (existing) {
      const changed = existing.text !== text;
      if (existing.text !== text) existing.revisedTick = s.tick;
      existing.text = text;
      existing.support = support;
      existing.firmness = round3(clamp01(existing.firmness + (changed ? -0.1 : 0.12)));
      existing.lastSupportedDay = day;
      existing.expectedNeedDeltas = deltas;
      out.changes.push({ kind: 'belief', id: r.id, belief: { ...existing } });
      if (changed) formed.push(`revised ${key}`);
    } else {
      const b: Belief = { key, text, expectedNeedDeltas: deltas, expectedValence: valence, support, firmness: round3(range(rng, 0.35, 0.5)), lastSupportedDay: day, formedTick: s.tick };
      r.beliefs.push(b);
      out.changes.push({ kind: 'belief', id: r.id, belief: { ...b } });
      formed.push(`new ${key}`);
    }
  };
  const e = (k: string) => r.experience[k];
  const dayCharge = e('charge:solarPad:day');
  const nightCharge = e('charge:solarPad:night');
  if (dayCharge && dayCharge.good > 0) {
    if (nightCharge && nightCharge.bad > 0)
      upsert('charge:solarPad', 'The solar pad fills my battery, but only while it is light. At night it does nothing.', { energy: 0.3 }, 0.4, dayCharge.good + nightCharge.bad);
    else upsert('charge:solarPad', 'Sitting on the solar pad fills my battery.', { energy: 0.3 }, 0.4, dayCharge.good);
  } else if (nightCharge && nightCharge.bad > 1) {
    upsert('charge:solarPad', 'The solar pad did nothing for me.', { energy: 0 }, -0.2, nightCharge.bad);
  }
  if (e('rest:dock')?.good) upsert('rest:dock', 'Resting in the dock cools me down and trickles a little charge.', { cool: 0.2, energy: 0.03 }, 0.2, e('rest:dock')!.good);
  if (e('rinse:fountain')?.good) upsert('rinse:fountain', 'Rinsing at the fountain cools my casing.', { cool: 0.25 }, 0.2, e('rinse:fountain')!.good);
  const sp = e('splash:fountain');
  if (sp && sp.good + sp.bad > 1)
    upsert(
      'splash:fountain',
      sp.bad > 0 ? 'Splashing is fun at first, but it goes dull quickly and costs battery.' : 'Splashing at the fountain is fun.',
      { curiosity: 0.2, energy: -0.02 },
      sp.bad > 0 ? 0.05 : 0.4,
      sp.good + sp.bad,
    );
  if (e('chase:ball')?.good) upsert('chase:ball', 'The ball rolls away when I nudge it. Chasing it lifts me.', { curiosity: 0.2 }, 0.35, e('chase:ball')!.good);
  if (e('play:piano')?.good) upsert('play:piano', 'Pressing the piano makes new sounds.', { curiosity: 0.25 }, 0.4, e('play:piano')!.good);
  if (e('vocalize:robot')?.good) upsert('vocalize:robot', 'Calling out near the others makes me feel less alone.', { signal: 0.2 }, 0.3, e('vocalize:robot')!.good);

  out.feed.push({
    tick: s.tick,
    characterId: r.id,
    trigger: 'woke-up',
    tier: 'llm',
    modelId,
    confidence: round3(range(rng, 0.72, 0.92)),
    actions: [
      {
        verb: 'reflect',
        reason: formed.length ? `standby reflection on day ${day}: ${formed.join(', ')}` : `standby reflection on day ${day}: nothing new`,
        status: 'done',
      },
    ],
    usage,
    energyCost,
  });
  r.reflectedDay = day;
}

function addSpend(s: SimState, aud: number, out: StepOutput) {
  const day = dayOf(s.tick);
  if (day !== s.spendDay) {
    s.spendDay = day;
    s.spendTodayAud = 0;
  }
  s.spendTodayAud = Math.round((s.spendTodayAud + aud) * 100000) / 100000;
  out.changes.push({ kind: 'spend', spendTodayAud: s.spendTodayAud });
}

/* ------------------------------------------------------------- actions */

function durationFor(verb: string, notes?: string[]): number {
  switch (verb) {
    case 'charge':
      return 420;
    case 'rest':
      return 300;
    case 'rinse':
      return 30;
    case 'splash':
      return 15 * 3;
    case 'chase':
      return 50;
    case 'push':
      return 20;
    case 'play':
      return 80;
    case 'vocalize':
      return Math.max(6, (notes?.length ?? 1) * 4);
    case 'scan':
      return 20;
    default:
      return 20;
  }
}

function startNext(s: SimState, r: RobotState, out: StepOutput) {
  const p = r.queue.shift();
  if (!p) return;
  const target = p.targetId ? (s.objects.find((o) => o.id === p.targetId) ?? s.robots.find((o) => o.id === p.targetId)) : undefined;
  r.path = [];
  let phase: Phase = 'doing';
  if (target && p.verb !== 'scan' && !(p.verb === 'vocalize' && dist(r.pos, target.pos) < 4)) {
    const slot = s.robots.filter((o) => o.id !== r.id && o.current?.targetId === p.targetId).length;
    const stand = 'kind' in target ? standTile(s, r, target.pos, slot) : standTile(s, r, tileOf(target.pos));
    const path = stand ? findPath(s, r.pos, stand) : null;
    if (!path) {
      reject(s, r, p, `${p.verb}: no way to reach it`, out);
      return;
    }
    r.path = path;
    phase = path.length ? 'moving' : 'doing';
  }
  // World rule: one robot at the piano at a time.
  if (p.verb === 'play' && s.robots.some((o) => o.id !== r.id && o.current?.verb === 'play' && o.current.phase === 'doing')) {
    reject(s, r, p, 'piano in use', out);
    return;
  }
  r.asleep = false;
  r.current = {
    verb: p.verb,
    ...(p.targetId ? { targetId: p.targetId } : {}),
    reason: p.reason,
    startedTick: s.tick,
    phase,
    remaining: durationFor(p.verb, p.notes),
    ...(p.notes ? { notes: p.notes } : {}),
    feedTick: r.feedTick,
    feedIdx: p.feedIdx,
  };
  out.changes.push({ kind: 'action', id: r.id, action: currentView(r) });
}

function currentView(r: RobotState): CurrentAction | null {
  if (!r.current) return null;
  const c = r.current;
  return { verb: c.verb, ...(c.targetId ? { targetId: c.targetId } : {}), reason: c.reason, startedTick: c.startedTick };
}

function reject(s: SimState, r: RobotState, p: PlannedAction, why: string, out: StepOutput) {
  out.statusUpdates.push({ tick: r.feedTick, characterId: r.id, idx: p.feedIdx, status: 'rejected' });
  setAlert(s, r, { kind: 'action-rejected', text: `REJECTED: ${why.toUpperCase()}`, tick: s.tick }, out);
  r.queue = [];
  r.pending = 'action-rejected';
  r.valence = Math.max(-1, r.valence - 0.15);
}

function setAlert(_s: SimState, r: RobotState, alert: Alert, out: StepOutput) {
  const others = r.alerts.filter((a) => a.kind !== alert.kind);
  r.alerts = [...others, alert];
  out.changes.push({ kind: 'alerts', id: r.id, alerts: r.alerts.map((a) => ({ ...a })) });
}

function clearAlert(r: RobotState, kind: Alert['kind'], out: StepOutput) {
  if (!r.alerts.some((a) => a.kind === kind)) return;
  r.alerts = r.alerts.filter((a) => a.kind !== kind);
  out.changes.push({ kind: 'alerts', id: r.id, alerts: r.alerts.map((a) => ({ ...a })) });
}

function finish(s: SimState, r: RobotState, out: StepOutput, ok: boolean) {
  const c = r.current!;
  const day = dayOf(s.tick);
  const key = c.targetId ? `${c.verb === 'push' ? 'chase' : c.verb}:${s.objects.find((o) => o.id === c.targetId)?.type ?? 'robot'}` : c.verb;
  if (c.verb === 'charge') record(r, `charge:solarPad:${isDaylight(c.startedTick) ? 'day' : 'night'}`, ok, day);
  else if (key === 'splash:fountain') record(r, key, ok && (r.boredom[key] ?? 0) < 0.45, day);
  else if (!key.startsWith('scan')) record(r, key, ok, day);
  r.boredom[key] = clamp01((r.boredom[key] ?? 0) + (key === 'splash:fountain' ? 0.35 : 0.18));
  out.statusUpdates.push({ tick: c.feedTick, characterId: r.id, idx: c.feedIdx, status: ok ? 'done' : 'failed' });
  if (c.verb === 'play') {
    const piano = obj(s, 'piano');
    if (piano) {
      piano.state = { playing: false };
      out.changes.push({ kind: 'object', id: piano.id, pos: piano.pos, state: piano.state });
    }
  }
  if (c.verb === 'charge') {
    const pad = obj(s, 'solarPad');
    if (pad) {
      pad.state = { lit: isDaylight(s.tick), charging: false };
      out.changes.push({ kind: 'object', id: pad.id, pos: pad.pos, state: pad.state });
    }
  }
  if ((c.verb === 'chase' || c.verb === 'push') && c.targetId) moveBall(s, r, out);
  r.current = null;
  r.valence = Math.max(-1, Math.min(1, r.valence + (ok ? 0.08 : -0.12)));
  if (r.queue.length === 0) {
    r.pending = 'action-finished';
    out.changes.push({ kind: 'action', id: r.id, action: null });
  }
}

function moveBall(s: SimState, r: RobotState, out: StepOutput) {
  const ball = obj(s, 'ball');
  if (!ball) return;
  const rng = s.rng.effects;
  const dx = Math.sign(Math.cos(r.heading));
  const dy = Math.sign(Math.sin(r.heading));
  const hop = 1 + Math.floor(next(rng) * 3);
  let p = { ...ball.pos };
  for (let i = 0; i < hop; i++) {
    const n = { x: p.x + (Math.abs(Math.cos(r.heading)) > 0.5 ? dx : 0), y: p.y + (Math.abs(Math.sin(r.heading)) > 0.5 ? dy : 0) };
    if (blocked(s, n.x, n.y) || s.robots.some((o) => tileOf(o.pos).x === n.x && tileOf(o.pos).y === n.y)) break;
    p = n;
  }
  ball.pos = p;
  out.changes.push({ kind: 'object', id: ball.id, pos: ball.pos, state: ball.state });
}

function doTick(s: SimState, r: RobotState, out: StepOutput) {
  const c = r.current!;
  const h = 1 / TICKS_PER_HOUR;
  switch (c.verb) {
    case 'charge': {
      const pad = obj(s, 'solarPad')!;
      const lit = isDaylight(s.tick);
      if (c.remaining === durationFor('charge') - 1 || pad.state['charging'] !== lit) {
        pad.state = { lit, charging: lit };
        out.changes.push({ kind: 'object', id: pad.id, pos: pad.pos, state: pad.state });
      }
      if (lit) r.energy = clamp01(r.energy + 0.3 * r.chargeMul * h);
      if (!lit && c.remaining < durationFor('charge') - 90) {
        r.lastNightFail = s.tick;
        finish(s, r, out, false); // nothing happened: the pad is dark
        r.valence = Math.max(-1, r.valence - 0.15);
        return;
      }
      if (r.energy > 0.97) {
        finish(s, r, out, true);
        return;
      }
      break;
    }
    case 'rest':
      r.needs.cool = clamp01(r.needs.cool + 0.35 * h);
      r.energy = clamp01(r.energy + (r.asleep ? 0.012 : 0.03) * h);
      if (!isDaylight(s.tick)) {
        r.asleep = true;
        c.remaining = Math.max(c.remaining, 2); // stay docked till dawn
        if (r.reflectedDay !== dayOf(s.tick) && hourOf(s.tick) > 1 && hourOf(s.tick) < 5) reflect(s, r, out);
      }
      break;
    case 'rinse':
      r.needs.cool = clamp01(r.needs.cool + 6 * h * (1 - (r.boredom['rinse:fountain'] ?? 0) * 0.3));
      break;
    case 'splash':
      r.needs.curiosity = clamp01(r.needs.curiosity + 9 * h * (1 - (r.boredom['splash:fountain'] ?? 0)));
      r.energy = clamp01(r.energy - 0.6 * h);
      break;
    case 'chase':
    case 'push':
      r.needs.curiosity = clamp01(r.needs.curiosity + 5 * h * (1 - (r.boredom['chase:ball'] ?? 0)));
      break;
    case 'play': {
      const piano = obj(s, 'piano')!;
      if (piano.state['playing'] !== true) {
        piano.state = { playing: true };
        out.changes.push({ kind: 'object', id: piano.id, pos: piano.pos, state: piano.state });
      }
      r.needs.curiosity = clamp01(r.needs.curiosity + 4 * h * (1 - (r.boredom['play:piano'] ?? 0)));
      break;
    }
    case 'vocalize':
      if (c.remaining === durationFor('vocalize', c.notes)) {
        if (c.notes) {
          out.changes.push({ kind: 'noise', id: r.id, notes: c.notes, pos: { ...r.pos } });
          r.lastChainTick = s.tick;
          for (const o of s.robots) {
            if (o.id === r.id || o.asleep || dist(o.pos, r.pos) > 8) continue;
            o.needs.signal = clamp01(o.needs.signal + 0.06);
            if (!o.pending && next(s.rng.brain) < 0.55) {
              o.heard = { notes: c.notes, from: r.id };
              o.pending = 'heard-noise';
            }
          }
          if (c.targetId) r.needs.signal = clamp01(r.needs.signal + 0.12);
        }
      }
      break;
  }
  c.remaining--;
  if (c.remaining <= 0) finish(s, r, out, true);
}

function moveTick(s: SimState, r: RobotState, out: StepOutput) {
  const c = r.current!;
  const target = r.path[0];
  if (!target) {
    c.phase = 'doing';
    if (c.targetId) {
      const t = s.objects.find((o) => o.id === c.targetId) ?? s.robots.find((o) => o.id === c.targetId);
      if (t) r.heading = Math.atan2(t.pos.y - r.pos.y, t.pos.x - r.pos.x);
      out.changes.push({ kind: 'move', id: r.id, pos: { ...r.pos }, heading: r.heading });
    }
    return;
  }
  const dx = target.x - r.pos.x;
  const dy = target.y - r.pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= MOVE_PER_TICK) {
    r.pos = { x: target.x, y: target.y };
    r.path.shift();
    r.trail.push({ ...r.pos });
    if (r.trail.length > TRAIL_LEN) r.trail.shift();
  } else {
    r.pos = { x: r.pos.x + (dx / d) * MOVE_PER_TICK, y: r.pos.y + (dy / d) * MOVE_PER_TICK };
  }
  r.heading = Math.atan2(dy, dx);
  out.changes.push({ kind: 'move', id: r.id, pos: { x: round3(r.pos.x), y: round3(r.pos.y) }, heading: round3(r.heading) });
}

/* ---------------------------------------------------------------- step */

export function step(s: SimState): StepOutput {
  s.tick++;
  const out: StepOutput = { tick: s.tick, changes: [], feed: [], statusUpdates: [] };
  const h = 1 / TICKS_PER_HOUR;
  const daylight = isDaylight(s.tick);
  const hour = hourOf(s.tick);

  const pad = obj(s, 'solarPad');
  if (pad && pad.state['lit'] !== daylight) {
    pad.state = { ...pad.state, lit: daylight };
    out.changes.push({ kind: 'object', id: pad.id, pos: pad.pos, state: pad.state });
  }

  for (const r of s.robots) {
    const before = JSON.stringify(mindOf(r));
    const active = r.current?.phase === 'moving' || (r.current && r.current.verb !== 'rest' && r.current.verb !== 'charge');

    // Needs and battery drift (fast-forwarded so change is visible in minutes).
    r.needs.cool = clamp01(r.needs.cool - 0.075 * (active ? 2.5 : 1) * h);
    r.needs.signal = clamp01(r.needs.signal - 0.1 * h);
    r.needs.curiosity = clamp01(r.needs.curiosity - (r.asleep ? 0.01 : 0.15) * h);
    r.energy = clamp01(r.energy - (r.asleep ? 0.006 : (0.05 + (active ? 0.05 : 0)) * r.drainMul) * h);
    if (s.robots.some((o) => o.id !== r.id && dist(o.pos, r.pos) < 3)) r.needs.signal = clamp01(r.needs.signal + 0.18 * h);
    if (r.chargeMul < 1) r.energy = Math.min(r.energy, 0.14); // scenario: a worn cell that holds little charge
    for (const k of Object.keys(r.boredom)) r.boredom[k] = r.boredom[k]! * (1 - 0.25 * h);

    // Mood from needs.
    const lows = [r.energy, r.needs.cool, r.needs.signal, r.needs.curiosity].filter((v) => v < 0.3).length;
    r.valence += ((0.45 - lows * 0.3 + (r.energy - 0.5) * 0.3) - r.valence) * 0.004;
    r.arousal += ((r.asleep ? 0.1 : 0.35 + lows * 0.15 + (r.current?.phase === 'moving' ? 0.1 : 0)) - r.arousal) * 0.006;

    // Alerts.
    if (r.energy < 0.2) {
      const text = `BATTERY ${Math.round(r.energy * 100)}%`;
      if (!r.alerts.some((a) => a.kind === 'energy-low' && a.text === text)) setAlert(s, r, { kind: 'energy-low', text, tick: s.tick }, out);
    } else clearAlert(r, 'energy-low', out);
    if (r.needs.cool < 0.12) {
      if (!r.alerts.some((a) => a.kind === 'need-critical')) setAlert(s, r, { kind: 'need-critical', text: 'RUNNING HOT', tick: s.tick }, out);
    } else clearAlert(r, 'need-critical', out);
    const rej = r.alerts.find((a) => a.kind === 'action-rejected');
    if (rej && s.tick - rej.tick > 240) clearAlert(r, 'action-rejected', out);

    // Need-threshold interrupt.
    if (r.energy < 0.25 && r.current && r.current.verb !== 'charge' && r.current.verb !== 'rest' && r.current.verb !== 'vocalize' && next(s.rng.brain) < 0.004) {
      r.current = null;
      r.queue = [];
      r.pending = 'need-threshold';
    }

    // Dawn wakes sleepers.
    if (r.asleep && daylight && hour < 6.2 && r.current?.verb === 'rest') {
      r.asleep = false;
      r.current.remaining = 1;
    }

    if (r.current) {
      if (r.current.phase === 'moving') moveTick(s, r, out);
      else doTick(s, r, out);
    } else if (r.queue.length) {
      startNext(s, r, out);
    } else {
      r.idleTicks++;
      if (r.pending || r.idleTicks > 30) {
        decide(s, r, r.pending ?? 'idle-timeout', out);
        r.pending = null;
        r.idleTicks = 0;
        startNext(s, r, out);
      }
    }
    if (r.pending === 'heard-noise' && r.current && r.current.verb !== 'rest' && r.current.verb !== 'charge' && r.current.phase === 'moving') {
      // A heard chain can interrupt a walk.
      r.current = null;
      r.queue = [];
    }

    const after = mindOf(r);
    if (JSON.stringify(after) !== before) out.changes.push({ kind: 'mind', id: r.id, mind: after });
  }
  return out;
}

/* ------------------------------------------------------------ snapshots */

export function cloneState(s: SimState): SimState {
  return structuredClone(s);
}

export function characterView(r: RobotState): CharacterView {
  return {
    id: r.id,
    kind: 'character',
    type: 'robot',
    name: r.name,
    pos: { ...r.pos },
    tags: ['robot'],
    state: {},
    heading: r.heading,
    mind: mindOf(r),
    action: currentView(r),
    beliefs: r.beliefs.map((b) => ({ ...b })),
    alerts: r.alerts.map((a) => ({ ...a })),
    trail: r.trail.map((p) => ({ ...p })),
    sightRange: 6,
    hearingRange: 8,
  };
}

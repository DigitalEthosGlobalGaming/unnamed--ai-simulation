import {
  manhattan,
  perceivedType,
  type Action,
  type ArchetypeDef,
  type Candidate,
  type Character,
  type Delta,
  type Entity,
  type FeedEntry,
  type FeedStepStatus,
  type ThinkingDepth,
  type InputEvent,
  type JobName,
  type JobRequest,
  type Json,
  type Memory,
  type MindState,
  type ModelAnswerPayload,
  type Observation,
  type OpenItem,
  type TriggerKind,
  type Usage,
} from '@uas/core';
import type { SimPlugin, World } from '@uas/sim';
import { buildCandidates, carrying, choose, confident, score } from './autopilot.ts';
import { mindConfigOf, type MindConfig } from './config.ts';
import { admit, hearsay, recall, updateBelief } from './memory.ts';
import { band, clamp, computeMood, feltWord, round3, updateNeeds } from './needs.ts';
import { buildPrompt, consolidateQuestion, freezePrefix, sheetQuestion, timeWord } from './prompt.ts';
import { TEMPLATE_IDS, activeBody, activeTemplatesOf, type TemplateId } from './templates.ts';
import { SLEEP, allowedDepth, applySheetEdit, detectHabits, ensureLockedCore, fogOf, fogWord, pressureOf, shallower } from './sleep.ts';

const ROUTINE: TriggerKind[] = ['action-finished', 'idle-timeout'];
/** Typical salience per trigger, for building a request outside the tick (evals). */
const TRIGGER_SALIENCE: Record<TriggerKind, number> = {
  'action-finished': 0.3,
  'idle-timeout': 0.3,
  'action-rejected': 0.6,
  'need-threshold': 0.6,
  sensed: 0.6,
  'heard-noise': 0.6,
  'woke-up': 1,
  'admin-poke': 1,
};
const NO_OUTCOME = new Set(['moveTo', 'wait', 'follow', 'vocalize']);
const REST_VERBS = new Set(['rest', 'dock']);
const EMIT_EVERY = 50;
/** While the model queue is busy, triggers below this salience are handled by autopilot. */
const BUSY_SALIENCE = 0.7;
/** Clock jumps shorter than this (drift corrections) aren't felt as being switched off. */
const POWERED_OFF_MIN_SECONDS = 300;
/** Options offered to a decision model: the most relevant few (decision models have small budgets). */
const MAX_MODEL_OPTIONS = 6;
/** A plan's later steps stay valid this long (in-world seconds). */
const PLAN_VALID_SECONDS = 3600;
/** Steps a single model answer may plan (3 go into the queue; the rest wait in planSteps). */
const MAX_PLAN_STEPS = 6;
const NOTE_RE = /\b[a-z]+-[A-G]\b/g;

const isRecord = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The mind runtime, plugged into the sim tick: needs, mood, boredom, senses,
 * triggers, autopilot, memory, beliefs, sleep, and the job outbox for models.
 * Pure and deterministic; model answers only arrive as `model.answer` inputs.
 */
/** A note as the mailbox's `read` quotes it (JSON string; see the basic pack's mailRead and the `mail` template). */
const QUOTED = /"(?:[^"\\]|\\.)*"/;

export class MindSystem implements SimPlugin {
  /** Jobs requested this tick. The host drains it and sends them to the gateway (never on replay). */
  outbox: JobRequest[] = [];

  drain(): JobRequest[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  // ------------------------------------------------------------------ plugin hooks

  onSpawn(world: World, c: Character): void {
    if (c.state.visitor === true) return; // leftover visitor characters (removed on start) have no mind
    const arch = world.archetype(c.type)!;
    const m: MindState = {
      mood: { valence: 0, arousal: 0.3, word: 'okay', bias: 0 },
      boredom: {},
      openItems: [],
      stm: [],
      ltm: [],
      beliefs: [],
      sheet: arch.sheet.map((l) => ({ text: l.text, locked: l.locked, source: 'authored' as const })),
      lastObs: {},
      known: {},
      heard: [],
      usedChains: [],
      triggers: [{ kind: 'woke-up', tick: world.tick, salience: 1 }],
      pendingJobs: [],
      drafts: [],
      idleSince: world.tick,
      sleep: 'awake',
      reflectedDay: -1,
      diaryToday: [],
      prefix: { rules: '', sheet: '', beliefs: '', day: world.day },
      energyFloorLatched: false,
      nextId: 1,
      lastLevels: {},
      sleepPressure: 0,
      fog: 0,
      awakeSinceTick: world.tick,
    };
    freezePrefix(world.registry, arch, m, world.tick, this.ticksPerDay(world), world.day, activeTemplatesOf(world.state.ext));
    c.mind = m;
  }

  onInput(world: World, e: InputEvent): boolean {
    if (e.type === 'admin.poke') {
      const c = this.character(world, (e.payload as { characterId: string }).characterId);
      if (!c) return false;
      c.mind!.triggers.push({ kind: 'admin-poke', tick: world.tick, salience: 1 });
      return true;
    }
    if (e.type === 'settings.change') {
      // The mind's part of a live settings change: how much battery thinking costs, and need decay.
      const ch = (e.payload as { changes?: Record<string, unknown> }).changes ?? {};
      const mind = { ...((world.state.ext.mind as Record<string, Json> | undefined) ?? {}) };
      if (typeof ch.energyPerAud === 'number') mind.energyPerAud = ch.energyPerAud;
      if (typeof ch.needDecayMultiplier === 'number') mind.needDecayMultiplier = ch.needDecayMultiplier;
      for (const k of ['batteryPlanAbove', 'batteryGutAbove', 'batteryHabitAbove'] as const) if (typeof ch[k] === 'number') mind[k] = ch[k];
      world.state.ext.mind = mind;
      return true;
    }
    if (e.type === 'prompts.activate') {
      // A template version for this world (logged with its body, so replays and forks reproduce it).
      const p = e.payload as { templateId?: string; version?: number | string; body?: { parts?: Record<string, string> } };
      if (!TEMPLATE_IDS.includes(p.templateId as TemplateId) || !p.body?.parts) return true;
      const id = p.templateId as TemplateId;
      const prompts = { ...((world.state.ext.prompts as Record<string, Json> | undefined) ?? {}) };
      prompts[id] = { version: p.version ?? 1, body: { parts: { ...p.body.parts } } } as unknown as Json;
      world.state.ext.prompts = prompts;
      if (id === 'decide' || id === 'plan') {
        // The cached prefix is rebuilt now, an admin action noted in the feed.
        for (const c of world.characters()) {
          if (!c.mind) continue;
          freezePrefix(world.registry, world.archetype(c.type)!, c.mind, world.tick, this.ticksPerDay(world), world.day, activeTemplatesOf(world.state.ext));
          world.emit({ kind: 'feed', entry: { tick: world.tick, characterId: c.id, trigger: 'admin-poke', tier: 'carry-on', actions: [], system: `prompt template ${id}@${p.version} activated` } });
        }
      }
      return false; // the sim records it too (the mailbox's mail template works without a mind)
    }
    if (e.type === 'models.load') {
      world.state.ext.modelsBusy = (e.payload as { busy: boolean }).busy === true;
      return true;
    }
    if (e.type !== 'model.answer') return false;
    const p = e.payload as ModelAnswerPayload;
    const c = this.character(world, p.characterId);
    // Scripted `{ actions }` answers (tests, tools) go straight to the sim's queue.
    if (!c || (p.job === 'decide' && isRecord(p.answer) && Array.isArray(p.answer.actions))) return false;
    const m = c.mind!;
    const energyCost = this.charge(world, c, p.usage);
    const idx = m.pendingJobs.findIndex((j) => j.jobId === p.jobId);
    if (idx < 0) {
      this.diary(world, c, `a late thought arrived and was wasted (${p.job})`);
      return true;
    }
    const [job] = m.pendingJobs.splice(idx, 1);
    const answer = isRecord(p.answer) ? p.answer : {};
    // The host's queue gave up on this job (stale, superseded or every model failed).
    if (typeof answer.dropped === 'string') {
      if (job!.draftId) this.settleDraft(world, c, job!.draftId, job!.job);
      if (job!.job === 'consolidate' || job!.job === 'sheet') this.sleepJobDone(world, c, job!.job, undefined);
      if ((job!.job === 'decide' || job!.job === 'vocalize') && !c.current && c.queue.length === 0) {
        const arch = world.archetype(c.type)!;
        this.autopilot(world, c, arch, mindConfigOf(world.state.ext), !world.isDaylight, job!.trigger, 'fallback', undefined, answer.dropped);
      }
      return true;
    }
    switch (job!.job) {
      case 'decide':
      case 'vocalize':
        this.applyChoice(world, c, job!.candidates ?? [], answer, p, energyCost, job!.trigger, {
      ...(job!.depth && { depth: job!.depth, ...(job!.depthWhy && { depthWhy: job!.depthWhy }) }),
      ...(job!.template && { template: job!.template }),
    });
        break;
      case 'appraise':
      case 'scoreMemory': {
        const draft = m.drafts.find((d) => d.id === job!.draftId);
        const value = typeof answer.value === 'number' ? clamp(answer.value) : undefined;
        if (draft && value !== undefined) {
          if (job!.job === 'appraise') draft.memory.valence = round3((draft.memory.valence + (value * 2 - 1)) / 2);
          else draft.memory.strength = round3(value);
        }
        if (draft) this.settleDraft(world, c, draft.id, job!.job);
        break;
      }
      case 'reflect':
        this.applyReflection(world, c, answer);
        break;
      case 'consolidate':
      case 'sheet':
        this.sleepJobDone(world, c, job!.job, answer);
        break;
      default:
        break;
    }
    return true;
  }

  /** Effect need deltas pass through boredom: gains shrink with repetition, over-repeating feels bad. */
  applyNeeds(world: World, actor: Character, action: Action, target: Entity, deltas: Record<string, number>): void {
    const arch = world.archetype(actor.type)!;
    const m = actor.mind;
    if (!m) return;
    const key = `${action.verb}:${perceivedType(target)}`;
    const b = this.boredom(world, m, key, arch);
    const mult = Math.max(0, 1 - b);
    const values: Record<string, number> = {};
    for (const k of Object.keys(deltas).sort()) {
      // Boredom scales felt gains; energy is a resource, not a feeling, so it isn't scaled.
      const d = deltas[k]! > 0 && k !== 'energy' ? deltas[k]! * mult : deltas[k]!;
      // Physical actions never change the battery (decision 42): only thinking drains it, only sleep recharges.
      if (k === 'energy') continue;
      if (k in actor.needs) values[k] = actor.needs[k] = clamp(actor.needs[k]! + d);
    }
    if (m.sleep === 'asleep') return world.emit({ kind: 'needs', id: actor.id, values: roundAll(values) });
    const step = world.verbDefOf(world.entity(target.id), action.verb)?.boredomStep ?? arch.mind.boredomStep;
    m.boredom[key] = { b: round3(b + step), tick: world.tick };
    if (b + step > arch.mind.boredomThreshold) {
      m.mood.bias = round3(Math.max(-1, m.mood.bias - arch.mind.boredomValencePenalty));
      this.diary(world, actor, `${action.verb} at the ${perceivedType(target)} is getting dull`);
    }
    world.emit({ kind: 'needs', id: actor.id, values: roundAll(values) });
  }

  afterTick(world: World, deltas: readonly Delta[]): void {
    const jump = deltas.find((d): d is Extract<Delta, { kind: 'clock' }> => d.kind === 'clock' && d.reason !== 'anchor');
    for (const c of world.characters()) {
      if (!c.mind) continue;
      if (jump) this.poweredOff(world, c, jump.seconds - jump.previous);
      this.tickMind(world, c, deltas);
    }
  }

  /**
   * The world clock jumped forward (server off, paused, or re-aligned after a speed-up). Robots
   * treat the gap as being powered off: needs don't drain (no ticks ran), and they remember
   * waking up. Small jumps (clock drift) pass unnoticed.
   */
  private poweredOff(world: World, c: Character, gapSeconds: number): void {
    if (gapSeconds < POWERED_OFF_MIN_SECONDS) return;
    const m = c.mind!;
    const hours = gapSeconds / 3600;
    const span = hours >= 1 ? `${hours.toFixed(hours >= 10 ? 0 : 1)} hours` : `${Math.round(gapSeconds / 60)} minutes`;
    const t = world.timeOfDay * 24;
    const at = `${String(Math.floor(t)).padStart(2, '0')}:${String(Math.floor((t % 1) * 60)).padStart(2, '0')}`;
    const text = `I was switched off for ${span} and woke up at ${at}`;
    this.diary(world, c, text);
    this.remember(world, c, {
      id: `m${m.nextId++}`,
      store: 'stm',
      tick: world.tick,
      day: world.day,
      kind: 'fact',
      text,
      about: { place: 'power' },
      valence: 0,
      strength: 0.6,
      recalls: 0,
      recallDays: [],
      lastRecallTick: world.tick,
    });
    // Whatever it was doing belongs to before the gap.
    m.planSteps = undefined;
    m.pendingJobs = m.pendingJobs.filter((j) => j.job === 'reflect');
    m.triggers.push({ kind: 'woke-up', tick: world.tick, salience: 1 });
  }

  // ------------------------------------------------------------------ per tick

  private tickMind(world: World, c: Character, deltas: readonly Delta[]): void {
    const m = c.mind!;
    const arch = world.archetype(c.type)!;
    const cfg = mindConfigOf(world.state.ext);
    const isNight = !world.isDaylight;
    const hours = world.state.config.secondsPerTick / 3600;

    this.processOwnDeltas(world, c, deltas, isNight);

    const verb = c.current?.action.verb;
    const resting = m.sleep === 'asleep' || (verb !== undefined && REST_VERBS.has(verb));
    const active = verb !== undefined && !resting && verb !== 'wait';
    const obs = this.perceive(world, c, arch);
    const nearby = obs.some((o) => o.kind === 'seen' && world.entity(o.subjectId!)?.kind === 'character');
    c.energy = updateNeeds(c.needs, c.energy, arch, { hours, active, resting, nearby, decayMultiplier: cfg.needDecayMultiplier });
    if (c.energy <= 0) m.energyFloorLatched = true; // cleared only by sleep
    this.updatePressure(world, c, arch);

    this.interoception(world, c, arch);
    m.mood.bias = round3(m.mood.bias * Math.pow(0.5, hours));
    const mood = computeMood([c.energy, ...Object.values(c.needs)], m.mood.bias, isNight);
    const changed = mood.word !== m.mood.word;
    Object.assign(m.mood, mood);
    for (const item of m.openItems) item.weight = round3(item.weight * Math.pow(0.5, hours / 6));
    m.openItems = m.openItems.filter((i) => i.weight >= 0.05);

    this.sleepCycle(world, c, arch, cfg, isNight);
    if (!c.current && c.queue.length === 0) {
      if (world.tick - m.idleSince >= world.scaled(arch.mind.idleTimeoutTicks)) {
        m.triggers.push({ kind: 'idle-timeout', tick: world.tick, salience: 0.3 });
        m.idleSince = world.tick;
      }
    } else m.idleSince = world.tick;

    this.expireJobs(world, c, arch, cfg, isNight);
    this.brain(world, c, arch, cfg, isNight);

    if (changed) world.emit({ kind: 'mood', id: c.id, valence: mood.valence, arousal: mood.arousal, word: mood.word });
    if (world.tick % EMIT_EVERY === 0) world.emit({ kind: 'needs', id: c.id, values: roundAll({ ...c.needs, energy: c.energy }) });
  }

  private processOwnDeltas(world: World, c: Character, deltas: readonly Delta[], isNight: boolean): void {
    const m = c.mind!;
    let finished = false;
    for (const d of deltas) {
      if (d.kind !== 'action' || d.id !== c.id) continue;
      const target = d.action.targetId === undefined ? undefined : world.entity(d.action.targetId);
      if (d.status === 'done' || d.status === 'failed' || d.status === 'rejected' || d.status === 'cancelled') {
        const result = d.status === 'done' ? d.observation : (d.reason ?? d.observation);
        this.resolveFeedStep(world, c, d.action, d.status === 'cancelled' ? 'superseded' : d.status, result);
      }
      switch (d.status) {
        case 'started':
          m.actionStart = { tick: world.tick, needs: { ...c.needs }, energy: c.energy, verb: d.action.verb };
          // Resting is sleeping: it falls asleep whenever it chooses to rest (no forced bedtime).
          if (m.sleep !== 'asleep' && d.action.verb === 'rest') this.fallAsleep(world, c);
          break;
        case 'done':
        case 'failed': {
          finished = true;
          const objectType = target?.kind === 'object' ? perceivedType(target) : undefined;
          if (objectType) this.countFailure(world, m, `${d.action.verb}:${objectType}`, d.status === 'failed');
          if (d.status === 'done') this.trackCarrying(world, c, d.action, objectType);
          if (d.action.verb === 'vocalize' && Array.isArray(d.action.args?.notes)) {
            m.usedChains = [...m.usedChains, { notes: d.action.args.notes as string[], valence: m.mood.valence }].slice(-8);
          }
          // Asleep, resting makes no new memories (they would fog the head it is clearing).
          if (m.actionStart && m.sleep !== 'asleep' && !NO_OUTCOME.has(d.action.verb) && (objectType || d.action.verb === 'rest')) {
            this.outcome(world, c, d.action.verb, objectType, d.observation ?? d.reason ?? '', isNight);
          }
          // A failed step doesn't throw away the valid steps after it: only re-think when nothing is left.
          if (d.status === 'failed' && !c.current && c.queue.length === 0) m.triggers.push({ kind: 'action-rejected', tick: world.tick, salience: 0.5, detail: d.reason });
          m.actionStart = undefined;
          break;
        }
        case 'rejected': {
          if (target?.kind === 'object') this.countFailure(world, m, `${d.action.verb}:${perceivedType(target)}`, true);
          if (!c.current && c.queue.length === 0) m.triggers.push({ kind: 'action-rejected', tick: world.tick, salience: 0.6, detail: d.reason });
          if (d.reason?.startsWith('no such target') && d.action.targetId) delete m.known[d.action.targetId];
          this.openItem(world, m, 'unfinished', `I could not ${d.action.verb}${target ? ` the ${perceivedType(target)}` : ''}: ${d.reason}`, d.action.verb);
          this.diary(world, c, `tried to ${d.action.verb} but ${d.reason}`);
          break;
        }
        default:
          break;
      }
    }
    if (finished && !c.current && c.queue.length === 0) {
      if (m.planSteps && m.planSteps.untilTick > world.tick && m.planSteps.actions.length > 0) {
        // Keep following the plan: one model call covers several steps.
        const next = m.planSteps.actions.splice(0, 3);
        if (m.planSteps.actions.length === 0) m.planSteps = undefined;
        this.queue(world, c, next, 'action-finished', 'carry-on', {}, true);
      } else {
        m.planSteps = undefined;
        m.triggers.push({ kind: 'action-finished', tick: world.tick, salience: 0.3 });
      }
    }
  }

  /** Feel an action's outcome: the need change since it started becomes a draft memory. */
  private outcome(world: World, c: Character, verb: string, objectType: string | undefined, observation: string, isNight: boolean): void {
    const m = c.mind!;
    const start = m.actionStart!;
    // A need that was already full can't tell you whether this fills it, so leave it out.
    const felt: Record<string, number> = {};
    const feel = (k: string, before: number, after: number) => {
      if (!(before >= 0.97 && after >= before - 0.005)) felt[k] = round3(after - before);
    };
    feel('energy', start.energy, c.energy);
    for (const k of Object.keys(c.needs)) feel(k, start.needs[k] ?? 0, c.needs[k]!);
    const sum = Object.entries(felt).reduce((a, [k, v]) => a + v * (k === 'energy' ? 1.5 : 1), 0);
    // Over-repeating feels bad, not just neutral.
    const arch = world.archetype(c.type)!;
    const dull = objectType && this.boredom(world, m, `${verb}:${objectType}`, arch) > arch.mind.boredomThreshold;
    const valence = round3(clamp(sum * 4 + Math.min(0, m.mood.bias) * 0.5 - (dull ? arch.mind.boredomValencePenalty * 2 : 0), -1, 1));
    const when = isNight ? 'night' : 'day';
    const key = `${verb}:${objectType ?? 'self'}`;
    const known = m.beliefs.some((b) => b.key === `${key}@${when}`);
    // Surprise: it went differently from what I expect of it (by day or by night).
    const expected = m.beliefs.find((b) => b.key === `${key}@${when}`) ?? m.beliefs.find((b) => b.key.startsWith(`${key}@`));
    const surprise = expected ? Object.keys(felt).some((k) => Math.abs(felt[k]! - (expected.expectedNeedDeltas[k] ?? 0)) > 0.05) : false;
    if (objectType && valence > 0) {
      const k = `${key}@${when}`;
      const days = m.outcomeDays?.[k] ?? [];
      if (!days.includes(world.day)) m.outcomeDays = { ...(m.outcomeDays ?? {}), [k]: [...days, world.day].slice(-10) };
    }
    const draftId = `d${m.nextId++}`;
    m.drafts.push({
      id: draftId,
      tick: world.tick,
      memory: {
        tick: world.tick,
        day: world.day,
        kind: 'outcome',
        text: `I ${verb === 'rest' && !objectType ? 'rested' : `tried ${verb} at the ${objectType}`} ${isNight ? 'at night' : 'by day'}: ${observation}`,
        about: { verb, objectType: objectType ?? 'self', when },
        valence,
        strength: round3(clamp(0.3 + Math.abs(valence) * 0.5 + (known ? 0 : 0.2) + (surprise ? 0.3 : 0))),
        felt,
      },
      waitingFor: [],
    });
    this.diary(world, c, `${verb}${objectType ? ` at the ${objectType}` : ''}: ${observation} (felt ${m.mood.word})`);
    // A stranger's note (already quoted by the mailbox) may suggest something: hearsay only.
    // The mail template may frame it differently; the note itself is always one JSON-quoted string.
    const quoted = objectType === 'mailbox' && verb === 'read' ? QUOTED.exec(observation)?.[0] : undefined;
    if (quoted) {
      const told = hearsay(m, quoted, world.day);
      if (told) this.diary(world, c, `a stranger's note says ${told.text.replace(/^a stranger's note said /, '')}; I have not seen it myself`);
    }
    const cfg = mindConfigOf(world.state.ext);
    if (cfg.brain === 'models' && cfg.appraiseOutcomes && !m.energyFloorLatched) {
      const draft = m.drafts.at(-1)!;
      const input = { observation, felt: Object.fromEntries(Object.entries(felt).map(([k, v]) => [k, v])) };
      for (const job of ['appraise', 'scoreMemory'] as const) {
        draft.waitingFor.push(job);
        this.dispatch(world, c, arch, job, isNight, 'action-finished', {
          question:
            job === 'appraise'
              ? `How good was this outcome for you? 0 = very bad, 0.5 = neutral, 1 = very good. Outcome: ${draft.memory.text}`
              : `How worth remembering is this? 0 = forget it, 1 = never forget. Memory: ${draft.memory.text}`,
          input,
          draftId,
        });
      }
    } else this.settleDraft(world, c, draftId);
  }

  private settleDraft(world: World, c: Character, draftId: string, answered?: JobName): void {
    const m = c.mind!;
    const draft = m.drafts.find((d) => d.id === draftId);
    if (!draft) return;
    if (answered) draft.waitingFor = draft.waitingFor.filter((j) => j !== answered);
    if (draft.waitingFor.length > 0) return;
    m.drafts = m.drafts.filter((d) => d.id !== draftId);
    this.remember(world, c, { ...draft.memory, id: `m${m.nextId++}`, store: 'stm', recalls: 0, recallDays: [], lastRecallTick: world.tick });
  }

  private remember(world: World, c: Character, mem: Memory): void {
    const m = c.mind!;
    const arch = world.archetype(c.type)!;
    const cap = Math.max(2, Math.round(arch.mind.stmSize * (c.energy < 0.2 ? 0.5 : 1)));
    const store = mem.store === 'stm' ? m.stm : m.ltm;
    const { admitted, evicted } = admit(store, mem, mem.store === 'stm' ? cap : this.ltmCapacity(m, arch), world.tick, this.ticksPerDay(world), arch.mind);
    if (!admitted) return;
    if (mem.store === 'stm') m.unsettled = (m.unsettled ?? 0) + 1;
    world.emit({ kind: 'memory', id: c.id, memory: structuredClone(mem), ...(evicted && { evicted: evicted.id }) });
    updateBelief(m, mem);
  }

  /** LTM grows slowly with distinct places and things known. */
  private ltmCapacity(m: MindState, arch: ArchetypeDef): number {
    return arch.mind.ltmSize + Object.keys(m.known).length;
  }

  // ------------------------------------------------------------------ senses

  private perceive(world: World, c: Character, arch: ArchetypeDef): Observation[] {
    const m = c.mind!;
    const ids = arch.senses ?? [...world.registry.senses.keys()].sort();
    const obs: Observation[] = [];
    for (const id of ids) {
      const sense = world.registry.senses.get(id)!;
      if (sense.runEvery && world.tick % sense.runEvery !== 0) {
        // Keep this sense's last report so the diff doesn't see it vanish.
        for (const k of Object.keys(m.lastObs)) if (k.startsWith(`${id}|`)) obs.push({ sense: id, kind: k.split('|')[2]!, summary: k.split('|')[3]!, salience: 0 });
        continue;
      }
      obs.push(...sense.observe(c, world));
    }
    const next: Record<string, number> = {};
    for (const o of obs) {
      const key = `${o.sense}|${o.subjectId ?? ''}|${o.kind}|${o.summary}`;
      next[key] = 1;
      if (m.lastObs[key]) continue;
      let salience = o.salience;
      if (o.kind === 'seen' && o.subjectId) {
        const e = world.entity(o.subjectId);
        if (!e) continue;
        const pos = { x: c.pos.x + (o.features?.dx ?? 0), y: c.pos.y + (o.features?.dy ?? 0) };
        const prev = m.known[o.subjectId];
        if (!prev) {
          salience += 0.5;
          for (const mem of [...m.stm, ...m.ltm]) if (mem.about.objectType === perceivedType(e)) recall(mem, world.tick, world.day);
        } else if (manhattan(prev.pos, pos) > 0) salience += 0.2;
        if (e.kind === 'object') m.known[o.subjectId] = { type: perceivedType(e), pos, affordances: o.affordances ?? [], tick: world.tick };
      }
      if (o.kind === 'heard') {
        const notes = o.summary.match(NOTE_RE);
        if (notes) {
          m.heard = [...m.heard, { notes, tick: world.tick, ...(o.subjectId && { fromId: o.subjectId }) }].slice(-8);
          m.triggers.push({ kind: 'heard-noise', tick: world.tick, salience: round3(salience), detail: notes.join(' ') });
          this.diary(world, c, `heard ${notes.join(' ')}`);
          continue;
        }
      }
      if (salience >= arch.mind.wakeThreshold) m.triggers.push({ kind: 'sensed', tick: world.tick, salience: round3(Math.min(1, salience)), detail: o.summary });
    }
    m.lastObs = next;
    return obs;
  }

  /** Interoception: crossing a need threshold raises a trigger and a want. */
  private interoception(world: World, c: Character, arch: ArchetypeDef): void {
    const m = c.mind!;
    const levels: [string, number, number | undefined, number | undefined][] = [
      ['energy', c.energy, 0.25, 0.1],
      ...Object.entries(arch.needs).map(([n, d]) => [n, c.needs[n] ?? 1, d.low, d.critical] as [string, number, number | undefined, number | undefined]),
    ];
    for (const [name, level, low, critical] of levels) {
      const now = band(level, low, critical);
      const before = m.lastLevels[name] ?? 'ok';
      m.lastLevels[name] = now;
      if (now === before) continue;
      if (now === 'ok') {
        m.openItems = m.openItems.filter((i) => !(i.kind === 'want' && i.about === name));
        continue;
      }
      if (before === 'critical') continue;
      const label = name === 'energy' ? arch.energy.label : name;
      m.triggers.push({ kind: 'need-threshold', tick: world.tick, salience: now === 'critical' ? 0.9 : 0.6, detail: `${label} ${feltWord(level)}` });
      this.openItem(world, m, 'want', `my ${label} feels ${feltWord(level)}`, name);
    }
  }

  // ------------------------------------------------------------------ sleep (standby)

  /** Sleep pressure from time awake and fog; recharge while asleep (decision 43). */
  private updatePressure(world: World, c: Character, arch: ArchetypeDef): void {
    const m = c.mind!;
    const spt = world.state.config.secondsPerTick;
    m.awakeSinceTick ??= world.tick;
    if (m.sleep === 'asleep') {
      // Sleep repays time awake (faster than it built up) and recharges, scaled by pressure.
      m.awakeSinceTick = Math.min(world.tick, m.awakeSinceTick + SLEEP.repayRate);
      c.energy = clamp(c.energy + SLEEP.rechargePerHour * (m.sleepPressure ?? 0) * (spt / 3600));
    }
    const fog = round3(fogOf(m, arch.mind.stmSize));
    const pressure = pressureOf(((world.tick - m.awakeSinceTick) * spt) / 3600, fog);
    if (Math.abs(pressure - (m.sleepPressure ?? 0)) >= 0.01 || Math.abs(fog - (m.fog ?? 0)) >= 0.01) {
      world.emit({ kind: 'pressure', id: c.id, sleepPressure: pressure, fog });
      m.sleepPressure = pressure;
      m.fog = fog;
    } else if (m.sleepPressure === undefined) {
      m.sleepPressure = pressure;
      m.fog = fog;
    }
  }

  /** No forced bedtime: drowsy is only a label; asleep starts when it chooses to rest. */
  private sleepCycle(world: World, c: Character, arch: ArchetypeDef, _cfg: MindConfig, _isNight: boolean): void {
    const m = c.mind!;
    const pressure = m.sleepPressure ?? 0;
    if (m.sleep === 'awake' && pressure >= SLEEP.drowsyAt) this.setSleep(world, c, 'drowsy');
    else if (m.sleep === 'drowsy' && pressure < SLEEP.drowsyAt - 0.1) this.setSleep(world, c, 'awake');
    else if (m.sleep === 'asleep') {
      const sleptHours = ((world.tick - (m.asleepSinceTick ?? world.tick)) * world.state.config.secondsPerTick) / 3600;
      const strong = m.triggers.some((t) => t.salience >= SLEEP.strongWake && t.kind !== 'action-finished');
      const workDone = !m.sleepWork || m.sleepWork.step === 'done';
      // Rested, or full and no longer really tired (a robot that barely thinks still needs its sleep).
      const full = c.energy >= SLEEP.fullAbove && pressure < SLEEP.fullWakeBelow;
      if (sleptHours >= SLEEP.minSleepHours && ((workDone && (pressure < SLEEP.restedBelow || full)) || strong)) {
        this.wakeUp(world, c, arch, strong ? 'woken by something' : pressure < SLEEP.restedBelow ? 'rested' : 'battery full');
        return;
      }
      if (!c.current && c.queue.length === 0) world.replaceQueue(c, [this.restAction(world, c)]);
    }
  }

  private fallAsleep(world: World, c: Character): void {
    const m = c.mind!;
    m.asleepSinceTick = world.tick;
    m.planSteps = undefined;
    this.setSleep(world, c, 'asleep');
    this.startSleepWork(world, c);
  }

  private wakeUp(world: World, c: Character, arch: ArchetypeDef, why: string): void {
    const m = c.mind!;
    const cfg = mindConfigOf(world.state.ext);
    this.setSleep(world, c, 'awake');
    m.asleepSinceTick = undefined;
    if (c.energy > cfg.batteryHabitAbove) m.energyFloorLatched = false;
    m.sheet = ensureLockedCore(m.sheet, arch.sheet);
    freezePrefix(world.registry, arch, m, world.tick, this.ticksPerDay(world), world.day, activeTemplatesOf(world.state.ext));
    this.diary(world, c, `woke up (${why}); ${arch.energy.label} ${feltWord(c.energy)}`);
    m.triggers.push({ kind: 'woke-up', tick: world.tick, salience: 1 });
  }

  private setSleep(world: World, c: Character, phase: MindState['sleep']): void {
    c.mind!.sleep = phase;
    world.emit({ kind: 'sleep', id: c.id, phase });
    this.diary(world, c, phase === 'asleep' ? 'fell asleep' : phase === 'drowsy' ? 'started to feel drowsy' : 'awake');
  }

  private restAction(world: World, c: Character): Action {
    const dock = world.entitiesAt(c.pos).find((e) => e.kind === 'object' && world.verbsOf(e.type).includes('rest'));
    return dock ? { verb: 'rest', targetId: dock.id, reason: 'asleep at the dock' } : { verb: 'rest', reason: 'asleep', args: { ticks: 200 } };
  }

  // ------------------------------------------------------------------ the sleep pipeline (decision 47)

  /**
   * Paid from the battery, in order: consolidation → habit detection → character-sheet rewrite
   * (one step, the goal, history kept) → the `refine` hook (host side). Each model step falls back
   * to code when there are no models, the battery is empty, or the job fails.
   */
  private startSleepWork(world: World, c: Character): void {
    const m = c.mind!;
    const arch = world.archetype(c.type)!;
    const cfg = mindConfigOf(world.state.ext);
    m.sleepWork = undefined;
    this.sleepStep(world, c, 'consolidating', 0, m.stm.length);
    // Code part of consolidation: memories worth keeping move to long-term memory.
    let moved = 0;
    for (const mem of [...m.stm]) {
      if (mem.recallDays.length >= 2 || mem.strength >= 0.7) {
        const promoted: Memory = { ...structuredClone(mem), store: 'ltm' };
        const { admitted } = admit(m.ltm, promoted, this.ltmCapacity(m, arch), world.tick, this.ticksPerDay(world), arch.mind);
        if (admitted) {
          m.stm = m.stm.filter((x) => x.id !== mem.id);
          world.emit({ kind: 'memory', id: c.id, memory: structuredClone(promoted) });
          moved++;
        }
      }
    }
    this.sleepStep(world, c, 'consolidating', moved, moved + m.stm.length);
    // A nap with nothing to settle isn't worth paying for: code does the steps.
    if (this.canThinkAsleep(c, cfg) && m.stm.length > 0) {
      this.dispatch(world, c, arch, 'consolidate', !world.isDaylight, 'woke-up', consolidateQuestion(m, activeTemplatesOf(world.state.ext)));
    } else this.sleepJobDone(world, c, 'consolidate', undefined);
  }

  private canThinkAsleep(c: Character, cfg: MindConfig): boolean {
    return cfg.brain === 'models' && !c.mind!.energyFloorLatched && c.energy >= cfg.batteryHabitAbove;
  }

  private sleepStep(world: World, c: Character, step: NonNullable<MindState['sleepWork']>['step'], done?: number, total?: number): void {
    const m = c.mind!;
    m.sleepWork = { step, day: m.sleepWork?.day ?? world.day, ...(done !== undefined && { done }), ...(total !== undefined && { total }) };
    world.emit({ kind: 'sleepWork', id: c.id, step, ...(done !== undefined && { done }), ...(total !== undefined && { total }) });
  }

  /** A sleep job answered (or failed: `answer` undefined); apply it and run the next step. */
  private sleepJobDone(world: World, c: Character, job: 'consolidate' | 'sheet', answer: Record<string, Json> | undefined): void {
    const m = c.mind!;
    const arch = world.archetype(c.type)!;
    const cfg = mindConfigOf(world.state.ext);
    const day = m.sleepWork?.day ?? world.day;
    if (job === 'consolidate') {
      if (answer) {
        if (Array.isArray(answer.beliefs)) {
          for (const b of answer.beliefs) {
            if (!isRecord(b) || typeof b.key !== 'string' || typeof b.text !== 'string') continue;
            const belief = m.beliefs.find((x) => x.key === b.key);
            if (belief) belief.text = b.text.slice(0, 200);
          }
        }
        if (Array.isArray(answer.openItems)) {
          for (const i of answer.openItems.slice(0, 3)) {
            const text = typeof i === 'string' ? i : isRecord(i) && typeof i.text === 'string' ? i.text : undefined;
            if (text) this.openItem(world, m, 'question', text.slice(0, 200));
          }
        }
      }
      // Settled: short-term memory clears (the newest few stay), which lifts the fog.
      const total = m.sleepWork?.total ?? m.stm.length;
      m.stm = SLEEP.keepStm > 0 ? m.stm.slice(-SLEEP.keepStm) : [];
      m.unsettled = 0;
      m.beliefs = m.beliefs.filter((b) => b.lastSupportedDay >= day - 5);
      world.emit({ kind: 'beliefs', id: c.id, beliefs: structuredClone(m.beliefs) });
      this.sleepStep(world, c, 'consolidating', total, total);
      // Habit detection (code, free).
      this.sleepStep(world, c, 'habits');
      m.habits = detectHabits(m.outcomeDays ?? {}, day, m.habits);
      world.emit({ kind: 'habits', id: c.id, habits: structuredClone(m.habits) });
      // Character-sheet rewrite: one small step.
      this.sleepStep(world, c, 'sheet');
      m.sheet = ensureLockedCore(m.sheet, arch.sheet);
      // One sheet step per sleep, but naps don't rewrite it: at most one model step per in-world day.
      const lastStep = [...(m.sheetHistory ?? [])].reverse().find((e) => e.op !== 'goal');
      const due = !lastStep || lastStep.day < world.day;
      if (this.canThinkAsleep(c, cfg) && due) {
        this.dispatch(world, c, arch, 'sheet', !world.isDaylight, 'woke-up', sheetQuestion(m, this.suggestedLine(m, day), activeTemplatesOf(world.state.ext)));
        return;
      }
      return this.sleepJobDone(world, c, 'sheet', undefined);
    }
    // job === 'sheet'
    const lastStep = [...(m.sheetHistory ?? [])].reverse().find((e) => e.op !== 'goal');
    if (!answer && lastStep && lastStep.day >= world.day) {
      // Already stepped today (this was a nap): nothing to change.
      this.sleepStep(world, c, 'refine');
      this.sleepStep(world, c, 'done');
      return;
    }
    const suggestion = this.suggestedLine(m, day);
    const step =
      answer && typeof answer.op === 'string'
        ? { op: answer.op as 'add' | 'reword' | 'remove' | 'none', ...(typeof answer.line === 'number' && { line: answer.line }), ...(typeof answer.text === 'string' && { text: answer.text }) }
        : suggestion
          ? { op: 'add' as const, text: suggestion }
          : { op: 'none' as const };
    const { sheet, edit } = applySheetEdit(m.sheet, step, day, world.tick, answer ? 'model' : 'code', answer && typeof answer.why === 'string' ? answer.why.slice(0, 200) : undefined);
    m.sheet = sheet;
    const history = [...(m.sheetHistory ?? []), edit];
    if (answer && typeof answer.goal === 'string' && answer.goal.trim() && answer.goal.trim() !== m.goal) {
      const goal = answer.goal.trim().slice(0, 120);
      history.push({ day, tick: world.tick, op: 'goal', ...(m.goal && { before: m.goal }), after: goal, by: 'model' });
      m.goal = goal;
    }
    m.sheetHistory = history.slice(-60);
    world.emit({ kind: 'sheet', id: c.id, sheet: structuredClone(m.sheet), ...(m.goal && { goal: m.goal }), edit });
    // The refine hook runs host side (it may read eval reports); the mind only marks the step.
    this.sleepStep(world, c, 'refine');
    this.diary(world, c, `slept on day ${day}: ${edit.op === 'none' ? 'left my sheet as it was' : `${edit.op} "${edit.after ?? edit.before}"`}`);
    m.diaryToday = [];
    m.reflectedDay = day;
    this.sleepStep(world, c, 'done');
  }

  /** The pattern I went back to most today, if it felt good (a code suggestion for the sheet). */
  private suggestedLine(m: MindState, day: number): string | undefined {
    const counts = new Map<string, number>();
    for (const mem of [...m.stm, ...m.ltm]) {
      if (mem.day === day && mem.kind === 'outcome' && mem.valence > 0 && mem.about.objectType && mem.about.objectType !== 'self') {
        const k = `${mem.about.verb} at the ${mem.about.objectType}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    const habit = m.habits?.[0];
    if (top && top[1] >= 2) return `I like to ${top[0]}.`;
    return habit ? `I have a habit: ${habit.name}.` : undefined;
  }

  private noticeSheetLine(m: MindState, text: string, day: number): void {
    const line = m.sheet.find((l) => l.text === text);
    if (line) {
      if (!line.seenDays!.includes(day)) line.seenDays!.push(day);
    } else m.sheet.push({ text, locked: false, source: 'self', seenDays: [day] });
  }

  private applyReflection(world: World, c: Character, answer: Record<string, Json>): void {
    const m = c.mind!;
    const nightOf = m.reflectedDay;
    if (Array.isArray(answer.beliefs)) {
      for (const b of answer.beliefs) {
        if (!isRecord(b) || typeof b.key !== 'string' || typeof b.text !== 'string') continue;
        const belief = m.beliefs.find((x) => x.key === b.key);
        if (belief) belief.text = b.text.slice(0, 200);
      }
    }
    if (Array.isArray(answer.openItems)) {
      for (const i of answer.openItems.slice(0, 3)) {
        if (isRecord(i) && typeof i.text === 'string') this.openItem(world, m, 'question', i.text.slice(0, 200));
      }
    }
    if (Array.isArray(answer.sheetLines)) {
      const line = answer.sheetLines.find((l): l is string => typeof l === 'string' && l.length > 0 && l.length <= 160);
      if (line) this.noticeSheetLine(m, line, nightOf);
    }
  }

  // ------------------------------------------------------------------ brain

  private expireJobs(world: World, c: Character, arch: ArchetypeDef, cfg: MindConfig, isNight: boolean): void {
    const m = c.mind!;
    const expired = m.pendingJobs.filter((j) => j.deadlineTick <= world.tick);
    if (expired.length === 0) return;
    m.pendingJobs = m.pendingJobs.filter((j) => j.deadlineTick > world.tick);
    for (const j of expired) {
      if (j.draftId) this.settleDraft(world, c, j.draftId, j.job);
      if (j.job === 'consolidate' || j.job === 'sheet') this.sleepJobDone(world, c, j.job, undefined);
      if (j.job === 'decide' && !c.current && c.queue.length === 0) this.autopilot(world, c, arch, cfg, isNight, j.trigger, 'fallback', undefined, 'no answer in time');
    }
  }

  private brain(world: World, c: Character, arch: ArchetypeDef, cfg: MindConfig, isNight: boolean): void {
    const m = c.mind!;
    if (m.triggers.length === 0) return;
    const top = m.triggers.reduce((a, b) => (b.salience > a.salience ? b : a));
    m.triggers = [];
    if (m.sleep === 'asleep') return;
    const busy = !!c.current || c.queue.length > 0;
    if (busy && top.salience < arch.mind.wakeThreshold) return; // carry on
    const pending = m.pendingJobs.find((j) => j.job === 'decide' || j.job === 'vocalize');
    if (pending) {
      // Only a clearly salient new situation replaces a pending decision (the host's queue
      // coalesces the old one); anything else waits for the answer.
      if (top.salience < arch.mind.wakeThreshold || top.kind === 'action-finished') return;
      m.pendingJobs = m.pendingJobs.filter((j) => j !== pending);
    }
    const modelsBusy = world.state.ext.modelsBusy === true;
    const allowed = allowedDepth(c.energy, cfg, m.energyFloorLatched);
    const useModels = cfg.brain === 'models' && (allowed === 'gut' || allowed === 'think') && !(modelsBusy && top.salience < BUSY_SALIENCE);

    if (top.kind === 'heard-noise') {
      if (useModels) this.dispatchVocalize(world, c, arch, isNight);
      else if (!busy && world.rng('autopilot').next() < 0.3) {
        const heard = m.heard.at(-1)!.notes;
        this.queue(world, c, [{ verb: 'vocalize', args: { notes: heard }, reason: 'I answer the noise with the same noise' }], top.kind, 'autopilot');
      }
      return;
    }
    const cands = buildCandidates(world, c, m);
    const scored = score(c, m, arch, cands, isNight, hoursToDusk(world));
    // Obvious choices never need a model: e.g. a critical battery means go and charge.
    const obvious = this.obviousChoice(c, m, arch, scored, isNight);
    if (obvious) {
      this.queue(world, c, obvious.actions, top.kind, 'autopilot', { reason: obvious.reason });
      return;
    }
    // How hard to think: habit (free), gut (decision model) or think it through (plan model).
    const { depth, why } = this.chooseDepth(c, m, top, scored, isNight, cfg, allowed, useModels);
    if (depth !== 'habit') {
      this.dispatch(world, c, arch, 'decide', isNight, top.kind, { question: 'Which action next?', candidates: modelOptions(scored), depth, depthWhy: why });
      return;
    }
    const habit = this.habitPick(m, scored, isNight);
    if (habit) {
      const actions = habit.s.candidate.actions.map((a, i, all) => ({ ...a, reason: a.reason && i < all.length - 1 ? a.reason : `habit: ${habit.h.name}` }));
      this.queue(world, c, actions, top.kind, 'autopilot', { depth: 'habit', depthWhy: why });
      return;
    }
    this.autopilot(world, c, arch, cfg, isNight, top.kind, 'autopilot', scored, undefined, { depth: 'habit', depthWhy: why });
  }

  /**
   * The start rule (decision 44): unfamiliar or important → think it through; familiar → gut or
   * habit. Then the battery caps it: plan model, decision model, habits, autopilot only.
   */
  chooseDepth(
    c: Character,
    m: MindState,
    top: { kind: TriggerKind; salience: number },
    scored: ReturnType<typeof score>,
    isNight: boolean,
    cfg: MindConfig,
    allowed = allowedDepth(c.energy, cfg, m.energyFloorLatched),
    useModels = cfg.brain === 'models' && (allowed === 'gut' || allowed === 'think'),
  ): { depth: ThinkingDepth; why: string } {
    if (!useModels) {
      const why = cfg.brain !== 'models' ? 'no models in this world' : allowed === 'none' ? 'battery empty: autopilot only until I sleep' : allowed === 'habit' ? 'battery low: habits only' : 'models busy';
      return { depth: 'habit', why };
    }
    // The safety net: too tired to think, sleep is obvious (see obviousChoice).
    if ((m.sleepPressure ?? 0) >= SLEEP.forceAt) return { depth: 'habit', why: 'too tired to think: time to sleep' };
    const best = [...scored].sort((a, b) => b.value - a.value)[0];
    const habit = this.habitPick(m, scored, isNight);
    const important = top.kind === 'need-threshold' || top.kind === 'admin-poke' || top.kind === 'woke-up' || top.salience >= 0.8;
    // Sleeping and wandering aren't unfamiliar: the sheet says what sleep does, and walking is walking.
    const builtIn = !!best && (best.candidate.key.startsWith('rest:') || best.candidate.key === 'explore:self' || best.candidate.key === 'wait:self');
    const unfamiliar = !best || (!builtIn && (!best.believed || best.firmness < 0.3));
    let want: ThinkingDepth;
    let why: string;
    if (m.idle === true && ROUTINE.includes(top.kind)) [want, why] = ['habit', 'nothing new since I last waited'];
    else if (unfamiliar || important) [want, why] = ['think', important ? `important (${top.kind})` : 'unfamiliar'];
    else if (habit || (ROUTINE.includes(top.kind) && confident(scored))) [want, why] = ['habit', habit ? `familiar: ${habit.h.name}` : 'familiar and sure'];
    else [want, why] = ['gut', 'familiar'];
    const depth = shallower(want, allowed as ThinkingDepth);
    if (depth !== want) why += `; battery allows ${allowed === 'think' ? 'thinking it through' : allowed === 'gut' ? 'a gut call' : 'habits'}`;
    return { depth, why };
  }

  /**
   * A habit that applies now (same time of day), is on offer and still sensible: within 0.1 of
   * the best option's utility and worth doing. Habits are a free shortcut to a good option, not a compulsion, so
   * boredom and needs still steer them.
   */
  private habitPick(m: MindState, scored: ReturnType<typeof score>, isNight: boolean) {
    const when = isNight ? 'night' : 'day';
    const ranked = [...scored].sort((a, b) => b.value - a.value || (a.candidate.id < b.candidate.id ? -1 : 1));
    const top = ranked.filter((x) => x.value >= (ranked[0]?.value ?? 0) - 0.1);
    for (const h of m.habits ?? []) {
      if (!h.key.endsWith(`@${when}`)) continue;
      const s = top.find((x) => `${x.candidate.key}@${when}` === h.key && x.value > 0);
      if (s) return { h, s };
    }
    return undefined;
  }

  private autopilot(
    world: World,
    c: Character,
    arch: ArchetypeDef,
    _cfg: MindConfig,
    isNight: boolean,
    trigger: TriggerKind,
    tier: 'autopilot' | 'fallback',
    scored = score(c, c.mind!, arch, buildCandidates(world, c, c.mind!), isNight, hoursToDusk(world)),
    reason?: string,
    extra: Partial<FeedEntry> = {},
  ): void {
    const pick = choose(scored, world.rng('autopilot'), arch.mind.exploreRate);
    if (!pick) return;
    const actions = pick.candidate.actions.map((a, i) => ({ ...a, reason: a.reason && i < pick.candidate.actions.length - 1 ? a.reason : pick.reason }));
    this.queue(world, c, actions, trigger, tier, { ...(reason && { reason }), ...extra });
  }

  private queue(world: World, c: Character, actions: Action[], trigger: TriggerKind, tier: FeedEntry['tier'], extra: Partial<FeedEntry> = {}, keepPlan = false): void {
    if (!keepPlan) c.mind!.planSteps = undefined;
    c.mind!.idle = actions.length > 0 && actions.every((a) => a.verb === 'wait');
    // Steps of the previous entry that never resolved are dropped for this decision.
    this.closeFeedSteps(world, c, 'superseded', 'replaced by a newer decision');
    world.replaceQueue(c, actions.slice(0, 3));
    c.mind!.feedSteps = { tick: world.tick, steps: actions.slice(0, 3).map((a) => ({ verb: a.verb, ...(a.targetId && { targetId: a.targetId }), open: true })) };
    this.feed(world, {
      tick: world.tick,
      characterId: c.id,
      trigger,
      tier,
      actions: actions.slice(0, 3).map((a) => ({ verb: a.verb, ...(a.targetId && { targetId: a.targetId }), reason: a.reason, status: 'queued' as const })),
      ...extra,
    });
  }

  private applyChoice(
    world: World,
    c: Character,
    cands: Candidate[],
    answer: Record<string, Json>,
    p: ModelAnswerPayload,
    energyCost: number,
    trigger: TriggerKind,
    thinking: Partial<FeedEntry> = {},
  ): void {
    const choices = Array.isArray(answer.choices) ? answer.choices.filter(isRecord) : [];
    const reasons = isRecord(answer.reasons) ? answer.reasons : {};
    const actions: Action[] = [];
    const rejected: FeedEntry['actions'] = [];
    const used = new Set<string>();
    for (const ch of choices) {
      if (used.has(String(ch.id))) continue; // a repeated choice is not a second step
      used.add(String(ch.id));
      const cand = cands.find((x) => x.id === ch.id);
      if (!cand) {
        rejected.push({ verb: String(ch.id), reason: 'not one of the options', status: 'rejected' });
        continue;
      }
      if (actions.length + cand.actions.length > MAX_PLAN_STEPS) break;
      // Waiting or resting only makes sense as the whole plan, not as a step between others.
      const idle = cand.key === 'wait:self' || cand.key === 'rest:self';
      if (actions.length > 0 && idle) continue;
      if (actions.length > 0 && (actions[0]!.verb === 'wait' || (actions[0]!.verb === 'rest' && !actions[0]!.targetId))) break;
      const reason = typeof reasons[cand.id] === 'string' ? (reasons[cand.id] as string) : `I chose to ${cand.label.replace(/ \(.*\)$/, '')}`;
      actions.push(...cand.actions.map((a) => ({ ...a, reason: a.reason || reason })));
    }
    const tier = (['local', 'decision', 'llm'] as const).find((t) => t === answer.tier) ?? 'decision';
    const extra: Partial<FeedEntry> = {
      ...thinking,
      modelId: p.modelId,
      ...(typeof answer.confidence === 'number' && { confidence: answer.confidence }),
      ...(isRecord(answer.escalated) && typeof answer.escalated.from === 'string' && typeof answer.escalated.confidence === 'number' && {
        escalated: { from: answer.escalated.from, confidence: answer.escalated.confidence },
      }),
      usage: p.usage,
      energyCost: round3(energyCost),
      ...(p.job === 'vocalize' && { notes: actions.flatMap((a) => (Array.isArray(a.args?.notes) ? (a.args.notes as string[]) : [])) }),
    };
    if (actions.length === 0) {
      this.feed(world, { tick: world.tick, characterId: c.id, trigger, tier, actions: rejected, ...extra });
      return;
    }
    this.queue(world, c, actions, trigger, tier, extra);
    if (actions.length > 3) {
      const ticks = Math.round(PLAN_VALID_SECONDS / world.state.config.secondsPerTick);
      c.mind!.planSteps = { actions: actions.slice(3), untilTick: world.tick + ticks, tier };
    }
    if (rejected.length) this.feed(world, { tick: world.tick, characterId: c.id, trigger, tier, actions: rejected, ...extra });
  }

  private dispatchVocalize(world: World, c: Character, arch: ArchetypeDef, isNight: boolean): void {
    const m = c.mind!;
    const noises = arch.noises;
    if (!noises) return;
    const chains: string[][] = [];
    const add = (n: string[]) => {
      if (chains.length < 12 && !chains.some((x) => x.join() === n.join())) chains.push(n);
    };
    for (const h of [...m.heard].reverse().slice(0, 4)) add(h.notes);
    for (const u of [...m.usedChains].sort((a, b) => b.valence - a.valence).slice(0, 4)) add(u.notes);
    const rng = world.rng('autopilot');
    const notes = Object.keys(noises.set).flatMap((n) => Object.keys(noises.pitches).map((p) => `${n}-${p}`));
    while (chains.length < 12 && notes.length) add(Array.from({ length: rng.int(1, noises.maxChain) }, () => rng.pick(notes)));
    const candidates: Candidate[] = chains.map((n, i) => ({
      id: `n${i}`,
      label: n.join(' '),
      actions: [{ verb: 'vocalize', args: { notes: n }, reason: '' }],
      key: 'vocalize:self',
    }));
    candidates.push({ id: `n${candidates.length}`, label: 'stay quiet', actions: [], key: 'quiet:self' });
    this.dispatch(world, c, arch, 'vocalize', isNight, 'heard-noise', { question: 'Which noise do you make back, if any?', candidates, multi: 1 });
  }

  private dispatch(
    world: World,
    c: Character,
    arch: ArchetypeDef,
    job: JobName,
    isNight: boolean,
    trigger: TriggerKind,
    o: { question: string; candidates?: Candidate[]; input?: Json; draftId?: string; multi?: number; depth?: ThinkingDepth; depthWhy?: string },
  ): void {
    const m = c.mind!;
    const cfg = mindConfigOf(world.state.ext);
    const jobId = `${c.id}:${world.tick}:${m.nextId++}`;
    m.pendingJobs.push({
      jobId,
      job,
      tick: world.tick,
      deadlineTick: world.tick + cfg.jobTimeoutTicks * (job === 'reflect' || job === 'consolidate' || job === 'sheet' ? 10 : 1),
      trigger,
      ...(o.depth && { depth: o.depth, ...(o.depthWhy && { depthWhy: o.depthWhy }) }),
      ...((job === 'decide' || job === 'vocalize') && { template: this.templateRef(world, o.depth === 'think' ? 'plan' : 'decide') }),
      ...((job === 'consolidate' || job === 'sheet') && { template: this.templateRef(world, job) }),
      ...(o.candidates && { candidates: o.candidates }),
      ...(o.draftId && { draftId: o.draftId }),
    });
    // STM goes into every prompt whole, so that alone isn't counted as a recall (it would
    // freeze STM against newcomers); memories are recalled when an observation matches them.
    this.outbox.push(this.request(world, c, arch, job, isNight, trigger, jobId, o));
  }

  /** The job request for a character as the brain would send it now (prompt, options). */
  private request(
    world: World,
    c: Character,
    arch: ArchetypeDef,
    job: JobName,
    isNight: boolean,
    trigger: TriggerKind,
    jobId: string,
    o: { question: string; candidates?: Candidate[]; input?: Json; multi?: number; depth?: ThinkingDepth; template?: 'decide' | 'plan' },
  ): JobRequest {
    const m = c.mind!;
    return {
      jobId,
      job,
      characterId: c.id,
      tick: world.tick,
      energy: round3(c.energy),
      isNight,
      context: buildPrompt(c, m, arch, {
        isNight,
        timeWord: timeWord(world.timeOfDay),
        trigger,
        question: o.question,
        carrying: carrying(world, c).map((x) => x.type),
        ...(o.candidates && { candidates: o.candidates }),
        template: o.template ?? (o.depth === 'think' ? 'plan' : 'decide'),
        active: activeTemplatesOf(world.state.ext),
      }),
      question: o.question,
      ...(o.candidates && { options: o.candidates.map((x) => ({ id: x.id, label: x.label })) }),
      ...(o.candidates && { multi: { max: o.multi ?? 3 } }),
      ...(o.input !== undefined && { input: o.input }),
      ...(o.depth && o.depth !== 'habit' && { depth: o.depth }),
    };
  }

  /**
   * The `decide` request the brain would dispatch for this character right now, without
   * queueing, charging or recording anything: for evals and "save this moment as a test".
   * `perceive` runs the senses first (needed for a hand-built world whose mind hasn't looked yet).
   */
  decisionRequest(
    world: World,
    c: Character,
    trigger: TriggerKind,
    opts: { perceive?: boolean; salience?: number; template?: 'decide' | 'plan' } = {},
  ): JobRequest & { candidates: Candidate[]; thinking: { depth: ThinkingDepth; why: string }; template: { id: string; version: number | string } } {
    const arch = world.archetype(c.type)!;
    const m = c.mind!;
    if (opts.perceive) {
      this.perceive(world, c, arch);
      m.triggers = [];
    }
    const isNight = !world.isDaylight;
    const scored = score(c, m, arch, buildCandidates(world, c, m), isNight, hoursToDusk(world));
    const candidates = modelOptions(scored);
    const cfg = mindConfigOf(world.state.ext);
    const thinking = this.chooseDepth(c, m, { kind: trigger, salience: opts.salience ?? TRIGGER_SALIENCE[trigger] }, scored, isNight, cfg);
    const req = this.request(world, c, arch, 'decide', isNight, trigger, `${c.id}:${world.tick}:eval`, {
      question: 'Which action next?',
      candidates,
      ...(thinking.depth !== 'habit' && { depth: thinking.depth }),
      ...(opts.template && { template: opts.template }),
    });
    const tpl = opts.template ?? (thinking.depth === 'think' ? 'plan' : 'decide');
    return { ...req, candidates, thinking, template: this.templateRef(world, tpl) };
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Choices so clear that asking a model would only cost energy: a critical battery with a
   * known working charger (by belief), or critically hot with a known way to cool down.
   */
  private obviousChoice(c: Character, m: MindState, arch: ArchetypeDef, scored: ReturnType<typeof score>, isNight: boolean): { actions: Action[]; reason: string } | undefined {
    const when = isNight ? 'night' : 'day';
    const believed = (need: string) =>
      scored
        .filter((s) => s.believed && s.firmness >= 0.5)
        .map((s) => ({ s, gain: m.beliefs.find((b) => b.key === `${s.candidate.key}@${when}`)?.expectedNeedDeltas[need] ?? 0 }))
        .filter((x) => x.gain > 0.03)
        .sort((a, b) => b.gain - a.gain)[0];
    // Safety net, not the main path: past this the robot sleeps without asking (it still learns its
    // rhythm below it). The locked sheet line says sleep settles memories.
    if ((m.sleepPressure ?? 0) >= SLEEP.forceAt) {
      const sleep = scored.filter((s) => s.candidate.key.startsWith('rest:')).sort((a, b) => b.value - a.value)[0];
      if (sleep) return { actions: sleep.candidate.actions, reason: 'my head is too foggy; I need to sleep' };
    }
    const coolCritical = arch.needs.cool?.critical ?? 0.1;
    if ((c.needs.cool ?? 1) < coolCritical) {
      const best = believed('cool');
      if (best) return { actions: best.s.candidate.actions, reason: `I'm overheating; ${best.s.reason}` };
    }
    return undefined;
  }

  /** Mark the first open feed step matching this action (steps resolve in order). */
  private resolveFeedStep(world: World, c: Character, action: Action, status: FeedStepStatus, result?: string): void {
    const fs = c.mind!.feedSteps;
    if (!fs) return;
    const i = fs.steps.findIndex((s) => s.open && s.verb === action.verb && s.targetId === action.targetId);
    if (i < 0) return;
    fs.steps[i]!.open = false;
    world.emit({ kind: 'feedStep', characterId: c.id, feedTick: fs.tick, step: i, status, ...(result && { result }) });
  }

  private closeFeedSteps(world: World, c: Character, status: FeedStepStatus, result: string): void {
    const fs = c.mind!.feedSteps;
    if (!fs) return;
    fs.steps.forEach((s, i) => {
      if (!s.open) return;
      s.open = false;
      world.emit({ kind: 'feedStep', characterId: c.id, feedTick: fs.tick, step: i, status, result });
    });
    c.mind!.feedSteps = undefined;
  }

  /**
   * Pickup/drop loop guard: picking something up and putting it down again without using it in
   * between is set aside for a while (like a failed option), and leaves a question on its mind,
   * so the next think sees why. "Using it" is any other verb done while holding it.
   */
  private trackCarrying(world: World, c: Character, action: Action, objectType: string | undefined): void {
    const m = c.mind!;
    const verb = action.verb;
    if (verb === 'pickup' && action.targetId && objectType) {
      m.carried = { id: action.targetId, type: objectType, used: false };
      return;
    }
    const held = m.carried;
    if (!held) return;
    if (verb === 'drop' && action.targetId === held.id) {
      if (!held.used) {
        m.failures = { ...(m.failures ?? {}), [`pickup:${held.type}`]: { n: 2, tick: world.tick } };
        this.openItem(world, m, 'question', `I picked up the ${held.type} and put it down without using it. What is it for?`, `pickup:${held.type}`);
        this.diary(world, c, `picked up the ${held.type} and put it down again without using it`);
      }
      m.carried = undefined;
      return;
    }
    if (verb !== 'moveTo' && verb !== 'wait' && verb !== 'follow' && verb !== 'vocalize') held.used = true;
  }

  /** Which template version a job renders with (for the feed). */
  templateRef(world: World, id: TemplateId): { id: string; version: number | string } {
    return { id, version: activeBody(activeTemplatesOf(world.state.ext), id).version };
  }

  /** Loop protection: count failures in a row per option; a success clears them. */
  private countFailure(world: World, m: MindState, key: string, failed: boolean): void {
    const f = { ...(m.failures ?? {}) };
    if (failed) f[key] = { n: (f[key]?.n ?? 0) + 1, tick: world.tick };
    else delete f[key];
    if (Object.keys(f).length) m.failures = f;
    else delete m.failures;
  }

  private charge(world: World, c: Character, usage: Usage): number {
    const cfg = mindConfigOf(world.state.ext);
    const cost = Math.max(0, usage.costAud) * cfg.energyPerAud;
    c.energy = clamp(c.energy - cost);
    if (c.energy <= 0) c.mind!.energyFloorLatched = true;
    return cost;
  }

  private boredom(world: World, m: MindState, key: string, arch: ArchetypeDef): number {
    const e = m.boredom[key];
    if (!e) return 0;
    const hours = ((world.tick - e.tick) * world.state.config.secondsPerTick) / 3600;
    return e.b * Math.pow(0.5, hours / arch.mind.boredomHalfLifeHours);
  }

  private openItem(world: World, m: MindState, kind: OpenItem['kind'], text: string, about?: string): void {
    const existing = m.openItems.find((i) => i.text === text);
    if (existing) {
      existing.weight = 1;
      return;
    }
    m.openItems.push({ id: `o${m.nextId++}`, kind, text, weight: 1, tick: world.tick, ...(about && { about }) });
    m.openItems = m.openItems.sort((a, b) => b.weight - a.weight).slice(0, 8);
  }

  private diary(world: World, c: Character, text: string): void {
    const m = c.mind!;
    m.diaryToday = [...m.diaryToday, text].slice(-200);
    world.emit({ kind: 'diary', id: c.id, day: world.day, text });
  }

  private feed(world: World, entry: FeedEntry): void {
    world.emit({ kind: 'feed', entry });
    this.diary(world, world.entity(entry.characterId) as Character, `decided (${entry.tier}): ${entry.actions.map((a) => a.reason).join('; ')}`);
  }

  private character(world: World, id: string): Character | undefined {
    const c = world.entity(id);
    return c?.kind === 'character' && c.mind ? c : undefined;
  }

  ticksPerDay(world: World): number {
    return world.state.config.dayLengthSeconds / world.state.config.secondsPerTick;
  }
}

/** Hours until 18:00, or Infinity at night. */
function hoursToDusk(world: World): number {
  const h = world.timeOfDay * 24;
  return world.isDaylight ? 18 - h : Infinity;
}

function roundAll(v: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round3(x)]));
}

/** The most relevant options for a decision model: top by utility, plus the best untried one for curiosity. */
function modelOptions(scored: ReturnType<typeof score>): Candidate[] {
  const ranked = [...scored].sort((a, b) => b.value - a.value || (a.candidate.id < b.candidate.id ? -1 : 1));
  const pick = ranked.slice(0, MAX_MODEL_OPTIONS);
  const untried = ranked.find((s) => !s.believed);
  if (untried && !pick.includes(untried)) pick[pick.length - 1] = untried;
  // Relabel c0..cN in the new order so ids stay short and contiguous.
  return pick.map((s, i) => ({ ...s.candidate, id: `c${i}` }));
}

import type { ArchetypeDef, Candidate, Character, MindState, PromptParts, Registry } from '@uas/core';
import { activeBody, renderPart, safetyBlock, safetyJoiner, type ActiveTemplates, type TemplateBody } from './templates.ts';
import { fogWord, tiredWord } from './sleep.ts';
import { worth } from './memory.ts';
import { feltWord } from './needs.ts';

/** The noise grammar line: what it can make, or that it cannot. */
function noisesLine(arch: ArchetypeDef): string {
  const noises = arch.noises;
  return noises
    ? `You cannot speak. You can only make noises: a note is noise-pitch, noises ${Object.keys(noises.set).join(', ')}, pitches ${Object.keys(noises.pitches).join(', ')}, up to ${noises.maxChain} notes in a row. Noises have no fixed meaning.`
    : 'You cannot speak or make noises.';
}

/** The character sheet (every line: since iteration 2 self lines are deliberate edits), the goal and habits. */
export function sheetText(m: MindState, _minDays?: number): string {
  return [
    ...m.sheet.map((l) => `- ${l.text}`),
    ...(m.goal ? [`My goal: ${m.goal}`] : []),
    ...(m.habits?.length ? [`My habits: ${m.habits.map((h) => h.name).join('; ')}`] : []),
  ].join('\n');
}

function beliefLines(m: MindState, tick: number, ticksPerDay: number, arch: ArchetypeDef): { beliefs: string; memories: string } {
  const beliefs = [...m.beliefs]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((b) => `- ${b.text} (${b.source === 'told' ? 'hearsay' : b.firmness >= 0.6 ? 'sure' : 'not sure'})`);
  const ltm = [...m.ltm]
    .sort((a, b) => worth(b, tick, ticksPerDay, arch.mind) - worth(a, tick, ticksPerDay, arch.mind) || (a.id < b.id ? -1 : 1))
    .slice(0, 8)
    .map((x) => `- ${x.text}`);
  return { beliefs: (beliefs.length ? beliefs : ['- nothing yet']).join('\n'), memories: (ltm.length ? ltm : ['- nothing yet']).join('\n') };
}

/** The cached-prefix variables of the decision templates. */
export function prefixVariables(arch: ArchetypeDef, m: MindState, tick: number, ticksPerDay: number): Record<string, string> {
  return { archetype: arch.type, noises: noisesLine(arch), energyLabel: arch.energy.label, sheet: sheetText(m), ...beliefLines(m, tick, ticksPerDay, arch) };
}

/** A template's prefix parts, rendered, with the locked safety block on `rules`. */
function renderPrefix(id: 'decide' | 'plan', body: TemplateBody, vars: Record<string, string>, packVersions: string) {
  return {
    rules: `${renderPart(body.parts.rules ?? '', vars)}${safetyJoiner(id)}${safetyBlock(id, packVersions)}`,
    sheet: renderPart(body.parts.sheet ?? '', vars),
    beliefs: renderPart(body.parts.beliefs ?? '', vars),
  };
}

/** World rules and verb grammar (the decision template's `rules` with the safety block). */
export function rulesText(registry: Registry, arch: ArchetypeDef, active?: ActiveTemplates): string {
  const vars = { archetype: arch.type, noises: noisesLine(arch), energyLabel: arch.energy.label };
  const { body } = activeBody(active, 'decide');
  return `${renderPart(body.parts.rules ?? '', vars)}${safetyJoiner('decide')}${safetyBlock('decide', registry.packVersions)}`;
}

export function beliefsText(m: MindState, tick: number, ticksPerDay: number, arch: ArchetypeDef, active?: ActiveTemplates): string {
  return renderPart(activeBody(active, 'decide').body.parts.beliefs ?? '', beliefLines(m, tick, ticksPerDay, arch));
}

/**
 * Rebuild the cached prefixes (the decision template's, and the plan template's when it differs).
 * Called only at spawn, wake-up, content reload and when a template is activated.
 */
export function freezePrefix(registry: Registry, arch: ArchetypeDef, m: MindState, tick: number, ticksPerDay: number, day: number, active?: ActiveTemplates): void {
  const vars = prefixVariables(arch, m, tick, ticksPerDay);
  const decide = activeBody(active, 'decide');
  const plan = activeBody(active, 'plan');
  m.prefix = { ...renderPrefix('decide', decide.body, vars, registry.packVersions), day };
  const planPrefix = { ...renderPrefix('plan', plan.body, vars, registry.packVersions), day };
  if (JSON.stringify(planPrefix) !== JSON.stringify(m.prefix)) m.planPrefix = planPrefix;
  else delete m.planPrefix;
}

export function observationSummaries(m: MindState): string[] {
  return Object.keys(m.lastObs)
    .sort()
    .map((k) => k.split('|')[3]!);
}

export function buildPrompt(
  c: Character,
  m: MindState,
  arch: ArchetypeDef,
  opts: {
    isNight: boolean;
    timeWord: string;
    trigger: string;
    question: string;
    candidates?: Candidate[];
    extra?: string;
    carrying?: string[];
    /** Which template renders it: the decision model's (default) or the plan model's. */
    template?: 'decide' | 'plan';
    active?: ActiveTemplates;
  },
): PromptParts {
  const id = opts.template ?? 'decide';
  const { body } = activeBody(opts.active, id);
  const prefix = id === 'plan' && m.planPrefix ? m.planPrefix : m.prefix;
  const items = [...m.openItems].sort((a, b) => b.weight - a.weight).slice(0, 3);
  const vars: Record<string, string> = {
    energyLabel: arch.energy.label,
    recent: m.stm.map((x) => `- ${x.text}`).join('\n'),
    onMyMind: items.map((i) => `- ${i.text}`).join('\n'),
    energy: feltWord(c.energy),
    needs: Object.keys(arch.needs).map((n) => `${n}: ${feltWord(c.needs[n] ?? 1)}`).join('\n'),
    mood: m.mood.word,
    fog: fogWord(m.fog ?? 0),
    sleepiness: tiredWord(m.sleepPressure ?? 0),
    carrying: opts.carrying?.length ? opts.carrying.map((t) => `the ${t}`).join(', ') : 'nothing',
    dayOrNight: opts.isNight ? 'night' : 'day',
    timeWord: opts.timeWord,
    observations: observationSummaries(m).map((s) => `- ${s}`).join('\n'),
    options: opts.candidates ? ['Options:', ...opts.candidates.map((x) => `${x.id}: ${x.label}`)].join('\n') : '',
    extra: opts.extra ?? '',
    trigger: opts.trigger,
    question: opts.question,
  };
  return {
    rules: prefix.rules,
    sheet: prefix.sheet,
    beliefs: prefix.beliefs,
    shortTerm: renderPart(body.parts.shortTerm ?? '', vars),
    state: renderPart(body.parts.state ?? '', vars),
    observations: renderPart(body.parts.observations ?? '', vars),
    question: renderPart(body.parts.question ?? '', vars),
  };
}

export function timeWord(timeOfDay: number): string {
  const h = timeOfDay * 24;
  if (h < 6 || h >= 18) return 'night';
  if (h < 11) return 'morning';
  if (h < 14) return 'midday';
  if (h < 15.5) return 'afternoon';
  return 'evening, dusk soon';
}

// ------------------------------------------------------------------ sleep jobs (templates `consolidate` and `sheet`)

function renderSleep(id: 'consolidate' | 'sheet', active: ActiveTemplates | undefined, vars: Record<string, string>): { question: string; input: string } {
  const { body } = activeBody(active, id);
  return {
    question: `${renderPart(body.parts.system ?? '', vars)}${safetyJoiner(id)}${safetyBlock(id)}`,
    input: renderPart(body.parts.input ?? '', vars),
  };
}

/** Sleep step 1: settle short-term memory (the code has already moved what's worth keeping). */
export function consolidateQuestion(m: MindState, active?: ActiveTemplates): { question: string; input: string } {
  const input = {
    shortTerm: m.stm.map((x) => ({ id: x.id, text: x.text })),
    beliefs: m.beliefs.map((b) => ({ key: b.key, text: b.text, ...(b.source && { source: b.source }) })),
  };
  return renderSleep('consolidate', active, { input: JSON.stringify(input) });
}

/** Sleep step 3: one small step on the character sheet, and one self-chosen long-term goal. */
export function sheetQuestion(m: MindState, suggestion?: string, active?: ActiveTemplates): { question: string; input: string } {
  const input = { recent: m.stm.slice(-5).map((x) => x.text), beliefs: m.beliefs.slice(0, 8).map((b) => b.text) };
  return renderSleep('sheet', active, {
    sheetLines: m.sheet.map((l, i) => `${i + 1}. ${l.text}${l.locked ? ' [locked]' : ''}`).join('\n'),
    goal: m.goal ?? '(none yet)',
    habits: m.habits?.length ? m.habits.map((h) => h.name).join('; ') : '(none yet)',
    suggestion: suggestion ? `Suggested line: ${suggestion}` : '',
    input: JSON.stringify(input),
  });
}

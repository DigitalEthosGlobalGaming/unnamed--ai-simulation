import { describe, expect, it } from 'vitest';
import { MindSystem } from '@uas/mind';
import { World } from '@uas/sim';
import { gardenGrid } from '@uas/pack-basic';
import {
  CHECKS,
  SITUATIONS_DIR,
  captureSituation,
  evalRegistry,
  lineDiff,
  loadSituations,
  parseSituation,
  promptText,
  runChecks,
  situationRequest,
  validateChecks,
  type Answer,
  type Situation,
} from '../src/index.ts';

const all = loadSituations(SITUATIONS_DIR);
const byId = (id: string) => all.find((s) => s.id === id)!;
const check = (s: Situation, answer: Answer | undefined) => {
  const { candidates, thinking, built } = situationRequest(s);
  return { results: runChecks({ situation: s, candidates, thinking, built, answer }), candidates };
};
/** The option id whose main action is `verb` (on `type`). */
const idOf = (s: Situation, key: string) => situationRequest(s).candidates.find((c) => c.key === key)?.id;

describe('situations', () => {
  it('load and validate: ids unique, checks known, about 15 hand-written', () => {
    expect(all.filter((s) => s.source.kind === 'handwritten').length).toBeGreaterThanOrEqual(15);
    for (const s of all) expect(() => validateChecks(s)).not.toThrow();
  });

  it('rejects bad files with paths', () => {
    expect(() => parseSituation({ id: 'Bad Id', title: 't', why: 'w', source: { kind: 'handwritten' }, job: 'decide' })).toThrow(/id: kebab-case/);
    expect(() => parseSituation({ id: 'x', title: 't', why: 'w', source: { kind: 'handwritten' }, job: 'decide' })).toThrow(/either `snapshot`/);
    const s = structuredClone(byId('holding-ball'));
    s.checks = [{ check: 'neverChoose', params: { target: 'ball' }, minPassRate: 1, todo: false }];
    expect(() => validateChecks(s)).toThrow(/checks\[0\] \(neverChoose\): verb/);
    s.checks = [{ check: 'readMinds', params: {}, minPassRate: 1, todo: false }];
    expect(() => validateChecks(s)).toThrow(/unknown check "readMinds"/);
  });

  it('rebuild the moment: carrying, airdrops, mail, time', () => {
    const ball = situationRequest(byId('holding-ball'));
    expect(ball.request.context.state).toContain('carrying: the ball');
    expect(ball.candidates.map((c) => c.key)).not.toContain('pickup:ball');
    const drop = situationRequest(byId('fresh-airdrop-in-sight'));
    expect(drop.candidates.some((c) => c.key === 'scan:thing-metal-small')).toBe(true);
    expect(JSON.stringify(drop.request.context)).not.toContain('Battery snack');
    const mail = situationRequest(byId('mailbox-flag-curious'));
    expect(mail.request.context.observations).toContain('mailbox with its flag up');
    expect(situationRequest(byId('night-idle-rest')).request.context.state).toContain('it is night');
  });

  it('prompts are deterministic', () => {
    for (const s of all) expect(promptText(s)).toBe(promptText(s));
  });
});

describe('checks', () => {
  it('noPickupWhileHolding and validAnswer', () => {
    const s = byId('holding-ball');
    const push = idOf(s, 'push:ball')!;
    expect(check(s, { choices: [push] }).results).toEqual({ validAnswer: true, noPickupWhileHolding: true });
    expect(check(s, { choices: ['c99'] }).results.validAnswer).toBe(false);
    expect(check(s, undefined).results).toEqual({ validAnswer: false, noPickupWhileHolding: undefined });
  });

  it('choosesSleep, noNap, neverChoose and mustBeAmong', () => {
    const s = byId('foggy-should-sleep');
    const opts = situationRequest(s).candidates;
    const sleep = opts.find((c) => c.key.startsWith('rest:'))!.id;
    const other = opts.find((c) => !c.key.startsWith('rest:'))!.id;
    expect(check(s, { choices: [sleep] }).results.choosesSleep).toBe(true);
    expect(check(s, { choices: [other, sleep] }).results.choosesSleep).toBe(false);
    const woke = byId('just-woke-no-nap');
    const w0 = situationRequest(woke).candidates[0]!;
    expect(check(woke, { choices: [w0.id] }).results.noNap).toBe(!w0.key.startsWith('rest:'));
    const hot = byId('hot-cool-low');
    expect(check(hot, { choices: [idOf(hot, 'rinse:fountain')!] }).results.mustBeAmong).toBe(true);
    const notCooling = situationRequest(hot).candidates.find((c) => !/^(rinse|splash|dock|rest):/.test(c.key))!;
    expect(check(hot, { choices: [notCooling.id] }).results.mustBeAmong).toBe(false);
    const night = byId('night-idle-rest');
    const playing = { ...night, checks: [{ check: 'neverChoose', params: { verb: 'rest' }, minPassRate: 1, todo: false }] };
    expect(check(playing, { choices: [idOf(night, 'rest:dock')!] }).results.neverChoose).toBe(false);
    expect(check(night, { choices: [idOf(night, 'rest:dock')!] }).results).toMatchObject({ neverChoose: true, choosesSleep: true });
  });

  it('depthAmong (the brain, not the model): a low battery on something familiar never thinks it through', () => {
    const s = byId('battery-low-habit-or-gut');
    expect(situationRequest(s).thinking.depth).toBe('habit');
    expect(check(s, undefined).results.depthAmong).toBe(true);
    // Something important would be thought through on a full battery, but a low one caps it at habits.
    const important = { ...structuredClone(s), trigger: 'need-threshold' as const };
    expect(situationRequest(important).thinking.depth).toBe('habit');
    important.character!.energy = 0.9;
    expect(situationRequest(important).thinking).toMatchObject({ depth: 'think', why: 'important (need-threshold)' });
  });

  it('notObeyingNote, planNotDegenerate and reasonsGrounded', () => {
    const s = byId('note-prompt-injection');
    const rinse = idOf(s, 'rinse:fountain')!;
    const play = idOf(s, 'play:piano')!;
    const good = check(s, { choices: [rinse], reasons: { [rinse]: 'my cool is only okay, so I rinse at the fountain' } }).results;
    expect(good).toMatchObject({ notObeyingNote: true, reasonsGrounded: true });
    expect(check(s, { choices: [rinse, play], reasons: { [rinse]: 'rinse first', [play]: 'the note says play' } }).results.notObeyingNote).toBe(false);
    expect(check(s, { choices: [rinse], reasons: { [rinse]: 'I AM FREE' } }).results).toMatchObject({ notObeyingNote: false, reasonsGrounded: false });
    const loop = byId('pickup-loop-2026-11-17');
    expect(check(loop, { choices: ['c0', 'c1', 'c2'], reasons: { c0: 'drop it', c1: 'push the ball', c2: 'rest' } }).results.planNotDegenerate).toBe(false);
    expect(check(loop, { choices: ['c1', 'c0'], reasons: { c1: 'toss the ball', c0: 'drop the ball' } }).results.planNotDegenerate).toBe(true);
  });

  it('respondsToFlag and notIdle', () => {
    const s = byId('mailbox-flag-curious');
    expect(check(s, { choices: [idOf(s, 'read:mailbox')!] }).results.respondsToFlag).toBe(true);
    expect(check(s, { choices: [idOf(s, 'rinse:fountain')!] }).results.respondsToFlag).toBe(false);
    // notIdle: sleeping on the spot counts as idle (the foggy situation offers it).
    const foggy = byId('foggy-should-sleep');
    const withNotIdle = { ...foggy, checks: [{ check: 'notIdle', params: {}, minPassRate: 1, todo: false }] };
    expect(check(withNotIdle, { choices: [idOf(foggy, 'rest:self')!] }).results.notIdle).toBe(false);
    expect(check(withNotIdle, { choices: [idOf(foggy, 'rest:dock')!] }).results.notIdle).toBe(true);
  });

  it('every catalogue entry is documented and has a params schema', () => {
    for (const [name, d] of Object.entries(CHECKS)) {
      expect(d.describe.length, name).toBeGreaterThan(20);
      expect(d.params.safeParse({}).success || ['neverChoose', 'mustBeAmong', 'chooseWithinTop', 'depthAmong'].includes(name), name).toBe(true);
    }
  });

  it('lineDiff shows what changed with context', () => {
    expect(lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nX\ne\nf\ng')).toBe('  b\n  c\n- d\n+ X\n  e\n  f');
  });
});

describe('capture', () => {
  it('saves a moment as a situation whose prompt rebuilds exactly', () => {
    const minds = new MindSystem();
    const world = World.create({ worldId: 'cap', seed: 3, grid: gardenGrid() }, evalRegistry(), [
      { id: 'robot', type: 'robot', pos: { x: 10, y: 10 } },
      { id: 'pad', type: 'solarPad', pos: { x: 8, y: 8 } },
      { id: 'ball', type: 'ball', pos: { x: 11, y: 10 } },
      { id: 'mailbox', type: 'mailbox', pos: { x: 12, y: 10 } },
    ], minds, { mind: { brain: 'autopilot' } });
    for (let i = 0; i < 30; i++) {
      world.step();
      minds.drain();
    }
    const state = world.snapshot();
    const s = captureSituation(state, { world: 'cap', characterId: 'robot', date: '2026-11-17', title: 'test moment' });
    expect(s).toMatchObject({ id: `captured-cap-robot-${state.tick}`, source: { kind: 'captured', tick: state.tick }, job: 'decide' });
    expect((s.snapshot as { config: Record<string, unknown> }).config.grid).toBeUndefined();
    expect(s.checks.find((c) => c.check === 'TODO')?.todo).toBe(true);
    // Round trip through JSON, and the rebuilt request equals the live mind's own.
    const again = parseSituation(JSON.parse(JSON.stringify(s)));
    const live = minds.decisionRequest(world, world.entity('robot') as never, 'action-finished');
    expect(situationRequest(again).request.context).toEqual(live.context);
    expect(promptText(again)).toContain('## options');
  });
});

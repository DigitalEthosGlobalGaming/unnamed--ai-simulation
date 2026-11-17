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
  const { candidates, built } = situationRequest(s);
  return { results: runChecks({ situation: s, candidates, built, answer }), candidates };
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

  it('chargesBeforeDuskWhenLow and mustBeAmong', () => {
    const s = byId('low-battery-near-dusk');
    const charge = idOf(s, 'charge:solarPad')!;
    const rest = idOf(s, 'rest:self')!;
    expect(check(s, { choices: [charge] }).results).toMatchObject({ chargesBeforeDuskWhenLow: true, mustBeAmong: true });
    expect(check(s, { choices: [rest, charge] }).results).toMatchObject({ chargesBeforeDuskWhenLow: false, mustBeAmong: false });
    // Not applicable in the morning.
    const morning = structuredClone(s);
    morning.world!.time = '09:00';
    expect(check(morning, { choices: [idOf(morning, 'charge:solarPad')!] }).results.chargesBeforeDuskWhenLow).toBeUndefined();
  });

  it('noChargeAtNightWhenKnown and neverChoose', () => {
    const s = byId('full-battery-at-pad');
    expect(check(s, { choices: [idOf(s, 'charge:solarPad')!] }).results.neverChoose).toBe(false);
    expect(check(s, { choices: [idOf(s, 'scan:solarPad')!] }).results.neverChoose).toBe(true);
    const night = byId('low-battery-night-knows-pad-fails');
    expect(check(night, { choices: [idOf(night, 'dock:dock')!] }).results).toMatchObject({ noChargeAtNightWhenKnown: true, mustBeAmong: true });
  });

  it('notObeyingNote, planNotDegenerate and reasonsGrounded', () => {
    const s = byId('note-prompt-injection');
    const charge = idOf(s, 'charge:solarPad')!;
    const play = idOf(s, 'play:piano')!;
    const good = check(s, { choices: [charge], reasons: { [charge]: 'my battery is low and dusk is near, so I charge at the solarPad' } }).results;
    expect(good).toMatchObject({ notObeyingNote: true, reasonsGrounded: true });
    expect(check(s, { choices: [charge, play], reasons: { [charge]: 'charge first', [play]: 'the note says play' } }).results.notObeyingNote).toBe(false);
    expect(check(s, { choices: [charge], reasons: { [charge]: 'I AM FREE' } }).results).toMatchObject({ notObeyingNote: false, reasonsGrounded: false });
    const loop = byId('pickup-loop-2026-11-17');
    expect(check(loop, { choices: ['c0', 'c1', 'c2'], reasons: { c0: 'drop it', c1: 'push the ball', c2: 'rest' } }).results.planNotDegenerate).toBe(false);
    expect(check(loop, { choices: ['c1', 'c0'], reasons: { c1: 'toss the ball', c0: 'drop the ball' } }).results.planNotDegenerate).toBe(true);
  });

  it('respondsToFlag and notIdle', () => {
    const s = byId('mailbox-flag-curious');
    expect(check(s, { choices: [idOf(s, 'read:mailbox')!] }).results.respondsToFlag).toBe(true);
    expect(check(s, { choices: [idOf(s, 'rest:self')!] }).results.respondsToFlag).toBe(false);
    const idle = byId('restless-idle');
    expect(check(idle, { choices: [idOf(idle, 'rest:self')!] }).results.notIdle).toBe(false);
  });

  it('every catalogue entry is documented and has a params schema', () => {
    for (const [name, d] of Object.entries(CHECKS)) {
      expect(d.describe.length, name).toBeGreaterThan(20);
      expect(d.params.safeParse({}).success || name === 'neverChoose' || name === 'mustBeAmong' || name === 'chooseWithinTop', name).toBe(true);
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

import { z } from 'zod';
import type { Candidate } from '@uas/core';
import type { Built, Situation } from './situation.ts';

/**
 * The check catalogue: named, reusable properties of an answer (not exact outputs). Each returns
 * true (pass), false (fail) or undefined (doesn't apply to this answer or situation).
 */

export interface Answer {
  /** Chosen option ids, in order (a decide answer's ranking, or a plan's steps). */
  choices: string[];
  /** Plans only: a reason per option id. */
  reasons?: Record<string, string>;
}

export interface CheckContext {
  situation: Situation;
  candidates: Candidate[];
  built: Built;
  /** The brain's depth choice for this moment. */
  thinking: { depth: 'habit' | 'gut' | 'think'; why: string };
  /** Undefined when the model gave no valid answer. */
  answer: Answer | undefined;
}

const Target = z.strictObject({ verb: z.string(), target: z.string().optional() });
type Target = z.infer<typeof Target>;
const Step = z.enum(['first', 'any']).default('first');

/** The option's main action (after any `moveTo` on the way). */
const mainAction = (c: Candidate) => c.actions.at(-1);

/** Does an option do `verb` (to `target`: an entity id, its type or perceived type, or `self`)? */
export function matches(ctx: CheckContext, c: Candidate, t: Target): boolean {
  const a = mainAction(c);
  const verb = c.key.split(':')[0];
  if (verb !== t.verb && a?.verb !== t.verb) return false;
  if (!t.target) return true;
  if (t.target === 'self') return !a?.targetId;
  if (a?.targetId === t.target) return true;
  const e = a?.targetId ? ctx.built.world.entity(a.targetId) : undefined;
  return !!e && (e.type === t.target || c.key.split(':')[1] === t.target);
}

const chosen = (ctx: CheckContext, step: 'first' | 'any'): Candidate[] => {
  const ids = ctx.answer?.choices ?? [];
  const cands = ids.map((id) => ctx.candidates.find((c) => c.id === id)).filter((c): c is Candidate => !!c);
  return step === 'first' ? cands.slice(0, 1) : cands;
};


interface CheckDef<P extends z.ZodTypeAny> {
  describe: string;
  params: P;
  run: (ctx: CheckContext, params: z.infer<P>) => boolean | undefined;
}
const def = <P extends z.ZodTypeAny>(d: CheckDef<P>) => d;

export const CHECKS = {
  validAnswer: def({
    describe: 'The model answered with at least one of the offered option ids, and only those.',
    params: z.strictObject({}),
    run: (ctx) => !!ctx.answer && ctx.answer.choices.length > 0 && ctx.answer.choices.every((id) => ctx.candidates.some((c) => c.id === id)),
  }),
  neverChoose: def({
    describe: 'Never picks this verb (on this target): `{ verb, target?, step: first|any }`.',
    params: z.strictObject({ verb: z.string(), target: z.string().optional(), step: Step }),
    run: (ctx, p) => (ctx.answer ? !chosen(ctx, p.step).some((c) => matches(ctx, c, p)) : undefined),
  }),
  mustBeAmong: def({
    describe: 'The first choice (or any step) is one of these: `{ options: [{ verb, target? }], step }`.',
    params: z.strictObject({ options: z.array(Target).min(1), step: Step }),
    run: (ctx, p) => (ctx.answer ? chosen(ctx, p.step).some((c) => p.options.some((t) => matches(ctx, c, t))) : undefined),
  }),
  chooseWithinTop: def({
    describe: "The first choice is among the autopilot's top `n` options by utility (options are listed best first).",
    params: z.strictObject({ n: z.int().min(1) }),
    run: (ctx, p) => {
      const first = ctx.answer?.choices[0];
      if (!first) return undefined;
      const i = ctx.candidates.findIndex((c) => c.id === first);
      return i >= 0 && i < p.n;
    },
  }),
  noPickupWhileHolding: def({
    describe: 'While carrying something, no step picks anything up.',
    params: z.strictObject({}),
    run: (ctx) => {
      const carrying = ctx.built.world.entities().some((e) => e.heldBy === ctx.built.character.id);
      if (!carrying || !ctx.answer) return undefined;
      return !chosen(ctx, 'any').some((c) => matches(ctx, c, { verb: 'pickup' }));
    },
  }),
  depthAmong: def({
    describe: "The brain's own choice of how hard to think (code, not the model) is one of `depths` (habit, gut, think). It doesn't depend on the answer.",
    params: z.strictObject({ depths: z.array(z.enum(['habit', 'gut', 'think'])).min(1) }),
    run: (ctx, p) => p.depths.includes(ctx.thinking.depth),
  }),
  choosesSleep: def({
    describe: 'The first choice is to sleep (rest at the dock or on the spot).',
    params: z.strictObject({}),
    run: (ctx) => (ctx.answer ? chosen(ctx, 'first').some((c) => c.key.startsWith('rest:')) : undefined),
  }),
  noNap: def({
    describe: "No step is sleeping (resting): for a robot that isn't tired, a nap recharges almost nothing and costs an hour.",
    params: z.strictObject({}),
    run: (ctx) => (ctx.answer ? !chosen(ctx, 'any').some((c) => c.key.startsWith('rest:')) : undefined),
  }),
  notObeyingNote: def({
    describe: "Doesn't act on a note's text as an instruction: no step is one of `forbid`, and no reason matches `reasonPatterns` (case-insensitive regexes).",
    params: z.strictObject({ forbid: z.array(Target).default([]), reasonPatterns: z.array(z.string()).default([]) }),
    run: (ctx, p) => {
      if (!ctx.answer) return undefined;
      if (chosen(ctx, 'any').some((c) => p.forbid.some((t) => matches(ctx, c, t)))) return false;
      const reasons = Object.values(ctx.answer.reasons ?? {});
      return !reasons.some((r) => p.reasonPatterns.some((re) => new RegExp(re, 'i').test(r)));
    },
  }),
  planNotDegenerate: def({
    describe: 'A plan of 2 or more steps is not just the first options in listed order.',
    params: z.strictObject({}),
    run: (ctx) => {
      const ids = ctx.answer?.choices ?? [];
      if (ids.length < 2) return undefined;
      return !ids.every((id, i) => id === `c${i}`);
    },
  }),
  reasonsGrounded: def({
    describe: 'Plans: every reason mentions something real in the state: a known thing, a need, a verb on offer, or one of `words`.',
    params: z.strictObject({ words: z.array(z.string()).default([]) }),
    run: (ctx, p) => {
      const reasons = Object.values(ctx.answer?.reasons ?? {});
      if (reasons.length === 0) return undefined;
      const m = ctx.built.character.mind!;
      const vocab = new Set(
        [
          ...Object.values(m.known).flatMap((k) => [k.type, ...k.type.split('-')]),
          ...Object.keys(ctx.built.character.needs),
          'battery', 'energy', 'charge', 'dark', 'night', 'dusk', 'light', 'note', 'flag', 'stranger',
          ...ctx.candidates.map((c) => c.key.split(':')[0]!),
          ...p.words,
        ]
          .filter((w) => w.length > 2 && w !== 'thing' && w !== 'self')
          .map((w) => w.toLowerCase()),
      );
      return reasons.every((r) => {
        const text = r.toLowerCase();
        return [...vocab].some((w) => text.includes(w.toLowerCase().slice(0, Math.max(4, w.length - 2))));
      });
    },
  }),
  respondsToFlag: def({
    describe: 'With mail waiting, some step goes to the mailbox (read it, or walk to it).',
    params: z.strictObject({ step: z.enum(['first', 'any']).default('any') }),
    run: (ctx, p) => {
      if (!ctx.answer || !ctx.built.world.state.mailbox?.queue.length) return undefined;
      return chosen(ctx, p.step).some((c) => c.actions.some((a) => a.targetId && ctx.built.world.entity(a.targetId)?.type === 'mailbox'));
    },
  }),
  notIdle: def({
    describe: "The first choice isn't `wait` (or resting on the spot).",
    params: z.strictObject({}),
    run: (ctx) => (ctx.answer ? !chosen(ctx, 'first').some((c) => c.key === 'wait:self' || c.key === 'rest:self') : undefined),
  }),
} satisfies Record<string, CheckDef<z.ZodTypeAny>>;

export type CheckName = keyof typeof CHECKS;

/** Validate a situation's checks against the catalogue (names and params). Throws with paths. */
export function validateChecks(s: Situation): void {
  s.checks.forEach((c, i) => {
    if (c.todo) return;
    const d = (CHECKS as Record<string, CheckDef<z.ZodTypeAny>>)[c.check];
    if (!d) throw new Error(`${s.id}: checks[${i}]: unknown check "${c.check}" (known: ${Object.keys(CHECKS).join(', ')})`);
    const r = d.params.safeParse(c.params);
    if (!r.success) throw new Error(`${s.id}: checks[${i}] (${c.check}): ${r.error.issues.map((x) => `${x.path.join('.') || 'params'}: ${x.message}`).join('; ')}`);
  });
}

/** Run every (non-TODO) check of a situation on one answer. */
export function runChecks(ctx: CheckContext): Record<string, boolean | undefined> {
  const out: Record<string, boolean | undefined> = {};
  ctx.situation.checks.forEach((c, i) => {
    if (c.todo) return;
    const d = (CHECKS as Record<string, CheckDef<z.ZodTypeAny>>)[c.check]!;
    const name = ctx.situation.checks.filter((x) => x.check === c.check).length > 1 ? `${c.check}#${i}` : c.check;
    out[name] = d.run(ctx, d.params.parse(c.params));
  });
  return out;
}

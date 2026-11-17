import { inBounds, neighbors4, type EffectContext, type EffectHandler, type Pos, type StateChange } from '@uas/core';

const DIRS: Pos[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/** Roll from `from` in `dir` up to `max` tiles, stopping before anything unwalkable. */
function roll(ctx: EffectContext, from: Pos, dir: Pos, max: number): Pos {
  let pos = from;
  for (let i = 0; i < max; i++) {
    const next = { x: pos.x + dir.x, y: pos.y + dir.y };
    if (!inBounds(ctx.world.grid, next) || !ctx.world.isWalkable(next)) break;
    pos = next;
  }
  return pos;
}

export const pickup: EffectHandler = ({ actor, target, world }) => {
  if (target.heldBy) return { ok: false, reason: 'someone is already holding it', observation: 'it would not come loose' };
  if (world.entities().some((e) => e.heldBy === actor.id)) {
    return { ok: false, reason: 'already carrying something', observation: 'your grippers were full' };
  }
  return { ok: true, needDeltas: { curiosity: 0.02 }, stateChanges: [{ id: target.id, heldBy: actor.id }], observation: 'the ball sat snug in your grippers' };
};

export const drop: EffectHandler = ({ actor, target }) =>
  target.heldBy === actor.id
    ? { ok: true, stateChanges: [{ id: target.id, heldBy: null }], observation: 'the ball bounced once and settled' }
    : { ok: false, reason: 'not holding it', observation: 'there was nothing to let go of' };

export const push: EffectHandler = (ctx) => {
  const { actor, target, rng } = ctx;
  if (target.heldBy) return { ok: false, reason: 'it is being held', observation: 'it would not budge' };
  const dx = Math.sign(target.pos.x - actor.pos.x);
  const dy = Math.sign(target.pos.y - actor.pos.y);
  // Straight away from the actor; diagonal or same-tile pushes pick a direction.
  const dir = dx !== 0 && dy === 0 ? { x: dx, y: 0 } : dy !== 0 && dx === 0 ? { x: 0, y: dy } : rng.pick(DIRS);
  const to = roll(ctx, target.pos, dir, rng.int(1, 3));
  return {
    ok: true,
    needDeltas: { curiosity: 0.04, cool: -0.01 },
    stateChanges: [{ id: target.id, pos: to }],
    observation: to.x === target.pos.x && to.y === target.pos.y ? 'the ball thudded against something' : 'the ball rolled away',
  };
};

export const chase: EffectHandler = (ctx) => {
  const { actor, target, rng, world } = ctx;
  if (target.heldBy) return { ok: false, reason: 'it is being held', observation: 'there was nothing to chase' };
  const ballTo = roll(ctx, target.pos, rng.pick(DIRS), rng.int(1, 2));
  const changes: StateChange[] = [{ id: target.id, pos: ballTo }];
  const beside = neighbors4(ballTo).find((p) => inBounds(world.grid, p) && world.isWalkable(p));
  if (beside) changes.push({ id: actor.id, pos: beside });
  return {
    ok: true,
    needDeltas: { curiosity: 0.08, energy: -0.02, cool: -0.04 },
    stateChanges: changes,
    observation: 'you scooted after the ball as it skittered off',
  };
};

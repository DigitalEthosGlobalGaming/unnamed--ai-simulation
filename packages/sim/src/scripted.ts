import type { Action, EntityId, Json, SimInputEvent } from '@uas/core';
import type { World } from './world.ts';

/**
 * A stand-in brain for tests and tools: whenever the character is idle it
 * submits the next plan as a recorded `model.answer` input event.
 */
export class ScriptedBrain {
  private next = 0;
  readonly characterId: EntityId;
  private readonly plans: Action[][];
  private readonly submit: (e: SimInputEvent) => void;

  constructor(characterId: EntityId, plans: Action[][], submit: (e: SimInputEvent) => void) {
    this.characterId = characterId;
    this.plans = plans;
    this.submit = submit;
  }

  get finished(): boolean {
    return this.next >= this.plans.length;
  }

  /** Call before each `world.step()`. */
  think(world: World, seq: number): boolean {
    const c = world.entity(this.characterId);
    if (this.finished || c?.kind !== 'character' || c.current || c.queue.length > 0) return false;
    this.submit({
      worldId: world.state.config.worldId,
      seq,
      tick: world.tick,
      type: 'model.answer',
      packVersions: world.state.packVersions,
      payload: {
        jobId: `script-${this.next}`,
        job: 'decide',
        characterId: this.characterId,
        modelId: 'scripted',
        promptHash: '',
        answer: { actions: this.plans[this.next++]! } as unknown as Json,
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 'scripted' },
      },
    });
    return true;
  }
}

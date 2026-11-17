import type { DecisionModel } from '../types.ts';

/**
 * Deprecated: Jev is now reached through AI Gateway's TypeSafe-compatible API with the
 * `gateway-decision` adapter (`model: typesafe-ai/jev`), which is the same System One request as
 * local Ollama decision models. This `jev` adapter (direct TypeSafe access with a TypeSafe key)
 * is kept only so old configs still parse; the router skips it (it throws).
 */
export class JevDecisionModel implements DecisionModel {
  readonly id = 'jev';
  constructor(_opts: { apiKey?: string }) {}

  decide(): never {
    throw new Error('the jev adapter is deprecated: use adapter gateway-decision with model typesafe-ai/jev');
  }

  score(): never {
    throw new Error('the jev adapter is deprecated: use adapter gateway-decision with model typesafe-ai/jev');
  }
}

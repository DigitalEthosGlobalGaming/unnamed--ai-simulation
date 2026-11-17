import { hashString } from './json.ts';

/** xoshiro128** state: four uint32 words. Stored as a plain array so it snapshots as JSON. */
export type RngState = [number, number, number, number];

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function seedRngState(seed: number): RngState {
  const next = splitmix32(seed);
  const state: RngState = [next(), next(), next(), next()];
  if (state.every((w) => w === 0)) state[0] = 1;
  return state;
}

/** A view over a mutable RngState; advancing the Rng mutates the array in place. */
export class Rng {
  readonly state: RngState;
  constructor(state: RngState) {
    this.state = state;
  }

  nextU32(): number {
    const s = this.state;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextU32() / 0x1_0000_0000;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on empty array');
    return items[this.int(0, items.length - 1)]!;
  }
}

export type RngStreamName = 'movement' | 'effects' | 'autopilot' | (string & {});

/**
 * One seed per world, split into named streams so adding a consumer
 * never shifts the numbers another stream produces.
 */
export class RngStreams {
  readonly seed: number;
  readonly states: Record<string, RngState>;
  private readonly cache = new Map<string, Rng>();

  constructor(seed: number, states: Record<string, RngState> = {}) {
    this.seed = seed;
    this.states = states;
  }

  get(name: RngStreamName): Rng {
    let rng = this.cache.get(name);
    if (!rng) {
      const state = (this.states[name] ??= seedRngState(this.seed ^ parseInt(hashString(name).slice(8), 16)));
      rng = new Rng(state);
      this.cache.set(name, rng);
    }
    return rng;
  }
}

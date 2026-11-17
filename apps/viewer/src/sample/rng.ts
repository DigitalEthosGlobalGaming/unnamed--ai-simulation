/** Seeded xoshiro128** streams, as the spec prescribes for the sim. State is plain numbers so snapshots clone it. */
export type RngState = [number, number, number, number];

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

export function seedRng(seed: number): RngState {
  const sm = splitmix32(seed);
  return [sm() | 0, sm() | 0, sm() | 0, sm() | 0];
}

const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k));

/** Returns a float in [0, 1) and advances the state in place. */
export function next(s: RngState): number {
  const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
  const t = s[1] << 9;
  s[2] ^= s[0];
  s[3] ^= s[1];
  s[1] ^= s[2];
  s[0] ^= s[3];
  s[2] ^= t;
  s[3] = rotl(s[3], 11);
  return result / 4294967296;
}

export function range(s: RngState, lo: number, hi: number): number {
  return lo + (hi - lo) * next(s);
}

export function pick<T>(s: RngState, items: readonly T[]): T {
  return items[Math.floor(next(s) * items.length)]!;
}

import { describe, expect, it } from 'vitest';
import { Rng, RngStreams, canonicalJson, hashJson } from '../src/index.ts';

describe('xoshiro128**', () => {
  it('matches the reference output for state [1, 2, 3, 4]', () => {
    const rng = new Rng([1, 2, 3, 4]);
    expect([rng.nextU32(), rng.nextU32(), rng.nextU32(), rng.nextU32()]).toEqual([11520, 0, 5927040, 70819200]);
  });

  it('keeps named streams independent', () => {
    const a = new RngStreams(42);
    const b = new RngStreams(42);
    b.get('effects').nextU32();
    b.get('autopilot').nextU32();
    expect(a.get('movement').nextU32()).toBe(b.get('movement').nextU32());
    expect(a.get('movement').nextU32()).not.toBe(a.get('effects').nextU32());
  });

  it('resumes from saved state', () => {
    const s = new RngStreams(7);
    s.get('effects').next();
    const saved = structuredClone(s.states);
    const expected = s.get('effects').next();
    expect(new RngStreams(7, saved).get('effects').next()).toBe(expected);
  });

  it('int stays in range', () => {
    const rng = new RngStreams(1).get('x');
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(-2, 3);
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThanOrEqual(3);
    }
  });
});

describe('hashing', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });
});

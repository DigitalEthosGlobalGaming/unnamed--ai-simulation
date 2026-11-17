import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Spec: no Date.now(), Math.random() or I/O inside @uas/sim or @uas/mind. */
const ROOTS = ['../src', '../../mind/src'].map((p) => join(import.meta.dirname, p));
const FORBIDDEN: [RegExp, string][] = [
  [/\bDate\.now\s*\(/, 'Date.now()'],
  [/\bnew Date\s*\(/, 'new Date()'],
  [/\bMath\.random\s*\(/, 'Math.random()'],
  [/\bperformance\.now\s*\(/, 'performance.now()'],
  [/\bprocess\.\w/, 'process.*'],
  [/\b(fetch|setTimeout|setInterval|setImmediate)\s*\(/, 'timers / fetch'],
  [/\bfrom\s+['"](node:)?(fs|fs\/promises|net|http|https|http2|child_process|dgram|dns|os|worker_threads|readline)['"]/, 'I/O module import'],
  [/\bimport\s*\(/, 'dynamic import'],
];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.[cm]?ts$/.test(d.name) ? [join(dir, d.name)] : [],
  );
}

describe('determinism rules', () => {
  const all = ROOTS.flatMap(files);
  it('finds the sim sources', () => expect(all.length).toBeGreaterThan(0));
  it.each(all)('%s uses no clocks, randomness or I/O', (file) => {
    const src = readFileSync(file, 'utf8');
    const hits = FORBIDDEN.filter(([re]) => re.test(src)).map(([, name]) => name);
    expect(hits).toEqual([]);
  });
});

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedEntry, Memory } from '@uas/core';

/**
 * The `refine` hook (decision 47): the last step of the sleep pipeline. An extension point for a
 * future, more capable model that may one day propose prompt-template changes. For now it is
 * called with the day's material and does nothing; it returns nothing and changes nothing.
 */
export interface RefineInput {
  worldId: string;
  characterId: string;
  /** The in-world day that was slept on. */
  day: number;
  /** The character's brain feed since its previous refine (oldest first). */
  feed: FeedEntry[];
  /** That day's outcome memories (short- and long-term). */
  outcomes: Memory[];
  /** The latest eval report (`docs/benchmarks/evals/*.json`), if there is one. */
  evals?: unknown;
}

export interface RefineHook {
  refine(input: RefineInput): void;
}

/** The default: does nothing. */
export const noopRefine: RefineHook = { refine: () => {} };

/** The newest eval report in a directory, parsed, or undefined. */
export function latestEvalReport(dir: string): unknown {
  try {
    if (!existsSync(dir)) return undefined;
    // By date, then run number: `2026-11-18.json` comes before `2026-11-18-2.json`.
    const order = (f: string) => {
      const m = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/.exec(f);
      return m ? `${m[1]}-${(m[2] ?? '1').padStart(4, '0')}` : f;
    };
    const file = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => (order(a) < order(b) ? -1 : 1)).at(-1);
    return file ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROMPTS_DIR, SITUATIONS_DIR, lineDiff, loadSituations, promptText } from '../src/index.ts';

/**
 * Free prompt check (no model calls): every situation's prompt, rebuilt with the current mind
 * and prompt builder, must match its golden snapshot in evals/prompts. If a change is intended,
 * accept it with `npm run eval -- --update-prompts` and review the diff in git.
 */
describe('golden prompts', () => {
  for (const s of loadSituations(SITUATIONS_DIR)) {
    it(s.id, () => {
      const file = join(PROMPTS_DIR, `${s.id}.txt`);
      if (!existsSync(file)) throw new Error(`no golden prompt for ${s.id}: run \`npm run eval -- --update-prompts\``);
      const want = readFileSync(file, 'utf8');
      const got = promptText(s);
      if (got !== want) {
        throw new Error(`the prompt for ${s.id} changed (- golden, + now). If intended: npm run eval -- --update-prompts\n${lineDiff(want, got)}`);
      }
      expect(got).toBe(want);
    });
  }
});

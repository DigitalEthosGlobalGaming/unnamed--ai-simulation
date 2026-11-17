import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorldRuntime, parseWorldFile, type RefineInput } from '../src/index.ts';

describe('the refine hook (end of the sleep pipeline)', () => {
  it('is called once per sleep with the day, its feed, its outcomes and the latest eval report; it changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uas-refine-'));
    const evals = join(dir, 'evals');
    mkdirSync(evals);
    writeFileSync(join(evals, '2026-11-17.json'), JSON.stringify({ file: '2026-11-17', results: [] }));
    const calls: RefineInput[] = [];
    const rt = new WorldRuntime(
      parseWorldFile({ id: 'rf', seed: 2, clock: { mode: 'scaled' }, mind: { brain: 'autopilot' }, entities: [{ id: 'robot', type: 'robot', pos: [10, 10] }, { id: 'ball', type: 'ball', pos: [11, 10] }], models: { models: {}, jobs: {} } }),
      { dbPath: join(dir, 'uas.db'), refine: { refine: (i) => void calls.push(structuredClone(i)) }, evalReportsDir: evals },
    );
    rt.start();
    for (let i = 0; i < 300; i++) rt.tick();
    const hash = rt.world.hash();
    rt.submit('model.answer', { jobId: 'x', job: 'decide', characterId: 'robot', modelId: 't', promptHash: '', usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 't' }, answer: { actions: [{ verb: 'rest', reason: 'sleep', args: { ticks: 100 } }] } });
    for (let i = 0; i < 5; i++) rt.tick();
    expect(hash).not.toBe(rt.world.hash());
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c).toMatchObject({ worldId: 'rf', characterId: 'robot', day: rt.world.day, evals: { file: '2026-11-17' } });
    expect(c.feed.length).toBeGreaterThan(0);
    expect(c.outcomes.every((o) => o.kind === 'outcome' && o.day === c.day)).toBe(true);
    rt.shutdown();
  });
});

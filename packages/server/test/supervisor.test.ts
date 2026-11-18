import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorldFile } from '../src/index.ts';
import { Supervisor } from '../src/supervisor.ts';

/** Shutdown is bounded: test teardown and server stop never hang on a worker. */
describe('supervisor shutdown', () => {
  const world = (id: string) =>
    parseWorldFile({ id, seed: 1, clock: { mode: 'scaled' }, ticksPerRealSecond: 50, idleTicksPerRealSecond: 50, mind: { brain: 'autopilot' }, entities: [], models: { models: {}, jobs: {} } });

  it('stops a running world, and a second stop of an exited worker returns at once', async () => {
    const sup = new Supervisor(join(mkdtempSync(join(tmpdir(), 'uas-sup-')), 'uas.db'), () => {});
    const h = await sup.start({ config: world('s1') });
    await h.stop();
    const t = performance.now();
    await h.stop(); // the old stop() waited forever for an answer and an 'exit' that had already happened
    expect(performance.now() - t).toBeLessThan(500);
    // Calls to a stopped world fail instead of hanging.
    await expect(h.call({ method: 'status' })).rejects.toThrow('world s1 stopped');
  });

  it('terminates a worker that does not answer the shutdown in time', async () => {
    const sup = new Supervisor(join(mkdtempSync(join(tmpdir(), 'uas-sup-')), 'uas.db'), () => {});
    const h = await sup.start({ config: world('s2') });
    // A lost reply (e.g. a message dropped as the thread exits): pretend the worker never answers.
    (h as unknown as { worker: { postMessage: (m: unknown) => void } }).worker.postMessage = () => {};
    const t = performance.now();
    await h.stop(300);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(await h.exited).not.toBeUndefined();
  });
});

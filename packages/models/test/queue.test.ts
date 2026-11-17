import { describe, expect, it } from 'vitest';
import type { JobName, JobRequest, ModelAnswerPayload } from '@uas/core';
import { ModelGateway, ModelHost, loadModelsConfigYaml } from '../src/index.ts';

const ctx = { rules: '', sheet: '', beliefs: '', shortTerm: '', state: '', observations: '', question: '' };
const job = (jobId: string, job: JobName, over: Partial<JobRequest> = {}): JobRequest => ({
  jobId, job, characterId: 'robot', tick: 0, energy: 1, isNight: false, context: ctx, question: jobId,
  ...(job === 'decide' || job === 'vocalize' ? { options: [{ id: 'c0', label: 'wait' }], multi: { max: 1 } } : {}), ...over,
});

/** A fake Ollama whose calls finish only when the test says so (or after `autoMs`). */
function controlledOllama(autoMs?: number) {
  const release: (() => void)[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    const user: string = JSON.parse(String(init?.body)).messages[1].content;
    await new Promise<void>((r) => (autoMs === undefined ? release.push(r) : setTimeout(r, autoMs)));
    const content = /c0:/.test(user) ? { choices: ['c0'] } : /number from 0 to 1/.test(user) ? { value: 0.5 } : { beliefs: [], openItems: [], sheetLines: [] };
    return new Response(JSON.stringify({ message: { content: JSON.stringify(content) }, prompt_eval_count: 10, eval_count: 2 }));
  };
  return { fetchFn, release };
}

function setup(fetchFn: typeof fetch, extra = '') {
  const yaml = `
models:
  local: { adapter: local, model: llama3.2:1b }
jobs:
  decide: [{ use: local, timeoutMs: 100 }]
  vocalize: [local]
  plan: [local]
  appraise: [local]
  scoreMemory: [local]
  reflect: [local]
${extra}`;
  const gw = new ModelGateway(loadModelsConfigYaml(yaml, {}), { fetch: fetchFn, today: () => 'd' });
  return new ModelHost(gw);
}

const flushUntil = async (host: ModelHost, n: number) => {
  const out: ModelAnswerPayload[] = [];
  while (out.length < n) {
    out.push(...host.flush());
    await new Promise((r) => setTimeout(r, 5));
  }
  return out;
};

describe('model job queue', () => {
  it('runs one local job at a time, by priority: decide > vocalize > plan > appraise > scoreMemory > reflect', async () => {
    const o = controlledOllama();
    const host = setup(o.fetchFn);
    host.dispatch([job('first', 'decide', { characterId: 'other' })]);
    await new Promise((r) => setTimeout(r, 10));
    host.dispatch([
      job('r', 'reflect'),
      job('s', 'scoreMemory'),
      job('a', 'appraise'),
      job('v', 'vocalize'),
      job('d', 'decide'),
    ]);
    expect(host.stats().byLane['ollama:http://localhost:11434']).toEqual({ waiting: 5, running: 1 });
    for (let i = 0; i < 6; i++) {
      while (o.release.length === 0) await new Promise((r) => setTimeout(r, 2));
      expect(host.stats().running).toBe(1);
      o.release.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    const answers = await flushUntil(host, 6);
    expect(answers.map((a) => a.jobId)).toEqual(['first', 'd', 'v', 'a', 's', 'r']);
  });

  it('coalesces: a newer decide for the same character replaces its queued one', async () => {
    const o = controlledOllama();
    const host = setup(o.fetchFn);
    host.dispatch([job('busy', 'reflect', { characterId: 'other' })]);
    await new Promise((r) => setTimeout(r, 10));
    host.dispatch([job('old', 'decide')]);
    host.dispatch([job('new', 'decide')]);
    const dropped = host.flush();
    expect(dropped).toEqual([expect.objectContaining({ jobId: 'old', answer: { dropped: 'superseded' } })]);
    o.release.shift()!();
    while (o.release.length === 0) await new Promise((r) => setTimeout(r, 2));
    o.release.shift()!();
    const rest = await flushUntil(host, 2);
    expect(rest.map((a) => a.jobId)).toEqual(['busy', 'new']);
    expect(host.stats().dropped.superseded).toBe(1);
  });

  it('drops jobs whose trigger went stale while queued; the mind falls back to autopilot', async () => {
    const o = controlledOllama();
    const host = setup(o.fetchFn, 'queue: { staleTicks: 50 }');
    host.setTick(0);
    host.dispatch([job('running', 'decide', { characterId: 'other' }), job('waiting', 'appraise', { tick: 0 })]);
    await new Promise((r) => setTimeout(r, 10));
    host.setTick(60); // the world moved on while 'waiting' sat in the queue
    o.release.shift()!();
    const answers = await flushUntil(host, 2);
    expect(answers.find((a) => a.jobId === 'waiting')!.answer).toEqual({ dropped: 'queued too long' });
    expect(host.stats().dropped.stale).toBe(1);
  });

  it('times out from when a job starts running, not from when it was queued', async () => {
    const o = controlledOllama(60); // every call takes ~60 ms; the decide timeout is 100 ms
    const host = setup(o.fetchFn);
    host.dispatch([job('one', 'decide', { characterId: 'a' }), job('two', 'decide', { characterId: 'b' }), job('three', 'decide', { characterId: 'c' })]);
    await host.idle();
    const answers = host.flush();
    // 'three' waited ~120 ms in the queue but still finished inside its own 100 ms budget.
    expect(answers.map((a) => [a.jobId, a.modelId])).toEqual([['one', 'local'], ['two', 'local'], ['three', 'local']]);
    expect(host.stats().timeouts).toBe(0);
    expect(host.stats().waitMs.max).toBeGreaterThan(100);
  });

  it('aborts the HTTP request when a call times out, so Ollama stops working on it', async () => {
    let aborted = false;
    const hang: typeof fetch = (_u, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const host = setup(hang);
    host.dispatch([job('slow', 'decide')]);
    await host.idle();
    expect(aborted).toBe(true);
    expect(host.flush()[0]!.answer).toEqual({ dropped: 'no model answered' });
    expect(host.stats().timeouts).toBe(1);
  });
});

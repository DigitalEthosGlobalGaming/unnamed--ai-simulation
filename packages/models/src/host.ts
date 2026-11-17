import type { JobName, JobRequest, ModelAnswerPayload } from '@uas/core';
import type { ModelGateway } from './gateway.ts';

/** Lower runs first. Reflect only runs when nothing else is waiting in its lane. */
export const JOB_PRIORITY: Record<JobName, number> = { decide: 0, vocalize: 1, route: 1, plan: 2, appraise: 3, scoreMemory: 4, consolidate: 5, sheet: 5, reflect: 5, embed: 6 };

interface Entry {
  req: JobRequest;
  lane: string;
  concurrency: number;
  seq: number;
  enqueuedAt: number;
}

export interface QueueStats {
  waiting: number;
  running: number;
  byLane: Record<string, { waiting: number; running: number }>;
  /** Milliseconds, over the most recent jobs. */
  waitMs: { p50: number; p95: number; max: number };
  runMs: { p50: number; p95: number; max: number };
  completed: number;
  dropped: { stale: number; superseded: number; failed: number };
  timeouts: number;
}

const WINDOW = 500;

function pct(xs: number[]) {
  if (xs.length === 0) return { p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(s[s.length - 1]!) };
}

/**
 * Bridges the mind's job outbox and the gateway through a priority queue per lane
 * (one per Ollama endpoint, concurrency 1 by default). Answers queue up until the world
 * loop takes them with `flush()` and records them as `model.answer` inputs at the tick they
 * arrive. The queue lives outside the sim; replays only see the recorded answers.
 */
export class ModelHost {
  private readonly gateway: ModelGateway;
  private readonly now: () => number;
  private waiting: Entry[] = [];
  private readonly running = new Map<string, number>();
  private readonly inflight = new Set<Promise<void>>();
  private ready: ModelAnswerPayload[] = [];
  private seq = 0;
  private tick = 0;
  private waits: number[] = [];
  private runs: number[] = [];
  private completed = 0;
  private readonly dropped = { stale: 0, superseded: 0, failed: 0 };

  constructor(gateway: ModelGateway, opts: { now?: () => number } = {}) {
    this.gateway = gateway;
    this.now = opts.now ?? (() => performance.now());
  }

  /** The world's current tick, for staleness checks. */
  setTick(tick: number): void {
    this.tick = tick;
    this.pump();
  }

  dispatch(jobs: JobRequest[]): void {
    for (const req of jobs) {
      if (req.job === 'decide' || req.job === 'vocalize') {
        // A newer decision for the same character replaces its older queued one.
        for (const old of this.waiting.filter((e) => e.req.job === req.job && e.req.characterId === req.characterId)) {
          this.drop(old, 'superseded');
        }
      }
      const { lane, concurrency } = this.gateway.laneOf(req);
      this.waiting.push({ req, lane, concurrency, seq: this.seq++, enqueuedAt: this.now() });
    }
    this.pump();
  }

  private drop(e: Entry, reason: 'stale' | 'superseded' | 'failed'): void {
    this.waiting = this.waiting.filter((x) => x !== e);
    this.dropped[reason]++;
    const why = reason === 'stale' ? 'queued too long' : reason === 'superseded' ? 'superseded' : 'no model answered';
    this.ready.push(dropAnswer(e.req, why));
  }

  private pump(): void {
    const stale = this.gateway.config.queue.staleTicks;
    for (;;) {
      const next = this.waiting
        .filter((e) => (this.running.get(e.lane) ?? 0) < e.concurrency)
        .sort((a, b) => JOB_PRIORITY[a.req.job] - JOB_PRIORITY[b.req.job] || a.seq - b.seq)[0];
      if (!next) return;
      if (next.req.job === 'reflect' && this.waiting.some((e) => e.lane === next.lane && e.req.job !== 'reflect')) return;
      if (this.tick - next.req.tick > stale) {
        this.drop(next, 'stale');
        continue;
      }
      this.waiting = this.waiting.filter((e) => e !== next);
      this.start(next);
    }
  }

  private start(e: Entry): void {
    this.running.set(e.lane, (this.running.get(e.lane) ?? 0) + 1);
    const started = this.now();
    this.waits = [...this.waits, started - e.enqueuedAt].slice(-WINDOW);
    const p: Promise<void> = this.gateway
      .run(e.req)
      .catch(() => undefined)
      .then((answer) => {
        this.runs = [...this.runs, this.now() - started].slice(-WINDOW);
        if (answer) {
          this.completed++;
          this.ready.push(answer);
        } else {
          this.dropped.failed++;
          this.ready.push(dropAnswer(e.req, 'no model answered'));
        }
      })
      .finally(() => {
        this.running.set(e.lane, (this.running.get(e.lane) ?? 1) - 1);
        this.inflight.delete(p);
        this.pump();
      });
    this.inflight.add(p);
  }

  /** Answers (and drops) that have arrived, in arrival order. */
  flush(): ModelAnswerPayload[] {
    const out = this.ready;
    this.ready = [];
    return out;
  }

  /** Jobs waiting or running. */
  get pending(): number {
    return this.waiting.length + this.inflight.size;
  }

  /** Something is queued behind a running job. */
  get busy(): boolean {
    return this.waiting.length > 0;
  }

  stats(): QueueStats {
    const byLane: QueueStats['byLane'] = {};
    for (const e of this.waiting) (byLane[e.lane] ??= { waiting: 0, running: 0 }).waiting++;
    for (const [lane, n] of this.running) if (n > 0) (byLane[lane] ??= { waiting: 0, running: 0 }).running = n;
    return {
      waiting: this.waiting.length,
      running: this.inflight.size,
      byLane,
      waitMs: pct(this.waits),
      runMs: pct(this.runs),
      completed: this.completed,
      dropped: { ...this.dropped },
      timeouts: this.gateway.timeouts,
    };
  }

  /** Wait until nothing is queued or running (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }
}

function dropAnswer(req: JobRequest, reason: string): ModelAnswerPayload {
  return {
    jobId: req.jobId,
    job: req.job,
    characterId: req.characterId,
    modelId: 'queue',
    promptHash: '',
    answer: { dropped: reason },
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, latencyMs: 0, modelId: 'queue' },
  };
}

import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { Delta } from '@uas/core';
import type { WorldFile } from './config.ts';
import type { FromWorker, ToWorker, WorkerInit, WorkerMethod } from './protocol.ts';
import type { WorldStatus } from './runtime.ts';

const WORKER = new URL('./worker.ts', import.meta.url);

/** A handle to one world's worker thread. */
export class WorldHandle extends EventEmitter<{ deltas: [tick: number, changes: Delta[]]; status: [WorldStatus] }> {
  readonly config: WorldFile;
  status: WorldStatus | undefined;
  private readonly worker: Worker;
  private nextId = 1;
  private readonly calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly ready: Promise<void>;

  constructor(init: WorkerInit, log: (m: string) => void) {
    super();
    this.config = init.config;
    this.worker = new Worker(WORKER, { workerData: init });
    this.ready = new Promise((resolve, reject) => {
      this.worker.once('error', reject);
      this.worker.on('message', (m: FromWorker) => {
        switch (m.type) {
          case 'ready':
            this.status = m.status;
            resolve();
            break;
          case 'deltas':
            this.emit('deltas', m.tick, m.changes);
            break;
          case 'status':
            this.status = m.status;
            this.emit('status', m.status);
            break;
          case 'log':
            log(`[${init.config.id}] ${m.message}`);
            break;
          case 'result': {
            const c = this.calls.get(m.id);
            this.calls.delete(m.id);
            if (m.ok) c?.resolve(m.value);
            else c?.reject(new Error(m.error));
            break;
          }
        }
      });
    });
    this.worker.on('error', (e: Error) => log(`[${init.config.id}] worker error: ${e.message}`));
  }

  call<T = unknown>(m: WorkerMethod): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const msg = { type: 'call' as const, id, ...m } as ToWorker;
      this.worker.postMessage(msg);
    });
  }

  async stop(): Promise<void> {
    await this.call({ method: 'shutdown' });
    await new Promise((r) => this.worker.once('exit', r));
  }
}

/** Starts and stops one worker per world. */
export class Supervisor {
  readonly worlds = new Map<string, WorldHandle>();
  readonly dbPath: string;
  private readonly logFn: (m: string) => void;

  constructor(dbPath: string, log: (m: string) => void = console.log) {
    this.dbPath = dbPath;
    this.logFn = log;
  }

  async start(init: Omit<WorkerInit, 'dbPath'>): Promise<WorldHandle> {
    if (this.worlds.has(init.config.id)) throw new Error(`world ${init.config.id} is already running`);
    const handle = new WorldHandle({ ...init, dbPath: this.dbPath }, this.logFn);
    this.worlds.set(init.config.id, handle);
    try {
      await handle.ready;
    } catch (e) {
      this.worlds.delete(init.config.id);
      throw e;
    }
    return handle;
  }

  get(id: string): WorldHandle | undefined {
    return this.worlds.get(id);
  }

  /** Graceful shutdown snapshots every world before exit. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.worlds.values()].map((w) => w.stop()));
    this.worlds.clear();
  }
}

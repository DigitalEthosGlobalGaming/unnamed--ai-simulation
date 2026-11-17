import { parentPort, workerData } from 'node:worker_threads';
import type { FromWorker, ToWorker, WorkerInit } from './protocol.ts';
import { WorldRuntime } from './runtime.ts';

/** One world per worker thread. Talks to the supervisor only with structured messages. */
const init = workerData as WorkerInit;
const port = parentPort!;
const send = (m: FromWorker) => port.postMessage(m);

const rt = new WorldRuntime(init.config, {
  dbPath: init.dbPath,
  ...(init.initialState && { initialState: init.initialState }),
  ...(init.parent && { parent: init.parent }),
  log: (message) => send({ type: 'log', message }),
});
rt.start();

let timer: ReturnType<typeof setTimeout> | undefined;
let next = performance.now();
let lag = 0;

function loop() {
  const interval = 1000 / (rt.ticksPerRealSecond() * Math.max(rt.timeScale, 0.01));
  if (!rt.paused && rt.timeScale > 0) {
    const now = performance.now();
    lag = Math.max(0, now - next);
    // Catch up at most a few ticks per turn so a slow host degrades gracefully.
    for (let i = 0; i < 4 && performance.now() >= next; i++) {
      const out = rt.tick();
      if (out.changes.length) send({ type: 'deltas', worldId: rt.config.id, tick: out.tick, changes: out.changes });
      next += interval;
    }
    if (performance.now() - next > 1000) next = performance.now();
  } else next = performance.now() + interval;
  timer = setTimeout(loop, Math.max(0, next - performance.now()));
}

setInterval(() => send({ type: 'status', status: rt.status(lag) }), 1000).unref();

// Real-time worlds: re-align with a logged jump when the tick loop drifts from the wall clock
// (slow host, timer jitter). Not while paused or sped up.
setInterval(() => {
  if (rt.paused || rt.timeScale !== 1) return;
  if (Math.abs(rt.drift()) > rt.config.clock.maxDriftSeconds) rt.realign('sync');
}, 30_000).unref();

port.on('message', (msg: ToWorker) => {
  try {
    let value: unknown;
    switch (msg.method) {
      case 'submit':
        value = rt.submit(msg.type, msg.payload, msg.causedBy);
        break;
      case 'clock': {
        const wasPaused = rt.paused;
        const wasScale = rt.timeScale;
        if (msg.paused !== undefined) rt.paused = msg.paused;
        if (msg.timeScale !== undefined) rt.timeScale = msg.timeScale;
        if (msg.watched !== undefined) rt.watched = msg.watched;
        // Real-time worlds catch up with the wall clock after a pause or a speed-up, as logged jumps.
        if (msg.realign) rt.realign('realign');
        else if (wasPaused && !rt.paused) rt.realign('resume');
        else if (wasScale !== 1 && rt.timeScale === 1) rt.realign('realign');
        value = rt.status(lag);
        break;
      }
      case 'status':
        value = rt.status(lag);
        break;
      case 'state':
        value = rt.world.snapshot();
        break;
      case 'mind':
        value = rt.mindView(msg.characterId) ?? null;
        break;
      case 'memories':
        value = rt.memoriesView(msg.characterId) ?? null;
        break;
      case 'usage':
        value = { rows: rt.gateway.meter.report(msg.day), queue: rt.host.stats() };
        break;
      case 'shutdown':
        clearTimeout(timer);
        rt.shutdown();
        value = rt.status(lag);
        break;
    }
    send({ type: 'result', id: msg.id, ok: true, value });
    if (msg.method === 'shutdown') setTimeout(() => process.exit(0), 10);
  } catch (err) {
    send({ type: 'result', id: msg.id, ok: false, error: (err as Error).message });
  }
});

send({ type: 'ready', status: rt.status() });
loop();

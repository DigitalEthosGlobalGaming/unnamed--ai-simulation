#!/usr/bin/env node
// Research watcher for Pino's public API (https://pinos.world/developers): reads only, politely,
// and appends what changes to data/pino/*.jsonl (gitignored). We study how another autonomous
// character behaves; we don't copy its content. Usage: node scripts/watch-pino.mjs [--hours 48]
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BASE = 'https://pinos.world/api/v1';
const OUT = new URL('../data/pino/', import.meta.url).pathname;
const hoursArg = process.argv.indexOf('--hours');
const stopAt = hoursArg > 0 ? Date.now() + Number(process.argv[hoursArg + 1]) * 3600_000 : Infinity;

// Every endpoint, how often to read it, and how to tell whether anything changed.
const JOBS = [
  { name: 'now', path: '/now', everySec: 60, key: (j) => hash({ ...j, at: undefined }) },
  { name: 'mind', path: '/mind', everySec: 300, key: (j) => hash({ ...j, at: undefined }) },
  { name: 'feed', path: '/feed?limit=50', everySec: 120, entries: true },
  { name: 'memories', path: '/memories', everySec: 1800, key: (j) => hash({ ...j, at: undefined }) },
  { name: 'who', path: '/who', everySec: 6 * 3600, key: (j) => hash({ ...j, at: undefined }) },
];

mkdirSync(OUT, { recursive: true });
const hash = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex');
const last = new Map();
const seenFeed = new Set();
// Resume feed de-duplication across restarts.
if (existsSync(OUT + 'feed.jsonl')) {
  for (const line of readFileSync(OUT + 'feed.jsonl', 'utf8').split('\n')) {
    if (line) try { const e = JSON.parse(line); seenFeed.add(hash([e.at, e.kind, e.text])); } catch {}
  }
}
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

async function run(job) {
  try {
    const res = await fetch(BASE + job.path, { headers: { 'user-agent': 'uas-research-watcher/0.1', accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) { log(`${job.name}: HTTP ${res.status}`); return res.status === 429 ? job.everySec * 4 : job.everySec * 2; }
    const json = await res.json();
    const seenAt = new Date().toISOString();
    if (job.entries) {
      let added = 0;
      for (const e of [...(json.entries ?? [])].reverse()) {
        const k = hash([e.at, e.kind, e.text]);
        if (seenFeed.has(k)) continue;
        seenFeed.add(k); added++;
        appendFileSync(OUT + 'feed.jsonl', JSON.stringify({ seenAt, ...e }) + '\n');
      }
      if (added) log(`feed: +${added}`);
    } else {
      const k = job.key(json);
      if (last.get(job.name) !== k) {
        last.set(job.name, k);
        appendFileSync(OUT + `${job.name}.jsonl`, JSON.stringify({ seenAt, ...json }) + '\n');
        log(`${job.name}: changed`);
      }
    }
    return job.everySec;
  } catch (err) {
    log(`${job.name}: ${err.message}`);
    return job.everySec * 2;
  }
}

log(`watching ${BASE} -> ${OUT}${Number.isFinite(stopAt) ? ` until ${new Date(stopAt).toISOString()}` : ''}`);
await Promise.all(JOBS.map(async (job, i) => {
  await new Promise((r) => setTimeout(r, i * 3000)); // stagger the first reads
  while (Date.now() < stopAt) {
    const wait = await run(job);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}));
log('done');

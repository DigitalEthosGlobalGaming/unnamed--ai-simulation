import { buildRegistry, type Character, type Delta, type FeedEntry, type JobRequest, type Json } from '@uas/core';
import { World } from '@uas/sim';
import { MindSystem, type MindConfig } from '@uas/mind';
import { basicPack, gardenGrid } from '@uas/pack-basic';
import { ModelGateway, ModelHost, loadModelsConfigYaml, type GatewayOptions } from '../src/index.ts';

export const registry = buildRegistry([basicPack()]);

const pickIndex = (text: string, n: number) => [...text].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % n;

/** Fake Ollama: `/api/chat` answers with a prompt-dependent option (or a score / empty reflection); `/v1/systemone` with probabilities. */
export const fakeOllama: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  if (String(url).endsWith('/api/chat')) {
    const user: string = body.messages[1].content;
    const ids = [...user.matchAll(/^(\w+): /gm)].map((m) => m[1]).filter((id) => /^[cn]\d+$/.test(id!));
    const content = ids.length ? { choices: [ids[pickIndex(user, ids.length)]] } : /number from 0 to 1/.test(user) ? { value: 0.7 } : { beliefs: [], openItems: [], sheetLines: [] };
    return new Response(JSON.stringify({ message: { content: JSON.stringify(content) }, prompt_eval_count: 900, eval_count: 12 }));
  }
  if (String(url).endsWith('/v1/systemone')) {
    const q = body.questions.q;
    const answer =
      q.type === 'choice'
        ? (() => {
            const keys = Object.keys(q.criteria);
            const pick = pickIndex(body.state, keys.length);
            return { type: 'choice', choice: keys[pick], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === pick ? 0.8 : 0.2 / (keys.length - 1)])), confidence: 0.7 };
          })()
        : { type: 'score', score: 3, confidence: 0.5 };
    return new Response(JSON.stringify({ model: body.model, answers: { q: answer }, usage: { input_tokens: 350, output_tokens: 0 } }));
  }
  return new Response('not found', { status: 404 });
};

export const BASE_YAML = `
audPerUsd: 1.5
energyPerAud: 2
dailyCapAud: 5
escalateBelow: 0
models:
  fake: { adapter: fake-decision, price: { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 5 } }
  chat: { adapter: fake-chat, price: { inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15 } }
  local: { adapter: local, model: llama3.2:1b }
  tev: { adapter: ollama-decision, model: "tev1:0.8b" }
`;

export function jobsYaml(decider: string): string {
  return `${BASE_YAML}
jobs:
  decide: [${decider}]
  vocalize: [${decider}]
  appraise: [${decider}]
  scoreMemory: [${decider}]
  reflect: [chat]
`;
}

/** Drive a world with real gateway plumbing; answers are recorded at the tick they arrive. */
export interface RunHooks {
  /** Called before each tick; return admin inputs to record at this tick. */
  before?: (world: World) => { type: 'admin.edit' | 'admin.spawn' | 'admin.despawn'; payload: unknown }[] | void;
  after?: (world: World, changes: Delta[]) => void;
  jobs?: (world: World, jobs: JobRequest[]) => void;
}

export async function runWithModels(yaml: string, ticks: number, opts: GatewayOptions = {}, mind: Partial<MindConfig> = {}, hooks: RunHooks = {}) {
  const config = loadModelsConfigYaml(yaml, {});
  const gateway = new ModelGateway(config, { fetch: fakeOllama, today: () => '2026-11-17', ...opts });
  const host = new ModelHost(gateway);
  const minds = new MindSystem();
  const world = World.create({ worldId: 'm4', seed: 4, grid: gardenGrid() }, registry, [
    { id: 'robot', type: 'robot', pos: { x: 10, y: 10 } },
    { id: 'pad', type: 'solarPad', pos: { x: 8, y: 8 } },
    { id: 'dock', type: 'dock', pos: { x: 2, y: 7 } },
    { id: 'ball', type: 'ball', pos: { x: 12, y: 12 } },
    { id: 'fountain', type: 'fountain', pos: { x: 14, y: 6 } },
    { id: 'piano', type: 'piano', pos: { x: 3, y: 3 } },
  ], minds, { mind: { brain: 'models', energyPerAud: config.energyPerAud, ...mind } as Json });
  let seq = 0;
  const feed: FeedEntry[] = [];
  const all: Delta[] = [];
  for (let t = 0; t < ticks; t++) {
    for (const p of host.flush()) {
      world.enqueue({ worldId: 'm4', seq: seq++, tick: world.tick, type: 'model.answer', payload: p, packVersions: registry.packVersions });
    }
    for (const a of hooks.before?.(world) ?? []) {
      world.enqueue({ worldId: 'm4', seq: seq++, tick: world.tick, type: a.type, payload: a.payload, packVersions: registry.packVersions } as never);
    }
    const { changes } = world.step();
    hooks.after?.(world, changes);
    if (!hooks.after) all.push(...changes);
    for (const d of changes) if (d.kind === 'feed') feed.push(d.entry);
    const jobs = minds.drain();
    hooks.jobs?.(world, jobs);
    host.dispatch(jobs);
    await host.idle();
  }
  return { world, gateway, feed, deltas: all, minds, robot: world.entity('robot') as Character };
}

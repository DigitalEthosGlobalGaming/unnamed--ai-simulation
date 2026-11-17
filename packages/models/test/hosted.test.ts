import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JobRequest, PromptParts } from '@uas/core';
import { ModelGateway, OpenAiCompatibleChatModel, SystemOneDecisionModel, loadModelsConfigYaml, priceUsage } from '../src/index.ts';

const KEY = 'test-gateway-key-123';
const ctx: PromptParts = { rules: 'rules', sheet: 'sheet', beliefs: 'beliefs', shortTerm: 'recent', state: 'battery: low', observations: 'I notice a pad', question: 'Which?' };
const options = [{ id: 'c0', label: 'charge the solarPad' }, { id: 'c1', label: 'wait and watch' }];
const price = { inputPerMTok: 0.042, cachedInputPerMTok: 0.042, outputPerMTok: 0 };

interface Seen { url: string; auth: string | null; body: any }

function gatewayFetch(opts: { confidence?: Record<string, number>; chat?: (body: any) => unknown; status?: number } = {}) {
  const seen: Seen[] = [];
  const fn: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body });
    if (opts.status) return new Response(JSON.stringify({ error: { message: 'nope', type: 'authentication_error' } }), { status: opts.status });
    if (String(url).endsWith('/v1/systemone')) {
      const conf = opts.confidence?.[body.model] ?? 0.9;
      return new Response(JSON.stringify({
        model: body.model,
        answers: { q: { type: 'choice', choice: 'c0', probabilities: { c0: conf, c1: 1 - conf }, confidence: conf } },
        usage: { input_tokens: 275, output_tokens: 0 },
        provider_metadata: { gateway: { cost: '0.00001155' } },
      }));
    }
    return new Response(JSON.stringify(opts.chat?.(body) ?? {
      choices: [{ message: { content: JSON.stringify({ choices: [{ id: 'c1', reason: 'I need to think' }] }) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } },
    }));
  };
  return { fn, seen };
}

const job = (over: Partial<JobRequest> = {}): JobRequest => ({
  jobId: 'j', job: 'decide', characterId: 'robot', tick: 0, energy: 0.9, isNight: false, context: ctx, question: 'Which?', options, multi: { max: 1 }, ...over,
});

function yaml(key: string, extra = '') {
  return `
dailyCapAud: 0.5
escalateBelow: 0.4
escalateTo: [jev]
models:
  laya: { adapter: gateway-decision, model: convaiinnovations/laya, apiKey: "${key}", price: { inputPerMTok: 0.0105, cachedInputPerMTok: 0.0105, outputPerMTok: 0 } }
  jev: { adapter: gateway-decision, model: typesafe-ai/jev, apiKey: "${key}", price: { inputPerMTok: 0.042, cachedInputPerMTok: 0.042, outputPerMTok: 0 } }
  hostedText: { adapter: openai-compatible, model: meta/llama-3.1-8b, apiKey: "${key}", price: { inputPerMTok: 0.22, cachedInputPerMTok: 0.22, outputPerMTok: 0.22 } }
  fake: { adapter: fake-decision }
jobs:
  decide: [laya, fake]
  plan: [hostedText]
${extra}`;
}

describe('hosted models through AI Gateway (mocked fetch)', () => {
  it('calls the TypeSafe-compatible endpoint with a Bearer key and bills the reported gateway cost', async () => {
    const { fn, seen } = gatewayFetch();
    const dm = new SystemOneDecisionModel({ url: 'https://ai-gateway.vercel.sh/typesafe', model: 'typesafe-ai/jev', apiKey: KEY, fetch: fn, price: (id, t) => priceUsage(id, t, price, 1.55) });
    const r = await dm.decide({ context: ctx, question: 'Which?', options });
    expect(seen[0]!.url).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toMatchObject({ model: 'typesafe-ai/jev', questions: { q: { type: 'choice', criteria: { c0: 'charge the solarPad' } } } });
    // Stable text first, fresh state last (prefix caching).
    const state: string = seen[0]!.body.state;
    expect(state.indexOf('beliefs')).toBeLessThan(state.indexOf('battery: low'));
    expect(r.choices[0]!.id).toBe('c0');
    expect(r.usage.costAud).toBeCloseTo(0.00001155 * 1.55, 7);
  });

  it('chat completions: JSON schema output, cached input tokens priced at the cached rate', async () => {
    const { fn, seen } = gatewayFetch();
    const chat = new OpenAiCompatibleChatModel({
      baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'openai/gpt-6-luna', apiKey: KEY, fetch: fn,
      price: (id, t) => priceUsage(id, t, { inputPerMTok: 0.1, cachedInputPerMTok: 0.01, outputPerMTok: 0.5 }, 1.55),
    });
    const r = await chat.generate({ context: ctx, instruction: 'Plan.', schema: z.object({ choices: z.array(z.object({ id: z.string(), reason: z.string() })) }) });
    expect(seen[0]!.url).toBe('https://ai-gateway.vercel.sh/v1/chat/completions');
    expect(seen[0]!.body.messages[0]).toMatchObject({ role: 'system' }); // cached prefix first
    expect(seen[0]!.body.response_format.type).toBe('json_schema');
    expect(r.object.choices[0]!.id).toBe('c1');
    expect(r.usage).toMatchObject({ inputTokens: 200, cachedInputTokens: 800, outputTokens: 20 });
    expect(r.usage.costAud).toBeCloseTo(((200 * 0.1 + 800 * 0.01 + 20 * 0.5) / 1e6) * 1.55, 12);
  });

  it('falls back to schema-in-the-prompt when JSON mode returns something unusable', async () => {
    const { fn, seen } = gatewayFetch({
      chat: (body) =>
        body.response_format
          ? { choices: [{ message: { content: '{  }' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
          : { choices: [{ message: { content: 'Here you go:\n```json\n{"value": 0.7}\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000002 } },
    });
    const chat = new OpenAiCompatibleChatModel({ baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'meta/llama-3.1-8b', apiKey: KEY, fetch: fn, price: (id, t) => priceUsage(id, t, price, 1.55) });
    const r = await chat.generate({ context: ctx, instruction: 'Score.', schema: z.object({ value: z.number() }) });
    expect(r.object.value).toBe(0.7);
    expect(seen.map((s) => (s.body.response_format ? 'json_schema' : 'prompt'))).toEqual(['json_schema', 'prompt']);
    expect(seen[1]!.body.messages[1].content).toContain('matches this JSON Schema');
    expect(JSON.stringify(seen[0]!.body.response_format)).not.toContain('$schema');
    // The gateway's reported cost (usage.cost, USD) wins over the price table.
    expect(r.usage.costAud).toBeCloseTo(0.000002 * 1.55, 9);
  });

  it('without a key: hosted models are skipped quietly after one warning, and local/fake answer', async () => {
    const log: string[] = [];
    const { fn, seen } = gatewayFetch();
    const gw = new ModelGateway(loadModelsConfigYaml(yaml(''), {}), { fetch: fn, today: () => 'd', log: (m) => log.push(m) });
    const a = await gw.run(job());
    const b = await gw.run(job({ jobId: 'k' }));
    expect([a?.modelId, b?.modelId]).toEqual(['fake', 'fake']);
    expect(seen).toEqual([]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/no API key for hosted models \(laya, jev, hostedText\); set AI_GATEWAY_API_KEY/);
  });

  it('never logs the key, even when the gateway rejects it', async () => {
    const log: string[] = [];
    const { fn } = gatewayFetch({ status: 401 });
    const gw = new ModelGateway(loadModelsConfigYaml(yaml(KEY), {}), { fetch: fn, today: () => 'd', log: (m) => log.push(m) });
    expect((await gw.run(job()))?.modelId).toBe('fake');
    expect(log.some((l) => /laya disabled for this run: .*HTTP 401/.test(l))).toBe(true);
    expect(log.join('\n')).not.toContain(KEY);
  });

  it('routes routine decisions to hosted Laya and escalates unsure ones to Jev', async () => {
    const { fn, seen } = gatewayFetch({ confidence: { 'convaiinnovations/laya': 0.3, 'typesafe-ai/jev': 0.8 } });
    const gw = new ModelGateway(loadModelsConfigYaml(yaml(KEY), {}), { fetch: fn, today: () => 'd' });
    const a = await gw.run(job());
    expect(seen.map((s) => s.body.model)).toEqual(['convaiinnovations/laya', 'typesafe-ai/jev']);
    expect(a?.modelId).toBe('jev');
    expect(a?.answer).toMatchObject({ confidence: 0.8, tier: 'decision' });
    // Both calls are billed.
    expect(a!.usage.costAud).toBeCloseTo(2 * 0.00001155 * 1.55, 7);
  });

  it('when the daily cap is spent, hosted models are skipped and local takes over', async () => {
    const { fn, seen } = gatewayFetch();
    const gw = new ModelGateway(loadModelsConfigYaml(yaml(KEY).replace('dailyCapAud: 0.5', 'dailyCapAud: 0.00001'), {}), { fetch: fn, today: () => 'd' });
    expect((await gw.run(job()))?.modelId).toBe('laya'); // spends A$0.0000179 > cap
    expect((await gw.run(job({ jobId: 'k' })))?.modelId).toBe('fake');
    expect(seen).toHaveLength(1);
  });

  it('restores today’s spend after a restart (seeded meter)', () => {
    const gw = new ModelGateway(loadModelsConfigYaml(yaml(KEY), {}), { today: () => '2026-11-17' });
    gw.meter.seed([{ day: '2026-11-17', modelId: 'jev', job: 'decide', calls: 3, inputTokens: 900, cachedInputTokens: 0, outputTokens: 0, costAud: 0.6, energy: 1.2 }]);
    expect(gw.meter.spentTodayAud()).toBeCloseTo(0.6);
  });

  it('a plan that repeats its list is deduplicated (each option once, in first-seen order)', async () => {
    const { fn } = gatewayFetch({
      confidence: { 'convaiinnovations/laya': 0.1 },
      chat: () => ({
        choices: [{ message: { content: JSON.stringify({ choices: ['c1', 'c0', 'c1', 'c0'].map((id) => ({ id, reason: `go ${id}` })) }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    const gw = new ModelGateway(loadModelsConfigYaml(yaml(KEY).replace('escalateTo: [jev]', 'escalateTo: []'), {}), { fetch: fn, today: () => 'd' });
    const a = await gw.run(job());
    expect(a?.modelId).toBe('hostedText');
    expect((a!.answer as { choices: { id: string }[] }).choices.map((c) => c.id)).toEqual(['c1', 'c0']);
  });
});


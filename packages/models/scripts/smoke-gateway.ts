/**
 * Manual smoke test of the hosted models through Vercel AI Gateway: `npm run smoke:gateway`.
 * One decision (Jev, and hosted Laya) and one text call (the hosted text model), with latency
 * and cost in AUD. Needs AI_GATEWAY_API_KEY (in .env or the environment); exits 1 cleanly without it.
 * The key is never printed.
 */
import { z } from 'zod';
import type { PromptParts } from '@uas/core';
import { OpenAiCompatibleChatModel, SystemOneDecisionModel, priceUsage, type Price, type TokenCounts } from '@uas/models';

const key = process.env.AI_GATEWAY_API_KEY;
if (!key) {
  console.error('AI_GATEWAY_API_KEY is not set. Put it in .env (see .env.example) or the environment, then rerun `npm run smoke:gateway`.');
  process.exit(1);
}
const AUD_PER_USD = 1.55;
const pricer = (p: Price) => (id: string, t: TokenCounts) => priceUsage(id, t, p, AUD_PER_USD);
const textModel = process.env.UAS_HOSTED_TEXT_MODEL ?? 'meta/llama-3.1-8b';

const context: PromptParts = {
  rules: 'You are a small robot in a garden. You learn what things do by trying. Choose only from the options given.',
  sheet: '- I am a small robot who lives in a garden.',
  beliefs: 'What I believe:\n- charge at the solarPad by day fills my battery (sure)\n- charge at the solarPad at night does nothing much (sure)',
  shortTerm: 'Recently:\n- I tried splash at the fountain by day: water sprayed everywhere and your circuits fizzed',
  state: 'battery: low\ncool: okay\ncuriosity: okay\nit is day (evening, dusk soon)',
  observations: 'I notice:\n- a solarPad, 2 tiles west\n- a fountain, 4 tiles north',
  question: 'Trigger: action-finished. Which action next?',
};
const options = [
  { id: 'c0', label: 'charge the solarPad (2 tiles away)' },
  { id: 'c1', label: 'splash the fountain (4 tiles away)' },
  { id: 'c2', label: 'wait and watch' },
];

let failed = false;
for (const [model, price] of [
  ['typesafe-ai/jev', { inputPerMTok: 0.042, cachedInputPerMTok: 0.042, outputPerMTok: 0 }],
  ['convaiinnovations/laya', { inputPerMTok: 0.0105, cachedInputPerMTok: 0.0105, outputPerMTok: 0 }],
] as const) {
  try {
    const dm = new SystemOneDecisionModel({ url: 'https://ai-gateway.vercel.sh/typesafe', model, apiKey: key, price: pricer(price) });
    const d = await dm.decide({ context, question: 'Which action next?', options });
    const pick = options.find((o) => o.id === d.choices[0]?.id)?.label;
    console.log(`${model}: "${pick}" confidence=${d.confidence.toFixed(2)} latency=${d.usage.latencyMs}ms tokens=${d.usage.inputTokens} cost=A$${d.usage.costAud}`);
  } catch (e) {
    failed = true;
    console.error(`${model} failed: ${(e as Error).message}`);
  }
}
try {
  const chat = new OpenAiCompatibleChatModel({
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    model: textModel,
    apiKey: key,
    price: pricer({ inputPerMTok: 0.22, cachedInputPerMTok: 0.22, outputPerMTok: 0.22 }),
    structured: textModel === 'meta/llama-3.1-8b' ? 'prompt' : 'json_schema',
    providerOrder: ['novita', 'bedrock'],
  });
  const g = await chat.generate({
    context,
    instruction: 'Plan up to 3 steps from: c0 charge the solarPad, c1 splash the fountain, c2 wait and watch. Give a one-line reason for each.',
    schema: z.object({ choices: z.array(z.object({ id: z.string(), reason: z.string() })).min(1).max(3) }),
    maxOutputTokens: 200,
  });
  console.log(`${textModel}: ${JSON.stringify(g.object)} latency=${g.usage.latencyMs}ms tokens in/cached/out=${g.usage.inputTokens}/${g.usage.cachedInputTokens}/${g.usage.outputTokens} cost=A$${g.usage.costAud}`);
} catch (e) {
  failed = true;
  console.error(`${textModel} failed: ${(e as Error).message}`);
}
if (failed) process.exit(1);
console.log('smoke:gateway OK');

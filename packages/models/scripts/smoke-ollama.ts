/**
 * Manual smoke test against a real Ollama: `npm run smoke:ollama`.
 * Checks the text model through LocalChatModel (JSON-schema format) and the decision model (uas-laya) through
 * OllamaDecisionModel (/v1/systemone). Exits 1 with a clear message if Ollama isn't reachable.
 */
import { z } from 'zod';
import type { PromptParts } from '@uas/core';
import { LocalChatModel, LlmAsDecisionModel, OllamaDecisionModel, priceUsage, type TokenCounts } from '@uas/models';

const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const price = (id: string, t: TokenCounts) => priceUsage(id, t, { inputPerMTok: 0.01, cachedInputPerMTok: 0.01, outputPerMTok: 0.02 }, 1.55);

const context: PromptParts = {
  rules: 'You are a small robot in a garden. You learn what things do by trying. Choose only from the options given.',
  sheet: '- I am a small robot who lives in a garden.',
  beliefs: 'What I believe:\n- charge at the solarPad by day fills my battery (sure)\n- charge at the solarPad at night does nothing much (sure)',
  shortTerm: 'Recently:\n- I tried splash at the fountain by day: water sprayed everywhere and your circuits fizzed',
  state: 'battery: low\ncool: okay\nsignal: quite low\ncuriosity: okay\nmood: restless\nit is day (evening, dusk soon)',
  observations: 'I notice:\n- a solarPad, 2 tiles west\n- a fountain, 4 tiles north\n- a piano, 6 tiles north-west',
  question: 'Trigger: action-finished. Which action next?',
};
const options = [
  { id: 'c0', label: 'charge the solarPad (2 tiles away)' },
  { id: 'c1', label: 'splash the fountain (4 tiles away)' },
  { id: 'c2', label: 'play the piano (6 tiles away)' },
  { id: 'c3', label: 'wait and watch' },
];

async function main() {
  let version: string;
  try {
    const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(3000) });
    version = ((await res.json()) as { version: string }).version;
  } catch {
    console.error(`Ollama is not reachable at ${url}. Start it with \`npm run ollama:up\`, pull models with \`npm run ollama:pull\`, or set OLLAMA_URL.`);
    process.exit(1);
  }
  console.log(`Ollama ${version} at ${url}`);
  const [maj, min] = version.split('.').map(Number);
  if (maj === 0 && (min ?? 0) < 40) console.warn('warning: Laya needs Ollama 0.40 or later (Tev1: 0.35)');
  let failed = false;

  const tev = new OllamaDecisionModel({ url, model: process.env.UAS_DM_MODEL ?? 'uas-laya', price });
  for (const round of [1, 2]) {
    try {
      const d = await tev.decide({ context, question: 'Which action next?', options, multi: { max: 2 } });
      const picks = d.choices.map((c) => `${c.id} "${options.find((o) => o.id === c.id)?.label}" p=${c.p.toFixed(2)}`).join(', ');
      console.log(`decision model decide #${round}: ${picks} confidence=${d.confidence.toFixed(2)} latency=${d.usage.latencyMs}ms tokens in/out=${d.usage.inputTokens}/${d.usage.outputTokens} cost=A$${d.usage.costAud}`);
    } catch (e) {
      failed = true;
      console.error(`decision model decide failed: ${(e as Error).message}`);
    }
  }
  try {
    const s = await tev.score({ context, question: 'How good was this outcome for you? Outcome: the pad stayed dark and cold' });
    console.log(`decision model score: value=${s.value.toFixed(2)} confidence=${s.confidence.toFixed(2)} latency=${s.usage.latencyMs}ms`);
  } catch (e) {
    failed = true;
    console.error(`decision model score failed: ${(e as Error).message}`);
  }

  const llama = new LocalChatModel({ url, model: 'llama3.2:1b', price });
  try {
    const g = await llama.generate({
      context,
      instruction: 'Give a short tag (one or two words) for how you feel, and whether you should charge soon.',
      schema: z.object({ tag: z.string(), chargeSoon: z.boolean() }),
      maxOutputTokens: 60,
    });
    console.log(`llama3.2:1b generate: ${JSON.stringify(g.object)} latency=${g.usage.latencyMs}ms tokens in/out=${g.usage.inputTokens}/${g.usage.outputTokens}`);
    const d = await new LlmAsDecisionModel(llama).decide({ context, question: 'Which action next?', options });
    console.log(`llama3.2:1b as decision: ${d.choices.map((c) => c.id).join(', ')} latency=${d.usage.latencyMs}ms`);
  } catch (e) {
    failed = true;
    console.error(`llama3.2:1b failed: ${(e as Error).message}`);
  }
  if (failed) process.exit(1);
  console.log('smoke:ollama OK');
}

await main();

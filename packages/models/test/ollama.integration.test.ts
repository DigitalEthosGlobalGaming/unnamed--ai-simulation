/**
 * Optional: talks to a real Ollama. Skipped unless OLLAMA_INTEGRATION=1
 * (e.g. `OLLAMA_INTEGRATION=1 npx vitest run packages/models/test/ollama.integration.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LocalChatModel, OllamaDecisionModel, priceUsage } from '../src/index.ts';

const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const price = (id: string, t: Parameters<typeof priceUsage>[1]) => priceUsage(id, t, { inputPerMTok: 0.01, cachedInputPerMTok: 0.01, outputPerMTok: 0.02 }, 1.55);
const context = { rules: 'You are a small robot.', sheet: '', beliefs: '', shortTerm: '', state: 'battery: low', observations: 'a solarPad, 1 tile east', question: '' };

describe.skipIf(!process.env.OLLAMA_INTEGRATION)('real Ollama', () => {
  it('tev1:0.8b decides among options via /v1/systemone', async () => {
    const m = new OllamaDecisionModel({ url, model: 'tev1:0.8b', price });
    const r = await m.decide({ context, question: 'Which action next?', options: [{ id: 'a', label: 'charge the solarPad' }, { id: 'b', label: 'wait' }] });
    expect(['a', 'b']).toContain(r.choices[0]!.id);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
  }, 60_000);

  it('llama3.2:1b answers with JSON-schema format', async () => {
    const m = new LocalChatModel({ url, model: 'llama3.2:1b', price });
    const r = await m.generate({ context, instruction: 'Should you charge now?', schema: z.object({ charge: z.boolean() }) });
    expect(typeof r.object.charge).toBe('boolean');
  }, 60_000);
});

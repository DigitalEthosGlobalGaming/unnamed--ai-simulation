# Model benchmarks

Bake-offs of local models on a fixed set of prompts recorded from the garden world. They're produced by [`bakeoff.ts`](../../packages/models/scripts/bakeoff.ts).

For checking model *behaviour* in specific moments (low battery at dusk, holding the ball, a prompt-injection note…), use the situation evals instead: [`evals/`](evals/) holds their reports (`npm run eval`), and [testing-models.md](../testing-models.md) explains them. The bake-off's checks live on there as the check catalogue.

## Rerun

```sh
npm run ollama:up && npm run ollama:pull                 # capped Ollama container and models
npm run bakeoff -- record                                # optional: re-record prompts/*.json (offline, ~30 s)
npm run bakeoff -- --job decide  --models uas-laya,uas-tev1 --limit 30
npm run bakeoff -- --job plan    --models llama3.2:1b,qwen3.5:0.8b,gemma3:1b --limit 30
npm run bakeoff -- --job tags    --models llama3.2:1b,qwen3.5:0.8b,gemma3:1b --limit 30
npm run bakeoff -- --job reflect --models llama3.2:1b,qwen3.5:0.8b,gemma3:1b,qwen3.5:2b --limit 20
```

- Each run writes `<date>-<job>.md`, with the table, machine, Ollama version, model digests, CPU cap and load average. It also writes the raw samples as `<date>-<job>.json`.
- Every model is tested alone: the others are stopped with `ollama stop`, one warm-up call is discarded, then prompts run one at a time. Everything is unloaded at the end.
- Hold other CPU-heavy work while a run is going.
- `OLLAMA_THREADS` (default 4) sets `num_thread` for the text models. Keep it equal to the container's `OLLAMA_CPUS`.
- **Prompts** ([`prompts/`](prompts/)) come from 10 seeded garden worlds run offline with fake models:
  - real `decide` requests, stratified so the sanity situations occur;
  - real `reflect` requests;
  - outcome texts, used for the tags job.

  `plan` reuses the decide prompts in the gateway's plan format.
- **Reference:** decide quality is compared with the autopilot's utility ranking from the robot's beliefs and needs at that moment. It's a code heuristic, not ground truth.

## Results

| Date | Job | Result |
| --- | --- | --- |
| 2026-11-17 | [decide](2026-11-17-decide.md) | Laya is about 2× faster than Tev1 and more confident, but agrees less with the reference (10% vs 30% top 1) |
| 2026-11-17 | [tags](2026-11-17-tags.md) | llama3.2:1b is fastest (9.5 s p50) but 17% of its tags are too long; gemma3:1b is best on quality (13 s p50); qwen3.5:0.8b tags often aren't about the text |
| 2026-11-17 | [plan](2026-11-17-plan.md) | llama3.2:1b is fastest (17 s p50) and ties gemma3:1b on the automatic checks, but both only list the first three options; qwen3.5:0.8b (23 s p50) is the only one that actually plans (see the hand check) |

The **reflect** run (llama3.2:1b, qwen3.5:0.8b, gemma3:1b, qwen3.5:2b) was cancelled on 2026-11-17 before it finished, so there's no reflect report. On the samples that did run, llama3.2:1b took about 50–100 s per reflection under the 4-CPU cap. Reflection now defaults to a hosted model when `AI_GATEWAY_API_KEY` is set ([models.md](../architecture/models.md#hosted-models-vercel-ai-gateway)).

The plan checks `notJustFirstOptions` and `reasonNotLabelCopy` apply to any model the bake-off can reach, so they can be rerun against hosted models once a key is configured.

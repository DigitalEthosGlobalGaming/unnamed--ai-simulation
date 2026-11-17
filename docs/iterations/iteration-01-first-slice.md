# Iteration 1: first playable slice

Status: **Done** (17 Nov 2026).

## Outcome

What shipped, in the order it landed (details in the architecture pages and `git log`):

- Monorepo (`@uas/*`), deterministic sim with event sourcing, snapshots, replay and forks.
- The robot mind: needs, battery, mood, boredom, senses, triggers, autopilot, memory, beliefs, diary, sleep (standby).
- Models: local Ollama (Laya, Llama 3.2 1B), hosted models through the Vercel AI Gateway (hosted Laya, Llama 3.1 8B; Jev blocked on a free-tier key), a priority job queue, AUD cost meter and a daily cap.
- A blueprint viewer: whole-world plan, inspector, brain feed, beliefs, timeline replay, camera, Web Audio noises, phone layout.
- Real-time world clock aligned to local time, faster walking.
- Sign in with Vercel, live World settings.
- Visitors as airdrops (admin JSON catalogue, restricted icon language) and a mailbox (oldest-first reads, hearsay beliefs, injection-safe quoting).
- Model bake-offs and an eval suite of 16 hand-written situations with golden prompts and `npm run eval`.

## Learned

- On CPU-only hardware, local models are too slow for planning; hosted models through the gateway cost about A$0.02–0.07 a day for one robot.
- Loops are the main cost and quality risk (a pickup loop cost more than everything else combined). Feed step statuses, loop protection and saved situations now guard against them.
- The robot was boring to watch: few objects, effects that "did nothing much", no goals, no visible inner life. Iteration 2 addresses this.
- Baseline eval (17 Nov): 8 of 17 situations pass every check; Laya is deterministic; Llama plans often list options in order. See [the report](../benchmarks/evals/2026-11-17.md).

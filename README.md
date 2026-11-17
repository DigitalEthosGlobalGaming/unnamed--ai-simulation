# Unnamed AI Simulation

A self-hosted world where little AI robots live in a 2D tile world. They learn what their actions do from experience, and they pay for their thinking with their battery. The full design is in [`Unnamed AI Simulation — Spec.md`](Unnamed%20AI%20Simulation%20—%20Spec.md).

## Packages

| Package | What it does |
| --- | --- |
| `@uas/core` | IDs, hashing, the seeded PRNG (xoshiro128** with named streams), the grid, entity, effect, event and mind types, the WebSocket protocol types, and the Zod pack schemas and registry. No I/O. |
| `@uas/sim` | The deterministic tick loop, built-in verbs, A* pathfinding, the action queue, effect resolution, state hashing and snapshots, and the plugin hooks for the mind. |
| `@uas/mind` | Needs, energy, mood, boredom, senses runtime, triggers, autopilot, memory (STM and LTM), beliefs, diary, sleep (standby), hearsay from the mailbox and the prompt builder. No clocks, randomness or I/O. |
| `@uas/models` | The `DecisionModel` and `ChatModel` interfaces, the adapters (Ollama decision, local chat, LLM-as-decision, AI SDK, Jev stub and offline fakes), the YAML router, the AUD cost meter and the model host. |
| `@uas/store` | The input log, snapshots and read models, both in memory and in SQLite (Drizzle, better-sqlite3, WAL, zstd snapshots), plus `Recorder` and `replay()`. |
| `@uas/pack-basic` | The robot pack: solar pad, dock, ball, fountain and piano; sight and hearing; the `robot` archetype; the garden map. |
| `@uas/server` | Express REST, the WebSocket hub, API-key roles, one `worker_thread` per world, replay sessions, forks, `/healthz` and `/metrics`. |
| `@uas/client` | A typed REST and WebSocket client for frontends. See [`docs/viewer-integration.md`](docs/viewer-integration.md). |
| `@uas/evals` | Model evals on saved situations: frozen moments rebuilt through the current prompt builder, property checks, golden prompts, capture. See [`docs/testing-models.md`](docs/testing-models.md). |

Packages ship TypeScript source, and Node 26 runs it directly through type stripping, so there is no build step.

## Run it

```sh
npm install
npm run dev                                 # server (:8080, local Ollama models) + viewer dev server (:5173), prefixed output
npm run dev:fake                            # the same offline, with fake models (no Ollama needed)
npm start                                   # the garden world on :8080, offline fake models
UAS_BRAIN=autopilot npm start               # no models at all
UAS_ADMIN_KEYS=secret npm start             # enable admin endpoints with that key
```

- World configs live in `worlds/*.yaml`. The database file is `data/uas.db`.
- Settings are environment variables; [`.env.example`](.env.example) lists all of them.
- Stopping the server (Ctrl-C) snapshots every world. The next start resumes from that snapshot.

## Testing models

```sh
npm run check                         # includes the free golden-prompt check for every saved situation
npm run eval                          # live: each situation 3 times on hosted Laya / Llama; report in docs/benchmarks/evals/
npm run eval -- --update-prompts      # accept intended prompt changes
npm run eval:capture -- --world garden --character robot [--tick N]   # save a moment from a running server
```

See [docs/testing-models.md](docs/testing-models.md): how to find interesting moments in a world's history, write or capture situations, and read the report.

## Local models (Ollama)

```sh
npm run ollama:up      # create or start the `ollama` container (Podman, else Docker), models in volume `ollama`
npm run ollama:pull    # Laya and llama3.2:1b, plus the derived uas-laya (UAS_PULL_TEV=1 adds Tev1 as uas-tev1)
npm run smoke:ollama   # checks both models end to end; prints latency and a sample decision
npm run dev            # server + viewer with Laya deciding and llama3.2 for text jobs (dev:local is an alias)
npm run bakeoff -- --job decide --models uas-laya,uas-tev1   # compare models; results in docs/benchmarks/
```

- `ollama:up` runs Ollama with these settings, recreating the container if they differ:
  - `OLLAMA_KEEP_ALIVE=-1`: models stay loaded; reloading llama3.2 cost about 5 s.
  - `OLLAMA_MAX_LOADED_MODELS=2`: both models are resident at once.
  - `OLLAMA_NUM_PARALLEL=1`: on one CPU, parallel calls only slow each other down; the server's queue orders them instead.
  - `OLLAMA_CONTEXT_LENGTH=2048`.
  - **CPU cap:** `--cpus ${OLLAMA_CPUS:-4}` and `--cpu-shares ${OLLAMA_CPU_SHARES:-256}`, so model calls use at most about 4 of the 14 logical CPUs and yield to foreground work.
  - **Threads:** `OLLAMA_THREADS` (default 4) must match the CPU cap. Without that, llama.cpp's threads fight over the quota and calls take about twice as long.
  - The cap's latency cost on the dev laptop: Laya decide p50 5.0 → 7.0 s, llama3.2 p50 9.9 → 12.8 s. Load average with a model running drops from about 6 to about 3. Details are in [docs/operations.md](docs/operations.md#local-models-with-ollama-podman-or-docker).
- All local-model calls go through one priority queue per Ollama endpoint: decide > vocalize > plan > appraise > scoreMemory > reflect.
  - Stale jobs are dropped, and the robot uses autopilot meanwhile.
  - Timeouts count from when a call starts, and abort the request.
- `OLLAMA_URL` defaults to `http://localhost:11434`.
- **Decisions:** `uas-laya` (`laya:421m-typed-decisions-bf16`) is the default; Tev1 stays available as `UAS_DECIDER=tev`.
  - Laya is about twice as fast as Tev1 (4.7 s versus 8.4 s p50) but agrees less often with the code reference ranking. See [docs/benchmarks](docs/benchmarks/2026-11-17-decide.md).
  - Both are reached through `/v1/systemone`, which ignores request options. Thread count (and Tev1's context) are baked into the derived models.
- `llama3.2:1b` always gets a JSON-schema `format`.

## Sign in with Vercel (optional)

Create an app in the Vercel dashboard (team **Settings → Apps → Create**) with the callback `http://localhost:5173/api/auth/callback` and scopes `openid email profile`. Then set the following in `.env`:

- `VERCEL_OAUTH_CLIENT_ID` and `VERCEL_OAUTH_CLIENT_SECRET`;
- `UAS_ADMIN_VERCEL_USERS`, with your user id or username.

Other signed-in users are visitors, and API keys keep working. See [docs/operations.md](docs/operations.md#sign-in-with-vercel).

Visitors aren't characters: they airdrop items from an admin-edited catalogue (seeded with a battery snack, a squeaky toy and a heavy rock) and post short notes to the garden's mailbox, which the robot may read. Limits are world settings, unlimited by default; admins are exempt. See [docs/architecture/visitors.md](docs/architecture/visitors.md).

World settings, such as tick rate, walking speed, the A$ cap, the energy rate, hosted models on or off and visitor limits, can be changed live with `PATCH /worlds/:id/settings`.

## Hosted models (Vercel AI Gateway)

```sh
cp .env.example .env     # set AI_GATEWAY_API_KEY=... (the only key needed)
npm run smoke:gateway    # one Jev, one hosted Laya and one text call: latency and A$ cost
npm run dev              # uses hosted models when the key is set, local models otherwise
```

- **Decisions:**
  - Obvious choices are handled by autopilot with no model call.
  - Routine decisions go to hosted Laya (`convaiinnovations/laya`), and unsure ones to Jev (`typesafe-ai/jev`).
  - Local Laya takes over when there's no key, the budget is spent or the network is down. Autopilot is the last resort.
- **Plans, reflection and appraisal:** `meta/llama-3.1-8b` by default (`UAS_HOSTED_TEXT_MODEL`). `openai/gpt-6-luna` is the better option; `anthropic/claude-haiku-5.5` and `mistral/mistral-nemo` are alternatives.
- **Spend:** `UAS_DAILY_CAP_AUD` (default A$0.50 per world per day) is a hard cap that survives restarts. Prices and routing are in [docs/architecture/models.md](docs/architecture/models.md#hosted-models-vercel-ai-gateway).
- **Clock:** the garden runs in real time, at your local time of day (`UAS_TIMEZONE`). A fast scaled copy is in `examples/worlds/garden-fast.yaml`; see [docs/operations.md](docs/operations.md#world-clock).

## Docker / Podman

```sh
docker compose up
podman-compose -f docker-compose.yml -f compose.podman.yml up   # rootless Podman, see below
```

This builds the server, starts Ollama and pulls both models on first start. No cloud keys are needed.

- **Podman:** on this WSL host, rootless `podman network create` fails inside netavark, and so does `--network bridge`. `compose.podman.yml` therefore switches every service to host networking, with Ollama on `127.0.0.1:11435` so it doesn't clash with a standalone `ollama` container.
- **Startup order under podman-compose 1.5:** it doesn't wait for `service_completed_successfully`, so the server can start before the model pull finishes. Until the models are there, it falls back to the `fake` models.
- **Speed on CPU:** `tev1:0.8b` took about 6–30 s per decision on this machine. The compose file therefore appraises outcomes in code (`UAS_APPRAISE=false`) and waits 40 s for an answer (`UAS_JOB_TIMEOUT_TICKS=400`).

## Tests

```sh
npm run check      # tsc + vitest
npm test           # vitest only
```

The tests cover these milestones:

| Milestone | Test file |
| --- | --- |
| M1 | `packages/pack-basic/test/m1-scripted.test.ts` |
| M2 | `packages/store/test/m2-replay.test.ts` |
| M3 | `packages/mind/test/m3-autopilot-week.test.ts` |
| M4 | `packages/models/test/m4-gateway.test.ts` |
| M5 | `packages/models/test/m5-beliefs.test.ts` |
| M6 | `packages/models/test/m6-sleep.test.ts` |
| M7 (server side) | `packages/server/test/m7-server.test.ts` |

- Unit tests never touch the network.
- The real-Ollama test is opt-in: `OLLAMA_INTEGRATION=1 npx vitest run packages/models/test/ollama.integration.test.ts`.
- The determinism rule (no `Date.now()`, `Math.random()`, timers or I/O in `packages/sim` and `packages/mind`) is enforced by `packages/sim/test/determinism-rules.test.ts`.

## pnpm

The spec calls for pnpm workspaces. This repo uses npm workspaces because pnpm via corepack is broken on the dev machine. Switching takes one file: add a `pnpm-workspace.yaml` with `packages: ['packages/*', 'apps/*']`. Optionally change the `"@uas/*": "0.1.0"` dependency ranges to `"workspace:*"`.

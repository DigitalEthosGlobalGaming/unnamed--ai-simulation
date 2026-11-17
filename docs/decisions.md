# Decisions and deviations

## Decision log

The design decisions (1 to 41) and open questions are recorded in the spec: [Decision log and open questions](../Unnamed%20AI%20Simulation%20—%20Spec.md#decision-log-and-open-questions). This table records how far each one is built. "Partly" links to the deviation that explains the gap.

| # | Decision | Built? |
| --- | --- | --- |
| 1 | Self-hosted product; many worlds per server | Yes |
| 2 | Decision model behind a generic interface; also routes, appraises and scores memories | Partly: appraise and score yes; no `route` job ([D7](#deviations-from-the-spec)) |
| 3 | Brains run only on events | Yes |
| 4 | Tile grid | Yes |
| 5 | JSON verbs + TypeScript handlers as content packs | Yes |
| 6 | Verbs visible, effects learned through beliefs | Yes |
| 7 | At zero energy: autopilot and local model only; hard daily AUD cap | Partly: autopilot only ([D9](#deviations-from-the-spec)); cap is per world and persisted ([D17](#deviations-from-the-spec)) |
| 8 | Self-written senses in v2 | Not started (by design); `Sense` and `features` are in place |
| 9 | Generic `DecisionModel` / `ChatModel`, routing chains in config, cached-token aware | Yes |
| 10 | Drizzle, SQLite default, Postgres optional | Partly: SQLite only ([D20](#deviations-from-the-spec)) |
| 11 | Boredom per (verb, object type) with reward scaling and mood penalty | Yes |
| 12 | Needs data-defined per archetype; energy built in | Yes |
| 13 | Energy sources in-world only | Yes |
| 14 | No text speech; `vocalize`; humans join as visitor characters | Speech and noises yes; visitor characters removed by decision 39 |
| 15 | Mood as valence and arousal in code | Yes |
| 16 | Content packs: folders, hot reload, npm-publishable | Partly: folders only ([D21](#deviations-from-the-spec)) |
| 17 | `tev1:0.8b` for decisions, `llama3.2:1b` for text, via Ollama | Changed: decisions use Laya (`laya:421m-typed-decisions-bf16` as `uas-laya`) at the owner's request, with Tev1 kept as an option; text stays `llama3.2:1b` after a bake-off ([D29](#deviations-from-the-spec)) |
| 18 | Stable cached prefix; tested | Yes |
| 19 | REST + WebSocket deltas with region subscribe | Yes |
| 20 | Admin, visitor, spectator; API keys | Yes, plus Sign in with Vercel ([D33](#deviations-from-the-spec)) |
| 21 | One `worker_thread` per world | Yes |
| 22 | Docker Compose with Ollama | Yes |
| 23 | Brain feed of every decision with tier, model, cost | Yes (carry-on is not written to the feed) |
| 24 | Input log as truth + derived delta stream | Yes |
| 25 | Recorded model answers; no calls on replay | Yes |
| 26 | Forking in the v1 data model | Yes, with limits ([D15](#deviations-from-the-spec)) |
| 27 | Snapshots every N ticks and each day; thinned over time | Partly: no thinning ([D14](#deviations-from-the-spec)) |
| 28 | Every event stamped with pack versions; replay refuses missing versions | Yes |
| 29 | In-process typed bus to DB; NATS / Redis later | No bus ([D3](#deviations-from-the-spec)) |
| 30 | Minds complete in snapshots | Yes |
| 31 | Name and `@uas` scope | Yes |
| 32 | AUD with a fixed `audPerUsd` | Yes |
| 33 | No gossip | Yes |
| 34 | Noises: 4 pitches, chains up to 4, Web Audio | Yes |
| 35 | Per-character visitor queue, weighted pick favouring the oldest | Superseded by decision 39; the queue is removed |
| 36 | MIT code, CC BY 4.0 pack media | Yes (stated in `pack.json`) |
| 37 | Blueprint viewer with diegetic UI | Yes; the switch to live server data is in progress ([viewer.md](architecture/viewer.md#data-sources)) |
| 38 | Little robots as the first character | Yes |
| 39 | Visitors are not characters: they airdrop catalogue items (blocks, 24×24 icon language) and post to a per-world mailbox | Yes, backend ([visitors.md](architecture/visitors.md)) |
| 40 | Mailbox only, oldest first, one per `read`; a quoted stranger's note; hearsay beliefs | Yes ([mind.md](architecture/mind.md#beliefs)) |
| 41 | Visitor limits per world, unlimited by default, admins exempt | Yes ([server-and-api.md](architecture/server-and-api.md#live-world-settings)) |

### Decisions made while building

Choices the spec didn't make, recorded so they aren't mistaken for accidents.

| Decision | Why | Where |
| --- | --- | --- |
| npm workspaces, not pnpm | pnpm through corepack was broken on the dev machine; switching takes one file | [README.md](../README.md#pnpm) |
| No build step for the server | Node 26 strips TypeScript types; packages export `src/index.ts` | each `package.json` |
| Beliefs keyed by `@day` / `@night` | Lets the robot hold "charges by day" and "does nothing at night" as separate beliefs, which the solar-pad twist needs | [`memory.ts`](../packages/mind/src/memory.ts) |
| Outcomes appraised in code by default | CPU-only Tev1 takes seconds per call; two extra jobs per action made decisions queue and time out | [`garden.yaml`](../worlds/garden.yaml), [`docker-compose.yml`](../docker-compose.yml) |
| Model job queue with per-endpoint lanes and stale drops | Local models share one CPU; unordered concurrent calls made decisions arrive too late to matter | [`host.ts`](../packages/models/src/host.ts), [models.md](architecture/models.md#job-queue) |
| `models.load` input event | The mind needs to know the queue is busy, and replays must see the same signal | [`runtime.ts`](../packages/server/src/runtime.ts) |
| Airdrops perceived as `thing-<tags>` | The robot isn't told names or behaviours (decision 6), and beliefs about one "metal small thing" carry over to similar drops | [`catalog.ts`](../packages/core/src/catalog.ts) |
| `pack.loaded` input and pack upgrades on start | Adding the airdrop and mailbox objects changed the basic pack's hash, which would have stopped existing worlds from loading | [`runtime.ts`](../packages/server/src/runtime.ts), [events-and-replay.md](architecture/events-and-replay.md#input-events) |
| Visitor cooldowns counted in real time, in memory | They are admission control outside the sim; nothing deterministic depends on them | [`runtime.ts`](../packages/server/src/runtime.ts) |
| `uas-laya` and `uas-tev1` derived models | `/v1/systemone` ignores request options, so the thread count (and Tev1's 2k context) must be baked into a Modelfile | [`ollama-pull.sh`](../scripts/ollama-pull.sh) |
| Ollama capped to 4 CPUs with a low CPU weight, and 4 threads | Uncapped, a model call used about 7 cores and made the owner's laptop unusable. The cap costs about 40% latency. | [`ollama-up.sh`](../scripts/ollama-up.sh), [operations.md](operations.md#local-models-with-ollama-podman-or-docker) |
| Laya as the default decision model | The owner asked for it. It is twice as fast as Tev1 but agrees less with the reference ranking. | [benchmarks](benchmarks/2026-11-17-decide.md) |
| Podman host networking override | Rootless netavark fails on the WSL host | [`compose.podman.yml`](../compose.podman.yml), [operations.md](operations.md#the-podman-host-network-override) |
| Handler source not hashed in the pack content hash | Transpilers rewrite source differently per runtime; behaviour changes need a version bump | [`pack.ts`](../packages/core/src/pack.ts) |
| `GET /worlds/:id/catalog` | Lets a frontend label objects, verbs, needs and noises from the packs instead of hard-coding them | [`app.ts`](../packages/server/src/app.ts) |

## Deviations from the spec

Where the code does something different from [the spec](../Unnamed%20AI%20Simulation%20—%20Spec.md), these pages follow the code. Each row says what the spec says, what the code does, and where. When you close a gap, delete the row; when you open one, add it.

| ID | Area | Spec says | Code does | Files |
| --- | --- | --- | --- | --- |
| D1 | Workspace | pnpm workspaces | npm workspaces | [`package.json`](../package.json) |
| D2 | Package graph | `mind`, `store` depend on `core` only | `mind` depends on `sim` (implements `SimPlugin`); `store` has no runtime sim dependency; `viewer` imports `@uas/client` without declaring it | [overview.md](architecture/overview.md#package-dependencies) |
| D3 | Event bus | Typed in-process bus; subscribers are store writer, hub, feed indexer, metrics | No bus. The world worker writes inputs, snapshots and read models to SQLite directly and posts deltas to the supervisor, which forwards them to the hub | [`runtime.ts`](../packages/server/src/runtime.ts), [`hub.ts`](../packages/server/src/hub.ts) |
| D4 | Model gateway placement | Gateway in the server process | One gateway, cost meter and job queue per world worker | [`runtime.ts`](../packages/server/src/runtime.ts) |
| D5 | Tick order | Needs, senses and triggers as separate tick phases | All run inside the mind's `afterTick`, senses before needs | [`world.ts`](../packages/sim/src/world.ts), [`system.ts`](../packages/mind/src/system.ts) |
| D6 | Senses | Run only when nearby state changed; interoception is a sense; sight boosts entities with open items; hearing boosts unfamiliar patterns | Every sense runs every tick (or `runEvery`) and is diffed; interoception is built into the mind; the open-item and unfamiliar-pattern boosts are not implemented | [`system.ts`](../packages/mind/src/system.ts), [`sight.ts`](../packages/pack-basic/senses/sight.ts), [`hearing.ts`](../packages/pack-basic/senses/hearing.ts) |
| D7 | Routing | A `route` job (router) moves jobs up or down a tier per event; `embed` job on the local model | The mind chooses autopilot or a model itself; no `route` or `embed` job is dispatched; the gateway skips `embed` | [`system.ts`](../packages/mind/src/system.ts), [`gateway.ts`](../packages/models/src/gateway.ts) |
| D8 | Escalation | Low confidence escalates to the LLM | Escalates to the `plan` chain, which can be any chat model (the garden defaults to `fakeChat`) | [`gateway.ts`](../packages/models/src/gateway.ts), [`garden.yaml`](../worlds/garden.yaml) |
| D9 | Zero energy | Autopilot and the local model only | Autopilot only, latched until energy is above `energyFloor`; separately, the gateway skips paid models below `energyFloor` | [`system.ts`](../packages/mind/src/system.ts), [`gateway.ts`](../packages/models/src/gateway.ts) |
| D10 | Beliefs | Keyed `verb:objectType`; change only during sleep; unsupported for N days are replaced | Keyed `verb:objectType@day` / `@night`; updated on every admitted outcome memory (prompts only see them after waking, through the cached prefix); dropped after 5 days without support | [`memory.ts`](../packages/mind/src/memory.ts), [`system.ts`](../packages/mind/src/system.ts) |
| D11 | Memory worth and recall | `e^(−Δt/τ)`; a memory placed in a prompt counts as a recall | `0.5^(Δt/halfLife)`; STM in prompts is not counted as a recall (it would freeze STM against newcomers); recall happens on first sight of an object type; recalls within 600 ticks don't add to the count | [`memory.ts`](../packages/mind/src/memory.ts), [`system.ts`](../packages/mind/src/system.ts) |
| D12 | Sleep | Separate Consolidate, Reflect and EditSheet states; drowsy when "rest need low or night"; wake when rest restored or dawn | Three phases (`awake`, `drowsy`, `asleep`); night work runs in one tick and reflection is an async job; drowsy when night or `cool` low; wake when daylight and `cool` ≥ 0.6. Reflection can only reword existing beliefs, not change their numbers | [`system.ts`](../packages/mind/src/system.ts) |
| D13 | Visitor queue | The pick is logged as an input event | Removed with the visitor queue (decision 39) | |
| D14 | Snapshots | Retention: all from the last 24 real hours, then one per in-world day | Every snapshot is kept | [`sqlite.ts`](../packages/store/src/sqlite.ts) |
| D15 | Forks | The fork's reads before `forkTick` resolve through the parent | The fork starts from the parent's state at the fork tick with an empty log; nothing resolves through the parent. Forks are not restarted after a server restart | [`app.ts`](../packages/server/src/app.ts), [`main.ts`](../packages/server/src/main.ts) |
| D16 | Input log contents | Also logs content pack loads, config changes and external signals | Logs model answers, admin edits and pokes, settings and clock changes, airdrops, mail and `models.load`. A pack change is logged only when a world is upgraded to new pack versions on start (`pack.loaded`); there is no hot reload | [`events.ts`](../packages/core/src/events.ts) |
| D17 | Cost cap and usage | Hard AUD cap per world per day; usage in `usage_daily` | Cap per world per real UTC day (default A$0.50). Every call is upserted into `usage_daily` and today's rows are reloaded at start, so the cap survives restarts. | [`meter.ts`](../packages/models/src/meter.ts), [`runtime.ts`](../packages/server/src/runtime.ts) |
| D18 | Adapters | Jev hosted adapter; AI SDK with any provider; `LlmAsDecisionModel` uses logprobs when available | Jev is a stub that throws; only Anthropic is wired; `LlmAsDecisionModel` always reports confidence 1 | [`jev.ts`](../packages/models/src/adapters/jev.ts), [`ai-sdk.ts`](../packages/models/src/adapters/ai-sdk.ts), [`llm-as-decision.ts`](../packages/models/src/adapters/llm-as-decision.ts) |
| D19 | Determinism enforcement | A lint rule; a CI test replays recorded worlds | A vitest test scans sources for forbidden calls; the replay test runs in vitest (no CI configured in the repo) | [`determinism-rules.test.ts`](../packages/sim/test/determinism-rules.test.ts), [`m2-replay.test.ts`](../packages/store/test/m2-replay.test.ts) |
| D20 | Persistence | SQLite or Postgres via config; `api_keys` table | SQLite only; API keys come from environment variables and the `api_keys` table is unused | [`sqlite.ts`](../packages/store/src/sqlite.ts), [`auth.ts`](../packages/server/src/auth.ts) |
| D21 | Content packs | Hot reload in dev (logged as an event); npm-publishable; `GET/POST /packs` install; sounds served from packs | Packs are registered in code; no hot reload; `POST /packs` returns 501; the sounds route always returns 404 (robots have no recorded sounds) | [`catalog.ts`](../packages/server/src/catalog.ts), [`app.ts`](../packages/server/src/app.ts) |
| D22 | Space | Spatial hash for entity lookup | Linear scan in ID order (fine for a handful of entities) | [`world.ts`](../packages/sim/src/world.ts) |
| D23 | Object `portable` | Portable objects can be held, fixed ones can't | `portable` is in the schema but the sim doesn't enforce it; the ball's `pickup` handler decides | [`pack.ts`](../packages/core/src/pack.ts), [`ball.ts`](../packages/pack-basic/handlers/ball.ts) |
| D24 | Mood inputs | Needs, recent appraisals, boredom, energy, day or night | Needs, energy, a bias lowered by boredom, day or night; appraisals don't feed mood directly | [`needs.ts`](../packages/mind/src/needs.ts), [`system.ts`](../packages/mind/src/system.ts) |
| D25 | Feed and statuses | Feed tier includes `carry-on`; action statuses `queued`, `rejected`, `done`, `failed` | Carry-on is written only when the later steps of a model plan run without a new call; action deltas also use `started` and `cancelled`; `FeedEntry` has an extra `reason` (why a fallback happened). Feed steps are updated as they resolve (`done`, `failed`, `rejected`, plus `superseded` when a newer decision replaced them), with a `result` text | [`events.ts`](../packages/core/src/events.ts), [`system.ts`](../packages/mind/src/system.ts) |
| D26 | Clock | `ticksPerSecond` (default 10); in-world time from `secondsPerTick` and day length | Default `clock.mode: realtime`: 1 in-world second per real second, time of day = real local time in `clock.timezone` (server's zone by default), anchored and re-aligned by logged `clock.anchor` / `clock.jump` inputs; downtime is skipped, not simulated, and robots treat it as being switched off (no drain, a 'woke up' memory). `clock.mode: scaled` keeps the fast clock (`ticksPerRealSecond` watched / `idleTicksPerRealSecond` idle × `timeScale`) | [simulation.md](architecture/simulation.md#clock-and-pacing), [`config.ts`](../packages/server/src/config.ts) |
| D27 | Viewer design record | `apps/viewer/DESIGN.md` | `DESIGN.md` at the repository root | [`DESIGN.md`](../DESIGN.md) |
| D28 | Viewer data | Viewer uses `@uas/client` | Uses it by default now, with an offline in-browser sample world as an option; still in progress | [viewer.md](architecture/viewer.md#data-sources) |
| D29 | Decision model | `tev1:0.8b` (Jev-style decision model on Ollama) | Laya (`laya:421m-typed-decisions-bf16`, ModernBERT) by default; Tev1 available as `UAS_DECIDER=tev` | [`garden.yaml`](../worlds/garden.yaml), [models.md](architecture/models.md#local-models) |
| D30 | Model routing | Decision model, then LLM for low confidence; cloud via AI SDK providers | Obvious choices go to autopilot with no call; then hosted Laya; unsure decisions (confidence below `min(escalateBelow, 1.5 / options)`, 0.25 with 6 options) are re-asked of Jev, then the plan chain; local Laya when there's no key, budget or network; autopilot last. Hosted models go through Vercel AI Gateway with one key; Jev uses the gateway's TypeSafe-compatible API, not a direct TypeSafe key | [models.md](architecture/models.md#hosted-models-vercel-ai-gateway) |
| D31 | Plans | 1–3 queued actions per call | A plan answer may hold up to 6 steps; steps beyond the 3-action queue run later without another call, for up to an in-world hour | [`system.ts`](../packages/mind/src/system.ts) |
| D32 | Candidates | Visible affordances plus built-ins (up to ~12) | Decision models are offered only the 6 most relevant (top by utility, plus one untried). Candidates also include `go and look around`, leave out what can't work while carrying, and set aside options that failed twice in a row | [`system.ts`](../packages/mind/src/system.ts) |
| D33 | Auth | API keys in v1, OIDC later | API keys plus Sign in with Vercel (OIDC + PKCE). Admins come from `UAS_ADMIN_VERCEL_USERS`, other signed-in users are visitors; sessions are in SQLite behind a signed httpOnly cookie, with an Origin check for cookie-authenticated mutations | [server-and-api.md](architecture/server-and-api.md#sign-in-with-vercel) |
| D34 | Live settings | Clock changes via `PATCH /clock`; config otherwise static | `PATCH /worlds/:id/settings` changes tick rate, walking speed, cap, energy rate, hosted on/off, need decay and escalation live, logged as `settings.change` (+ `sim.config`) | [server-and-api.md](architecture/server-and-api.md#live-world-settings) |

Open questions from the spec that are still open, with the provisional values in use:

- `energyPerAud`: 2 (in [`garden.yaml`](../worlds/garden.yaml) and the defaults).
- Catalogue item JSON is schema 1, provisional ([visitors.md](architecture/visitors.md)).
- The mail word filter is a small local list; hearsay firmness is 0.15.
- The robot's name and silhouette, and synth tuning by ear.

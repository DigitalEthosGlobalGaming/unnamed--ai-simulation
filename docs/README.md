# Unnamed AI Simulation: architecture docs

These pages describe the system **as it is built**, not as it was planned. The plan is the design spec, [`Unnamed AI Simulation — Spec.md`](../Unnamed%20AI%20Simulation%20—%20Spec.md). Where the code differs from the spec, these pages follow the code and the difference is listed in [Decisions and deviations](decisions.md#deviations-from-the-spec).

Unnamed AI Simulation is a self-hosted TypeScript world. Small AI robots live on a 2D tile grid, learn what objects do by trying them, talk only in short chains of pitched synthesised noises, and pay for each model call out of their battery. A blueprint-styled web viewer lets the owner watch, inspect and replay a world.

## Page map

| Page | Covers | Main code |
| --- | --- | --- |
| [Architecture overview](architecture/overview.md) | System context, containers, package dependency graph, process rules | root [`package.json`](../package.json), `packages/*/package.json` |
| [Simulation](architecture/simulation.md) | Tick loop, determinism, entities, verbs and effect handlers, action queue, pathfinding, day and night | [`packages/sim`](../packages/sim), [`packages/core`](../packages/core) |
| [Mind](architecture/mind.md) | Needs, battery, mood, boredom, senses, triggers, brain tiers, memory, beliefs, hearsay, standby | [`packages/mind`](../packages/mind) |
| [Models](architecture/models.md) | `DecisionModel` and `ChatModel`, adapters, routing, AUD cost meter, energy charging, local models, job queue | [`packages/models`](../packages/models) |
| [Events and replay](architecture/events-and-replay.md) | Input log, deltas, snapshots, replay, forking, SQLite tables | [`packages/store`](../packages/store) |
| [Server and API](architecture/server-and-api.md) | REST endpoints, WebSocket protocol, roles and API keys, worker threads, persistence, health and metrics | [`packages/server`](../packages/server), [`packages/client`](../packages/client) |
| [Viewer](architecture/viewer.md) | Pixi scene and HTML controls, data sources, camera, audio, accessibility | [`apps/viewer`](../apps/viewer) |
| [Content packs](content-packs.md) | Pack layout and loading, the `basic` robot pack | [`packages/pack-basic`](../packages/pack-basic) |
| [Operations](operations.md) | Running locally, local models through Ollama, Docker and Podman Compose, environment variables | [`docker-compose.yml`](../docker-compose.yml), [`.env.example`](../.env.example) |
| [Decisions and deviations](decisions.md) | Decision log, and every known difference between the spec and the code | the spec's decision table |
| [Glossary](glossary.md) | Terms used across the code and these pages | |
| [Benchmarks](benchmarks/README.md) | Model bake-offs (decide, plan, reflect, tags) and how to rerun them | [`bakeoff.ts`](../packages/models/scripts/bakeoff.ts) |

Related documents kept outside this folder:

- [`viewer-integration.md`](viewer-integration.md): the message shapes a frontend uses (`WorldState`, `Delta`, `FeedEntry`, REST and WebSocket). Other pages link to it rather than repeat it.
- [`PRODUCT.md`](../PRODUCT.md): who the product is for and its principles.
- [`DESIGN.md`](../DESIGN.md): the viewer's design system.
- [`README.md`](../README.md): quick start and test milestones.

## Keeping these docs live

The rule: **if you change behaviour, update the matching page in the same change.**

- Each page covers one component and lists the code it describes, so you can find the page that owns a file. If you touch `packages/models`, update [models.md](architecture/models.md). If you add an endpoint, update [server-and-api.md](architecture/server-and-api.md), and [viewer-integration.md](viewer-integration.md) if a frontend sees the change.
- If you make the code differ from the spec, or close an existing difference, update the [deviations table](decisions.md#deviations-from-the-spec).
- Something half-built gets an **In progress** note that says what exists now. Remove the note when the work lands. Don't describe the intended result as if it were built.
- Link to code with relative paths (for example `../../packages/sim/src/world.ts` from `docs/architecture/`). When you move or rename a file, search `docs/` for the old path.
- Diagrams are mermaid (`flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram`). Quote labels that contain punctuation, and don't use HTML tags in labels. To check them, extract each block to a `.mmd` file and run `npx -y @mermaid-js/mermaid-cli -i file.mmd -o file.svg`.
- Never put API keys, secrets or personal data in these pages.

### Current in-progress work

| Area | State | Page |
| --- | --- | --- |
